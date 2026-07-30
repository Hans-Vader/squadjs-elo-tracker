/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                  CLAN TAG GROUPING UTILITY                    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Single source of truth for clan-tag detection, normalization, and
 * (optional) edit-distance grouping across the EloTracker plugin and
 * its CLI tools. Mirrors the enhanced logic in the squadjs-team-balancer
 * project (utils/tb-clan-grouping.js) so a tag like `[♣ΛCE]` and its
 * homoglyph variant `[♣ΛC€]` collapse into the same group.
 *
 * Pure logic — no external dependencies.
 *
 * EXPORTS
 * -------
 *   extractRawPrefix(name) -> string | null
 *     Five-strategy detector that returns the raw clan-tag prefix
 *     captured from a player's name (without surrounding brackets when
 *     possible), or null if no tag boundary is visible.
 *
 *   normalizeTag(raw) -> string | null
 *     NFD + diacritic strip, "gamer-character" lookalike map (λ→a,
 *     €→e, я→r, etc.), strip non-alphanumerics, uppercase. Returns
 *     null if nothing alphanumeric survives.
 *
 *   levenshteinDistance(a, b) -> number
 *     Standard Levenshtein with O(min(m,n)) memory. Used by
 *     extractClanGroups for edit-distance merging.
 *
 *   extractClanGroups(rawPlayers, options) -> { tag: [eosID, ...] }
 *     Bucket players by extracted tag, optionally normalize for
 *     case-insensitive merging, optionally merge buckets within a
 *     Levenshtein edit distance, and filter by min/max group size.
 *
 *     options = {
 *       minSize: number          // default 2
 *       maxSize: number          // default 18
 *       maxEditDistance: number  // default 1; 0 = exact match only
 *       caseSensitive: boolean   // default true; when false, the
 *                                // captured prefix is normalized via
 *                                // NFD + the gamer-character map +
 *                                // non-alphanumeric strip + uppercase.
 *       requireExplicit: boolean // default false; when true, buckets
 *                                // whose members were ALL detected via
 *                                // bare prefixes (strategies 4/5 sans
 *                                // bracket) are dropped — at least one
 *                                // member must carry an explicit tag
 *                                // boundary (strategies 1-3 or a
 *                                // leading open bracket).
 *     }
 *
 *   computePartySizes(players, options) -> Map<eosID, {partySize, clanTag}>
 *     Team-bound wrapper around extractClanGroups: groups same-tag
 *     players who share a teamID into a "party", one entry per
 *     eosID. Solo/no-tag players get {partySize:1, clanTag:null}.
 *     Always passes requireExplicit: true — bare-prefix detections
 *     (`KM Lookout`) only join a party when a teammate carries the
 *     same tag with an explicit boundary (`[KM] Warlord`), so ordinary
 *     two-word names (`The Rock` + `The Bull`) never form parties.
 *
 *     options = {
 *       caseSensitive: boolean    // default false
 *       maxEditDistance: number   // default 1
 *       ignoredTags: string[]     // default []; matching tags -> public
 *     }
 *
 * DETECTION STRATEGIES (priority order)
 * -------------------------------------
 *   1. Tag wrapped in a matched or mismatched bracket pair, including
 *      a wide variety of Unicode bracket-like glyphs. Captures the
 *      INSIDE of the pair so `[7-CAV]` groups as `7-CAV`.
 *      `[TAG]`, `(TAG)`, `<TAG>`, `{TAG}`, `【TAG】`, `╔TAG╗`, `{TAG)`
 *   2. Tag followed by an explicit separator + space:
 *      `TAG | Name`, `TAG // Name`, `TAG - Name`, `TAG : Name`,
 *      `TAG † Name`, `TAG ™ Name`, `TAG ✯ Name`, `TAG ~ Name`,
 *      `TAG * Name`
 *   3. Tag separated from name by 2+ spaces: `TAG  PlayerName`
 *   4. Short ASCII ALL-CAPS tag with a single-space terminator and an
 *      uppercase continuation: `KM Lookout`, `7TH Captain`
 *   5. Bare-prefix fallback — 2–7 non-bracket non-whitespace chars
 *      followed by whitespace + a non-empty token. Catches Unicode
 *      and mixed-case bare prefixes that strategies 1–4 don't pick
 *      up: `KΛZ Korven`, `♣ΛCE Wurstwasser`, `RmdV Habicht`,
 *      `[OPN Player` (open-only bracket).
 */

const NON_ASCII_MAP = {
  'ƒ': 'f', 'И': 'n', '丹': 'a', '匚': 'c', 'н': 'h', '尺': 'r', 'λ': 'a', 'ν': 'v', 'є': 'e',
  '†': 't', 'Ð': 'd', 'ø': 'o', 'ß': 'ss', 'ค': 'a', 'г': 'r', 'ς': 'c', 'ɦ': 'h', 'м': 'm',
  'я': 'r', 'ċ': 'c', '€': 'e', '₥': 'm', '₠': 'e', '₮': 't', '₯': 'd', '₨': 'rs', '₩': 'w',
  '₫': 'd', '₭': 'k', '₰': 'p', 'ℜ': 'r', 'ℭ': 'c', 'ℑ': 'i', 'ℒ': 'l', 'ℓ': 'l', '℔': 'lb',
  'ℕ': 'n', '℗': 'p', '℘': 'p', 'ℙ': 'p', 'ℚ': 'q', 'ℛ': 'r', 'ℝ': 'r', '℞': 'rx', '℟': 'r',
  '℠': 'sm', '℡': 'tel', '™': 'tm', '℣': 'v', 'ℤ': 'z', 'Ω': 'ohm', '∂': 'd', '₦': 'n', '₧': 'pts',
  '₹': 'r', '₸': 't', '₿': 'b'
};

/**
 * Internal detector: returns { raw, explicit } or null. `explicit` is true
 * when the name carries a visible tag boundary (strategies 1–3, or a
 * leading open bracket in strategy 5) — i.e. the prefix cannot be an
 * ordinary two-word name. Strategies 4/5 without a bracket are `explicit:
 * false`: `KM Lookout` and `The Rock` are syntactically identical, so
 * such prefixes only count as clan tags when corroborated (see
 * extractClanGroups' requireExplicit option).
 */
function detectPrefix(name) {
  if (!name) return null;

  // 1. Bracketed prefix; tolerates mismatched and exotic Unicode pairs.
  //    Captures the INSIDE of the bracket pair so `[7-CAV]` groups as
  //    `7-CAV` even when caseSensitive: true skips normalization. `>` is
  //    in the closing class so `<TAG>` works too.
  const bracketRegex = /^\s*[\[\(【「『《╔├↾╬✦⟦╟|=<\{~\*](.+?)[\]\)】」』》╗┤↿╬✦⟧╢|=<>~\*\}]/;
  let match = name.match(bracketRegex);
  if (match) return { raw: match[1].trim(), explicit: true };

  // 2. Explicit separator: TAG // Name, TAG | Name, TAG - Name, etc.
  const sepRegex = /^\s*(.{1,10}?)\s*(?:\/\/|\||-|:|\:\(|\:\)|†|†|™|✯|~|\*)\s+/;
  match = name.match(sepRegex);
  if (match) return { raw: match[1].trim(), explicit: true };

  // 3. 2+ space separator (catches bare-prefix tags with a wide gap).
  const spaceRegex = /^\s*(.{1,10}?)\s{2,}/;
  match = name.match(spaceRegex);
  if (match) return { raw: match[1].trim(), explicit: true };

  // 4. Short ALL-CAPS tag + single space + uppercase continuation
  //    (catches `KM Lookout`-style names — ASCII only). No visible
  //    boundary marker ⇒ never explicit.
  const shortTagRegex = /^\s*([A-Z0-9]{2,4})\s+[A-Z]/;
  match = name.match(shortTagRegex);
  if (match) return { raw: match[1].trim(), explicit: false };

  // 5. Bare-prefix fallback: 2–7 non-bracket non-whitespace chars
  //    followed by whitespace and a non-empty token. Catches Unicode
  //    bare prefixes (`KΛZ Korven`, `♣ΛCE Wurstwasser`), mixed-case
  //    bare prefixes (`RmdV Habicht`), and open-only brackets
  //    (`[OPN Player`). The trailing \S guard prevents matching names
  //    with no visible boundary (`ABCJohnSmith`). A leading open
  //    bracket is a visible marker ⇒ explicit; otherwise bare.
  const bareRegex = /^[\[<({]?([^\s\[\](){}<>]{2,7})\s+\S/u;
  match = name.match(bareRegex);
  if (match) return { raw: match[1].trim(), explicit: /^\s*[\[<({]/.test(name) };

  return null;
}

export function extractRawPrefix(name) {
  return detectPrefix(name)?.raw ?? null;
}

export function normalizeTag(raw) {
  if (!raw) return null;

  // NFD-decompose then strip combining marks (Café → Cafe).
  let norm = raw.normalize('NFD').replace(/[̀-ͯ]/g, '');

  // Map "gamer character" lookalikes to their ASCII equivalents.
  for (const [key, val] of Object.entries(NON_ASCII_MAP)) {
    norm = norm.replace(new RegExp(key, 'gi'), val);
  }

  // Strip non-alphanumerics and uppercase.
  norm = norm.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return norm || null;
}

export function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  if (a.length > b.length) [a, b] = [b, a];

  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => i);

  for (let j = 1; j <= n; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= m; i++) {
      const tmp = dp[i];
      dp[i] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[i], dp[i - 1]);
      prev = tmp;
    }
  }
  return dp[m];
}

export function extractClanGroups(rawPlayers, options = {}) {
  const minSize = options.minSize ?? 2;
  const maxSize = options.maxSize ?? 18;
  const maxEditDistance = options.maxEditDistance ?? 1;
  const caseSensitive = options.caseSensitive ?? true;
  const requireExplicit = options.requireExplicit ?? false;

  const groups = {};
  const explicitKeys = new Set();
  for (const player of rawPlayers || []) {
    if (!player?.name || !player?.eosID) continue;
    const det = detectPrefix(player.name);
    if (!det) continue;
    const key = caseSensitive ? det.raw : normalizeTag(det.raw);
    if (!key) continue;
    if (!groups[key]) groups[key] = new Set();
    groups[key].add(player.eosID);
    if (det.explicit) explicitKeys.add(key);
  }

  for (const tag of Object.keys(groups)) {
    groups[tag] = [...groups[tag]];
  }

  if (maxEditDistance > 0) {
    let merged = true;
    while (merged) {
      merged = false;
      const tags = Object.keys(groups);
      for (let i = 0; i < tags.length && !merged; i++) {
        for (let j = i + 1; j < tags.length && !merged; j++) {
          if (levenshteinDistance(tags[i], tags[j]) <= maxEditDistance) {
            const [keep, absorb] = groups[tags[i]].length >= groups[tags[j]].length
              ? [tags[i], tags[j]]
              : [tags[j], tags[i]];
            const seen = new Set(groups[keep]);
            for (const id of groups[absorb]) {
              if (!seen.has(id)) {
                groups[keep].push(id);
                seen.add(id);
              }
            }
            if (explicitKeys.has(absorb)) explicitKeys.add(keep);
            delete groups[absorb];
            merged = true;
          }
        }
      }
    }
  }

  for (const tag of Object.keys(groups)) {
    if (groups[tag].length < minSize || groups[tag].length > maxSize) {
      delete groups[tag];
    } else if (requireExplicit && !explicitKeys.has(tag)) {
      // Bucket built solely from bare prefixes (strategies 4/5 without a
      // bracket): indistinguishable from ordinary two-word names, so it
      // needs at least one explicitly-marked member to count as a clan.
      delete groups[tag];
    }
  }

  return groups;
}

/**
 * Party size + clan tag per player, team-bound. Intended as the single
 * source of truth for the party (eq. 7) factor — wired into the plugin and
 * the replay tools (elo-rebuild.js, elo-calibrate.js) in later tasks.
 *
 * @param {Array<{eosID, name, teamID}>} players  all round participants
 * @param {Object} [options]
 *   caseSensitive   {boolean}  default false — passed to extractClanGroups
 *   maxEditDistance {number}   default 0     — exact match only. Homoglyph/
 *                              case variants already merge via normalizeTag;
 *                              raising this can fuse DIFFERENT clans
 *                              ([KSK]+[KSC]) into one phantom party.
 *   ignoredTags     {string[]} default []    — treated as public (no clan)
 * @returns {Map<string, {partySize:number, clanTag:string|null}>}
 */
export function computePartySizes(players, options = {}) {
  const caseSensitive   = options.caseSensitive ?? false;
  const maxEditDistance = options.maxEditDistance ?? 0;
  const ignore = new Set((options.ignoredTags ?? []).map(normalizeTag).filter(Boolean));

  const result = new Map();
  const byTeam = new Map();
  for (const p of players || []) {
    if (!p?.eosID) continue;
    result.set(p.eosID, { partySize: 1, clanTag: null }); // default solo
    if (!p.name) continue;
    if (p.teamID == null) continue; // unresolved team ⇒ never bucket/merge, stay solo
    const t = p.teamID;
    if (!byTeam.has(t)) byTeam.set(t, []);
    byTeam.get(t).push(p);
  }

  for (const teamPlayers of byTeam.values()) {
    // requireExplicit: rating-relevant path — a bare-prefix pair like
    // `The Rock` + `The Bull` must never form a phantom party. A missed
    // party is the neutral default (solo); a phantom party pollutes the
    // match log permanently.
    const groups = extractClanGroups(teamPlayers, {
      minSize: 2, caseSensitive, maxEditDistance, maxSize: Infinity,
      requireExplicit: true
    });
    for (const [tag, members] of Object.entries(groups)) {
      if (ignore.has(normalizeTag(tag))) continue; // ignored ⇒ leave members public
      for (const eosID of members) {
        result.set(eosID, { partySize: members.length, clanTag: tag });
      }
    }
  }
  return result;
}
