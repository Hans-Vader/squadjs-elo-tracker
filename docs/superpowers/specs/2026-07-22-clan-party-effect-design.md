# Design: Clan-Tag-Party-Effekt statt In-Game-Squad

- **Datum:** 2026-07-22
- **Branch:** trueskill2
- **Status:** Entwurf → Review
- **Betrifft:** TrueSkill2 „squad offset"-Faktor (Paper eq. 7)

## 1. Problem & Motivation

Der bestehende Squad-Faktor (eq. 7) bemisst den „Party-Effekt" über die
**In-Game-Squad-Zugehörigkeit**. In *Squad* (Offworld Industries) ist aber
praktisch jeder Spieler in einem Squad, und Squad-Mitgliedschaft sagt nichts
darüber aus, ob koordiniert/kommuniziert wird. Das Signal ist damit wertlos.

Ein aussagekräftigeres Proxy für „koordinierte Gruppe" ist das **Clan-Tag** im
Spielernamen: Spieler mit demselben Tag im selben Team kommunizieren
wahrscheinlicher gut und sind dadurch effektiver. Für Clan-Tag-Erkennung
existiert bereits robuste Logik (`utils/elo-clan-grouping.js`,
`extractClanGroups`).

## 2. Ziel & Nicht-Ziele

**Ziel:** Der eq.-7-Faktor wird von der **Clan-Party-Größe** gefüttert statt von
der In-Game-Squad-Größe. Die Engine-Mathematik bleibt unverändert.

**Nicht-Ziele:**
- Keine Änderung an der eq.-7-Mathematik (Team-Mean-Shift, `perPlayerShifts`).
- Keine Änderung an Kill/Death/Quit/Experience-Faktoren.
- Kein neues NPM-Dependency; `extractClanGroups` wird wiederverwendet.

## 3. Entschiedene Design-Weichen

| Weiche | Entscheidung |
|---|---|
| Benennung/Kompatibilität | **Saubere Umbenennung** `squad* → party*`. Additive DB-Migration, alte Spalten bleiben physisch (kein destruktiver Drop). |
| Party-Definition | Gleiches Clan-Tag **UND** gleiches Team, **ab 2 Spielern**. Solo / kein Tag / Singleton = neutral (`partySize 1`). |
| Tag-Erkennung | Robust: `maxEditDistance: 1` (Levenshtein-Merge). `caseSensitive` wird **konfigurierbar** (siehe §5), Default `false`. |
| Kalibrierung | **Rückwirkend aus Namen.** Eine gemeinsame Grouping-Funktion für Live + Replay; bestehendes Match-Log kalibriert den Party-Effekt sofort. |
| Ineligible Teammates | Zählen zur Party-Größe mit (spiegelt bisherige Squad-Logik: „waren real dabei"). |

## 4. Architektur — geteilte Funktion

Neu in `utils/elo-clan-grouping.js` (Single Source of Truth, genutzt von Plugin
**und** beiden Replay-Tools):

```js
/**
 * Party-Größe + Clan-Tag je Spieler, team-gebunden.
 * @param {Array<{eosID, name, teamID}>} players  alle Runden-Teilnehmer
 * @param {Object} [options]
 *   caseSensitive {boolean} default false — an extractClanGroups durchgereicht
 *   ignoredTags   {string[]} default []   — als Public zu wertende Tags
 * @returns {Map<string, { partySize:number, clanTag:string|null }>}
 */
export function computePartySizes(players, options = {}) { ... }
```

**Verhalten:**
1. `ignore = new Set((options.ignoredTags || []).map(normalizeTag).filter(Boolean))`.
2. Spieler nach `teamID` aufteilen.
3. Pro Team `extractClanGroups(teamPlayers, { minSize: 2, caseSensitive, maxEditDistance: 1, maxSize: Infinity })`.
4. Für jede zurückgegebene Gruppe: wenn `ignore.has(normalizeTag(groupKey))` → **überspringen** (Mitglieder bleiben Public).
5. Jedes verbleibende Gruppenmitglied → `{ partySize: group.length, clanTag: groupKey }`.
6. Alle anderen (kein Tag, Singleton, ignoriert) → `{ partySize: 1, clanTag: null }`.

**Begründung der Detail-Entscheidungen:**
- `maxSize: Infinity` (statt Default 18), weil `extractClanGroups` zu große
  Gruppen sonst **verwirft** — große Stacks sollen nicht gedroppt, sondern über
  den Offset-Index geclamped werden (siehe §7).
- Ignore-Abgleich **immer normalisiert** (unabhängig von `caseSensitive`), damit
  `["TR"]` auch `[TR]`, `tr`, `Tr` fängt — verzeihend für Operatoren.
- Der Ignore-Filter lebt in `computePartySizes`, **nicht** in
  `extractClanGroups` — letztere bleibt generisch und spiegelt weiter die
  team-balancer-Variante.

## 5. Konfigurationsoptionen

Neue **Plugin-Optionen** (top-level, wie `enableQuitPenalty` etc. — Clan-Erkennung
ist eine Beobachtungs-, keine Inferenz-Einstellung, gehört daher **nicht** in den
`trueskill2`-Parameterblock):

| Option | Typ | Default | Bedeutung |
|---|---|---|---|
| `partyCaseSensitive` | boolean | `false` | An `extractClanGroups` durchgereicht. `false` = normalisiertes Matching (Groß/Klein/Homoglyphen egal). |
| `partyIgnoredTags` | string[] | `[]` | Tags, die als Public gewertet werden (keine echten Clans). Abgleich normalisiert. |

Neuer **Engine-Parameter** (`trueskill2`-Block, ersetzt `squadOffsets`):

| Parameter | Default | Bedeutung |
|---|---|---|
| `partyOffsets` | `[0.0 × 10]` | Party-Größen-Offset (eq. 7). Index = `partySize − 1`; Index 0 gepinnt auf 0. Neutral = kein Effekt. |

**CLI-Tools** (`elo-rebuild.js`, `elo-calibrate.js`) erhalten passende Flags, damit
Replay die Live-Einstellungen spiegeln kann:
- `--party-case-sensitive` (Flag, Default aus)
- `--ignore-tags=TAG1,TAG2` (Default leer)

Dokumentiert mit dem Hinweis: **müssen der Live-Plugin-Config entsprechen**, sonst
weicht das Replay von der Live-Wertung ab.

## 6. Betroffene Dateien

| Datei | Änderung |
|---|---|
| `utils/elo-clan-grouping.js` | `computePartySizes()` ergänzen (nutzt `extractClanGroups` + `normalizeTag`). |
| `utils/elo-parameters.js` | `squadOffsets → partyOffsets` (Länge 10, Index 0 gepinnt). `loadParameters`-Pin & Array-Merge anpassen. Kommentare eq.7 → „party (clan-tag)". |
| `utils/elo-trueskill2-engine.js` | `squadShifts → partyShifts`, liest `meta.partySize`, indexiert `parameters.partyOffsets`. JSDoc (`perPlayerMeta`-Shape). |
| `plugins/elo-tracker.js` | Neue Optionen `partyCaseSensitive`, `partyIgnoredTags`. `_buildPerPlayerMeta`: In-Game-Squad-Zählung raus, `computePartySizes(participants, {...})` rein. Meta + Log-Record + DB-Rows: `squadID/squadSize → clanTag/partySize`. |
| `utils/elo-database.js` | Additive Migration: Spalten `partySize` (INTEGER, null), `clanTag` (STRING, null) im Modell **und** `_ensureTrueSkill2Columns`. Alte `squadID/squadSize` bleiben (kein Drop), werden nicht mehr geschrieben. |
| `tools/elo-rebuild.js` | `perPlayerMeta` aus `computePartySizes(match.players, opts)` statt geloggtem `squadSize`. Optionen aus neuen CLI-Flags. |
| `tools/elo-calibrate.js` | `winProbability` party-aware (`partyShiftOf` / `partyOffsets`). Party-Größen **einmal beim Laden** je Match cachen (Sweep-Perf). `hasSquad → hasParty`. Stage-2: `s4s`/Var → `partyOffsets`, Label „4-stack party boost", Ausgabeblock. CLI-Flags. |
| `docs/rating-engine-guide.md`, `docs/trueskill2-explained.md`, `docs/trueskill2-erklaerung.md`, `README.md` | „Squad factor" → „Party factor (clan-tag)". Config-Tabellen (`partyOffsets`, `partyCaseSensitive`, `partyIgnoredTags`). Calibrate-Wording. |

## 7. Datenfluss

```
participants (name + assignedTeamID)
   └─ computePartySizes(_, {caseSensitive, ignoredTags})
        └─ perPlayerMeta[eosID].partySize / .clanTag
             └─ partyShifts(team)  →  partyOffsets[min(partySize-1, 9)]
                  └─ teamMeta.perPlayerShifts  (generische Schnittstelle, unverändert)
                       └─ teamFactorMessages → Team-Mean-Shift (eq. 7)
```

- `partySize > 10` clamped auf `partyOffsets[9]` (`// ponytail: Ceiling 10; Array
  verlängern, falls große Stacks relevant werden`).
- `clanTag/partySize` werden zusätzlich ins Log/DB geschrieben — nur für
  Transparenz/Audit; für die Wertung berechnet das Replay ohnehin neu (§3).

## 8. DB-Migration & Abwärtskompatibilität

- Additiv, kein Datenverlust. `_ensureTrueSkill2Columns` fügt `partySize`,
  `clanTag` hinzu, falls fehlend; no-op sonst (SQLite/MySQL/Postgres).
- Alte `squadID/squadSize`-Spalten bleiben physisch bestehen (nullable), werden
  aber nicht mehr beschrieben.
- Alte Log-Zeilen enthalten `name` + `teamID` → Tools gruppieren sie beim Replay
  neu; kein Warten auf frische Daten.

## 9. Kanten & Risiken

- **Edit-Distance-Merge** (`maxEditDistance: 1`) kann selten zwei ähnliche echte
  Tags fusionieren. Bewusst akzeptiert (robuste Erkennung war die Wahl). Bleibt
  fix auf 1; könnte später als Option exponiert werden.
- **Neutralität:** `partyOffsets` default alle 0 → Engine = klassisches TrueSkill.
  Golden-Tests müssen grün bleiben.
- **Konsistenz Live ↔ Replay:** hängt daran, dass CLI-Flags die Plugin-Config
  spiegeln — in den Tool-Docs deutlich machen.

## 10. Tests

- **Neu** `testing/test-elo-clan-party.js` — `computePartySizes`:
  - Gleiches Tag / verschiedene Teams → getrennte Parties.
  - `minSize 2`: einzelnes Tag-Mitglied → `partySize 1`.
  - Normalisierung + Levenshtein-Merge (`[♣ΛCE]` == `[♣ΛC€]`).
  - Kein Tag → `partySize 1`, `clanTag null`.
  - Ineligible Teammate zählt zur Größe mit.
  - `caseSensitive: true` trennt `TR`/`tr`; Default `false` merged.
  - `ignoredTags: ["TR"]` → alle TR-Varianten werden Public (`partySize 1`).
- **Update** Golden-Tests (`test-elo-trueskill2-engine.js`,
  `test-elo-trueskill2-factors.js`, `test-elo-parameters.js`): `squadOffsets →
  partyOffsets`, `squadSize → partySize`; Neutral-Default reproduziert klassisches
  TrueSkill exakt.
- **Smoke** Rebuild/Calibrate: Lauf mit recompute + Flags terminiert ohne Fehler.

## 11. Umsetzungsreihenfolge

1. **Teil A** — Party-Effekt inkl. `partyCaseSensitive`:
   `computePartySizes` → parameters/engine Rename → plugin/log/DB → tools → docs →
   Tests grün.
2. **Teil B** — `partyIgnoredTags` (Folgeschritt): Ignore-Filter in
   `computePartySizes`, Plugin-Option, CLI-Flag `--ignore-tags`, Tests, Doc-Zeile.

Beide teilen `computePartySizes(players, options)`; die Signatur wird in Teil A so
angelegt, dass Teil B nur den Ignore-Zweig ergänzt.
