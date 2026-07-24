/**
 * test-clan-grouping.js
 *
 * Unit tests for utils/elo-clan-grouping.js — the unified clan-tag
 * detection + normalization + grouping module shared by elo-discord.js,
 * tools/elo-inspect.js, and tools/elo-clans-audit.js.
 *
 * Pinned cases include the user's reported homoglyph example
 * ([♣ΛCE] vs [♣ΛC€]) which must collapse to a single group.
 */

import {
  extractRawPrefix,
  normalizeTag,
  levenshteinDistance,
  extractClanGroups,
  computePartySizes
} from '../utils/elo-clan-grouping.js';

export default async function runClanGroupingTests(runTest) {

  // ─── normalizeTag — homoglyph collapse ────────────────────────────

  await runTest('normalizeTag: [♣ΛCE] and [♣ΛC€] collapse to ACE', async () => {
    const a = normalizeTag(extractRawPrefix('[♣ΛCE] Wurstwasser'));
    const b = normalizeTag(extractRawPrefix('[♣ΛC€] TestPlayer'));
    if (a !== 'ACE') throw new Error(`Expected ACE, got ${a}`);
    if (b !== 'ACE') throw new Error(`Expected ACE, got ${b}`);
    if (a !== b) throw new Error(`Variants did not collapse: ${a} vs ${b}`);
  });

  await runTest('normalizeTag: lowercase/uppercase Λ/λ both map to A', async () => {
    const upper = normalizeTag(extractRawPrefix('[♣ΛCE]Foo'));
    const lower = normalizeTag(extractRawPrefix('[♣λCE]Bar'));
    if (upper !== lower) throw new Error(`Λ/λ split: ${upper} vs ${lower}`);
    if (upper !== 'ACE') throw new Error(`Expected ACE, got ${upper}`);
  });

  await runTest('normalizeTag: € maps to e (was missing in old elo-tracker map)', async () => {
    const result = normalizeTag('CAF€');
    if (result !== 'CAFE') throw new Error(`Expected CAFE, got ${result}`);
  });

  await runTest('normalizeTag: ™ maps to tm', async () => {
    const result = normalizeTag('PRO™');
    if (result !== 'PROTM') throw new Error(`Expected PROTM, got ${result}`);
  });

  await runTest('normalizeTag: NFD strips diacritics (Café → CAFE)', async () => {
    const result = normalizeTag('Café');
    if (result !== 'CAFE') throw new Error(`Expected CAFE, got ${result}`);
  });

  await runTest('normalizeTag: empty / non-alphanumeric input returns null', async () => {
    if (normalizeTag('') !== null) throw new Error('Expected null for empty');
    if (normalizeTag(null) !== null) throw new Error('Expected null for null');
    if (normalizeTag('♣♦♠♥') !== null) throw new Error('Expected null for all-symbol input');
  });

  // ─── extractRawPrefix — strategy coverage ─────────────────────────

  await runTest('extractRawPrefix S1: bracket captures inside, not the brackets', async () => {
    if (extractRawPrefix('[ACE]Foo') !== 'ACE') throw new Error('Square brackets failed');
    if (extractRawPrefix('(ACE)Foo') !== 'ACE') throw new Error('Round brackets failed');
    if (extractRawPrefix('<ACE>Foo') !== 'ACE') throw new Error('Angle brackets failed');
    if (extractRawPrefix('{ACE}Foo') !== 'ACE') throw new Error('Curly brackets failed');
    if (extractRawPrefix('【ACE】Foo') !== 'ACE') throw new Error('CJK brackets failed');
  });

  await runTest('extractRawPrefix S1: tolerates mismatched bracket pairs', async () => {
    if (extractRawPrefix('{ACE)Foo') !== 'ACE') throw new Error('{ACE) mismatched failed');
    if (extractRawPrefix('[ACE}Foo') !== 'ACE') throw new Error('[ACE} mismatched failed');
  });

  await runTest('extractRawPrefix S2: explicit separator (| // - : † ™ ✯ ~ *)', async () => {
    if (extractRawPrefix('TAG | Name') !== 'TAG') throw new Error('| failed');
    if (extractRawPrefix('TAG // Name') !== 'TAG') throw new Error('// failed');
    if (extractRawPrefix('TAG - Name') !== 'TAG') throw new Error('- failed');
    if (extractRawPrefix('TAG : Name') !== 'TAG') throw new Error(': failed');
    if (extractRawPrefix('TAG † Name') !== 'TAG') throw new Error('† failed');
    if (extractRawPrefix('TAG ™ Name') !== 'TAG') throw new Error('™ failed');
    if (extractRawPrefix('TAG ~ Name') !== 'TAG') throw new Error('~ failed');
    if (extractRawPrefix('TAG * Name') !== 'TAG') throw new Error('* failed');
  });

  await runTest('extractRawPrefix S3: 2+ space separator', async () => {
    const got = extractRawPrefix('TAG  PlayerName');
    if (got !== 'TAG') throw new Error(`Expected 'TAG', got ${JSON.stringify(got)}`);
  });

  await runTest('extractRawPrefix S4: short ASCII ALL-CAPS + single space + uppercase', async () => {
    if (extractRawPrefix('KM Lookout') !== 'KM') throw new Error('KM Lookout failed');
    if (extractRawPrefix('7TH Captain') !== '7TH') throw new Error('7TH Captain failed');
  });

  await runTest('extractRawPrefix S5: bare-prefix fallback for Unicode/mixed-case prefixes', async () => {
    // S4 doesn't match (Λ is not ASCII), so S5 catches it
    if (extractRawPrefix('KΛZ Korven') !== 'KΛZ') throw new Error('KΛZ Korven failed');
    if (extractRawPrefix('♣ΛCE Wurstwasser') !== '♣ΛCE') throw new Error('♣ΛCE Wurstwasser failed');
    if (extractRawPrefix('RmdV Habicht') !== 'RmdV') throw new Error('RmdV Habicht failed');
  });

  await runTest('extractRawPrefix: returns null when no boundary visible', async () => {
    if (extractRawPrefix('JustOneName') !== null) throw new Error('Should reject single-word name');
    if (extractRawPrefix('ABCJohnSmith') !== null) throw new Error('Should reject no-boundary CamelCase');
    if (extractRawPrefix(null) !== null) throw new Error('Should handle null');
  });

  // ─── levenshteinDistance ──────────────────────────────────────────

  await runTest('levenshteinDistance: identical strings → 0', async () => {
    if (levenshteinDistance('ACE', 'ACE') !== 0) throw new Error('Same string ≠ 0');
  });

  await runTest('levenshteinDistance: single edit → 1', async () => {
    if (levenshteinDistance('ACE', 'ACES') !== 1) throw new Error('Insertion ≠ 1');
    if (levenshteinDistance('ACE', 'AC') !== 1) throw new Error('Deletion ≠ 1');
    if (levenshteinDistance('ACE', 'AXE') !== 1) throw new Error('Substitution ≠ 1');
  });

  await runTest('levenshteinDistance: empty handling', async () => {
    if (levenshteinDistance('', 'ACE') !== 3) throw new Error('Empty vs ACE ≠ 3');
    if (levenshteinDistance('ACE', '') !== 3) throw new Error('ACE vs empty ≠ 3');
    if (levenshteinDistance('', '') !== 0) throw new Error('Empty vs empty ≠ 0');
  });

  // ─── extractClanGroups ────────────────────────────────────────────

  await runTest('extractClanGroups: user homoglyph case collapses to one group', async () => {
    const players = [
      { eosID: 'e1', name: '[♣ΛCE] Wurstwasser' },
      { eosID: 'e2', name: '[♣ΛC€] TestPlayer' },
      { eosID: 'e3', name: '[♣λCE]variant' },
      { eosID: 'e4', name: '[♣λc€]variant2' }
    ];
    const groups = extractClanGroups(players, { caseSensitive: false, maxEditDistance: 0, minSize: 2 });
    const tags = Object.keys(groups);
    if (tags.length !== 1) throw new Error(`Expected 1 group, got ${tags.length}: ${tags.join(', ')}`);
    if (tags[0] !== 'ACE') throw new Error(`Expected 'ACE', got '${tags[0]}'`);
    if (groups.ACE.length !== 4) throw new Error(`Expected 4 members, got ${groups.ACE.length}`);
  });

  await runTest('extractClanGroups: filters out groups smaller than minSize', async () => {
    const players = [
      { eosID: 'e1', name: '[ACE]One' },
      { eosID: 'e2', name: '[ACE]Two' },
      { eosID: 'e3', name: '[SOLO]Loner' }
    ];
    const groups = extractClanGroups(players, { caseSensitive: false, minSize: 2, maxEditDistance: 0 });
    if (Object.keys(groups).length !== 1) throw new Error('SOLO group should be filtered out');
    if (!groups.ACE) throw new Error('ACE group missing');
  });

  await runTest('extractClanGroups: Levenshtein merges within edit distance', async () => {
    const players = [
      { eosID: 'e1', name: '[CLAN]One' },
      { eosID: 'e2', name: '[CLAN]Two' },
      { eosID: 'e3', name: '[CLAN]Three' },
      { eosID: 'e4', name: '[CLAM]Four' }, // 1 edit from CLAN
      { eosID: 'e5', name: '[CLAM]Five' }
    ];
    const merged = extractClanGroups(players, { caseSensitive: false, maxEditDistance: 1, minSize: 2 });
    const tags = Object.keys(merged);
    if (tags.length !== 1) throw new Error(`Expected 1 merged group, got ${tags.length}: ${tags.join(', ')}`);
    // Larger group wins the keep slot — CLAN had 3, CLAM had 2
    if (tags[0] !== 'CLAN') throw new Error(`Expected 'CLAN' to win the merge, got '${tags[0]}'`);
    if (merged.CLAN.length !== 5) throw new Error(`Expected 5 merged members, got ${merged.CLAN.length}`);

    // With maxEditDistance: 0 they stay separate
    const split = extractClanGroups(players, { caseSensitive: false, maxEditDistance: 0, minSize: 2 });
    if (Object.keys(split).length !== 2) throw new Error('maxEditDistance: 0 should keep them separate');
  });

  await runTest('extractClanGroups: caseSensitive: true keeps raw distinct buckets', async () => {
    const players = [
      { eosID: 'e1', name: '[ace]One' },
      { eosID: 'e2', name: '[ace]Two' },
      { eosID: 'e3', name: '[ACE]Three' },
      { eosID: 'e4', name: '[ACE]Four' }
    ];
    const groups = extractClanGroups(players, { caseSensitive: true, maxEditDistance: 0, minSize: 2 });
    const tags = Object.keys(groups);
    if (tags.length !== 2) throw new Error(`Expected 2 distinct groups (ace, ACE), got ${tags.length}: ${tags.join(', ')}`);
  });

  await runTest('extractClanGroups: skips players missing name or eosID', async () => {
    const players = [
      { eosID: 'e1', name: '[ACE]One' },
      { eosID: 'e2', name: '[AC€] Two' },
      { eosID: 'e3' },                    // no name
      { name: '[ACE]Ghost' },             // no eosID
      null,                               // null entry
      undefined                           // undefined entry
    ];
    const groups = extractClanGroups(players, { caseSensitive: false, minSize: 2, maxEditDistance: 0 });
    if (!groups.ACE || groups.ACE.length !== 2) {
      throw new Error(`Expected ACE with 2 members, got ${groups.ACE?.length}`);
    }
  });

  await runTest('extractClanGroups: respects maxSize ceiling', async () => {
    const players = Array.from({ length: 25 }, (_, i) => ({
      eosID: `e${i}`,
      name: `[BIG]Player${i}`
    }));
    const groups = extractClanGroups(players, { caseSensitive: false, minSize: 2, maxSize: 18, maxEditDistance: 0 });
    if (groups.BIG) throw new Error('25-member group should be filtered out by maxSize: 18');
  });

  // ─── computePartySizes ─────────────────────────────────────────────

  await runTest('computePartySizes: same tag same team ⇒ party; other team separate', async () => {
    const players = [
      { eosID: 'a', name: '[ACE] Alpha', teamID: 1 },
      { eosID: 'b', name: '[ACE] Bravo', teamID: 1 },
      { eosID: 'c', name: '[ACE] Charlie', teamID: 2 }, // same tag, other team
      { eosID: 'd', name: 'RandomGuy', teamID: 1 }
    ];
    const m = computePartySizes(players);
    if (m.get('a').partySize !== 2) throw new Error(`a expected 2, got ${m.get('a').partySize}`);
    if (m.get('a').clanTag !== 'ACE') throw new Error(`a clanTag expected ACE, got ${m.get('a').clanTag}`);
    if (m.get('c').partySize !== 1) throw new Error(`c (lone ACE on team2) expected 1, got ${m.get('c').partySize}`);
    if (m.get('d').partySize !== 1 || m.get('d').clanTag !== null) throw new Error('d (no clan) must be solo/null');
  });

  await runTest('computePartySizes: single tag member is not a party (minSize 2)', async () => {
    const m = computePartySizes([{ eosID: 'a', name: '[ACE] Solo', teamID: 1 }]);
    if (m.get('a').partySize !== 1 || m.get('a').clanTag !== null) throw new Error('lone tag ⇒ partySize 1, clanTag null');
  });

  await runTest('computePartySizes: default normalizes ⇒ homoglyph/case variants merge', async () => {
    const players = [
      { eosID: 'a', name: '[♣ΛCE] One', teamID: 1 },
      { eosID: 'b', name: '[♣ΛC€] Two', teamID: 1 }
    ];
    const m = computePartySizes(players);
    if (m.get('a').partySize !== 2 || m.get('b').partySize !== 2) throw new Error('homoglyph variants must merge');
  });

  await runTest('computePartySizes: caseSensitive:true separates TR/tr', async () => {
    const players = [
      { eosID: 'a', name: '[TR] One', teamID: 1 },
      { eosID: 'b', name: '[tr] Two', teamID: 1 }
    ];
    const m = computePartySizes(players, { caseSensitive: true, maxEditDistance: 0 });
    if (m.get('a').partySize !== 1) throw new Error('caseSensitive:true must keep TR and tr apart');
    if (m.get('b').partySize !== 1) throw new Error(`b expected solo, got ${m.get('b').partySize}`);
    if (m.get('b').clanTag !== null) throw new Error(`b expected clanTag null, got ${m.get('b').clanTag}`);
  });

  await runTest('computePartySizes: maxEditDistance 0 does not merge near tags', async () => {
    const players = [
      { eosID: 'a', name: '[CAV1] One', teamID: 1 },
      { eosID: 'b', name: '[CAV2] Two', teamID: 1 }
    ];
    if (computePartySizes(players, { maxEditDistance: 0 }).get('a').partySize !== 1) throw new Error('editDistance 0 ⇒ no merge');
    if (computePartySizes(players, { maxEditDistance: 1 }).get('a').partySize !== 2) throw new Error('editDistance 1 ⇒ merge');
  });

  // ─── computePartySizes — bare-prefix corroboration (C1 fix) ────────

  await runTest('computePartySizes: bare two-word names do not form phantom parties', async () => {
    const players = [
      { eosID: 'a', name: 'The Rock', teamID: 1 },
      { eosID: 'b', name: 'The Bull', teamID: 1 },
      { eosID: 'c', name: 'John Smith', teamID: 1 },
      { eosID: 'd', name: 'Jon Smart', teamID: 1 } // ed-1 from JOHN
    ];
    const m = computePartySizes(players);
    for (const id of ['a', 'b', 'c', 'd']) {
      const r = m.get(id);
      if (r.partySize !== 1 || r.clanTag !== null) {
        throw new Error(`${id} expected solo/null, got ${JSON.stringify(r)}`);
      }
    }
  });

  await runTest('computePartySizes: bare prefix corroborated by explicit tag ⇒ party', async () => {
    const players = [
      { eosID: 'a', name: '[KM] Warlord', teamID: 1 },
      { eosID: 'b', name: 'KM Lookout', teamID: 1 },
      { eosID: 'c', name: 'KM Sniper', teamID: 1 }
    ];
    const m = computePartySizes(players);
    for (const id of ['a', 'b', 'c']) {
      if (m.get(id).partySize !== 3) throw new Error(`${id} expected party of 3, got ${m.get(id).partySize}`);
      if (m.get(id).clanTag !== 'KM') throw new Error(`${id} expected KM, got ${m.get(id).clanTag}`);
    }
  });

  await runTest('computePartySizes: two bare-prefix players without anchor stay solo', async () => {
    const players = [
      { eosID: 'a', name: 'KM Lookout', teamID: 1 },
      { eosID: 'b', name: 'KM Sniper', teamID: 1 }
    ];
    const m = computePartySizes(players);
    if (m.get('a').partySize !== 1 || m.get('b').partySize !== 1) throw new Error('bare pair without explicit anchor must stay solo');
  });

  await runTest('computePartySizes: corroboration is team-bound', async () => {
    const players = [
      { eosID: 'a', name: '[KM] Warlord', teamID: 1 },
      { eosID: 'b', name: '[KM] Bravo', teamID: 1 },
      { eosID: 'c', name: 'KM Lookout', teamID: 2 },
      { eosID: 'd', name: 'KM Sniper', teamID: 2 }
    ];
    const m = computePartySizes(players);
    if (m.get('a').partySize !== 2) throw new Error('team1 explicit pair must stay a party');
    if (m.get('c').partySize !== 1 || m.get('d').partySize !== 1) {
      throw new Error('team2 bare pair must not borrow team1 anchor');
    }
  });

  await runTest('computePartySizes: edit-distance merge propagates the explicit anchor', async () => {
    const players = [
      { eosID: 'a', name: '[CLAN] One', teamID: 1 },
      { eosID: 'b', name: '[CLAN] Two', teamID: 1 },
      { eosID: 'c', name: 'CLAM Three', teamID: 1 } // bare, ed-1 from CLAN
    ];
    const m = computePartySizes(players, { maxEditDistance: 1 });
    if (m.get('c').partySize !== 3) throw new Error(`bare ed-1 member must join anchored party, got ${m.get('c').partySize}`);
  });

  await runTest('computePartySizes: open-only bracket counts as explicit anchor', async () => {
    const players = [
      { eosID: 'a', name: '[OPN Alpha', teamID: 1 },
      { eosID: 'b', name: 'OPN Bravo', teamID: 1 }
    ];
    const m = computePartySizes(players);
    if (m.get('a').partySize !== 2 || m.get('b').partySize !== 2) {
      throw new Error(`open-bracket name must anchor the party, got a=${m.get('a').partySize} b=${m.get('b').partySize}`);
    }
  });

  await runTest('extractClanGroups: requireExplicit drops bare-only buckets, default keeps them', async () => {
    const players = [
      { eosID: 'a', name: 'KM Lookout' },
      { eosID: 'b', name: 'KM Sniper' }
    ];
    const strict = extractClanGroups(players, { caseSensitive: false, maxEditDistance: 0, minSize: 2, requireExplicit: true });
    if (Object.keys(strict).length !== 0) throw new Error('requireExplicit must drop bare-only bucket');
    const lax = extractClanGroups(players, { caseSensitive: false, maxEditDistance: 0, minSize: 2 });
    if (!lax.KM || lax.KM.length !== 2) throw new Error('default (audit/display) behavior must keep bare buckets');
  });

  await runTest('computePartySizes: ignoredTags ⇒ members treated as public (PART B)', async () => {
    const players = [
      { eosID: 'a', name: '[TR] One', teamID: 1 },
      { eosID: 'b', name: '[TR] Two', teamID: 1 }
    ];
    const m = computePartySizes(players, { ignoredTags: ['TR'] });
    if (m.get('a').partySize !== 1 || m.get('a').clanTag !== null) throw new Error('ignored tag ⇒ public');
  });

  await runTest('computePartySizes: null/undefined teamID stays solo (no shared bucket)', async () => {
    const players = [
      { eosID: 'a', name: '[ACE] One', teamID: null },
      { eosID: 'b', name: '[ACE] Two' } // teamID undefined
    ];
    const m = computePartySizes(players);
    if (m.get('a').partySize !== 1 || m.get('a').clanTag !== null) throw new Error(`a expected solo, got ${JSON.stringify(m.get('a'))}`);
    if (m.get('b').partySize !== 1) throw new Error(`b expected solo, got ${m.get('b').partySize}`);
  });
}
