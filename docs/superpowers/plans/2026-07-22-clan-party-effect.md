# Clan-Tag Party Effect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Feed the TrueSkill2 eq.-7 offset from clan-tag co-membership (per team) instead of in-game squad membership.

**Architecture:** A single shared `computePartySizes()` in `utils/elo-clan-grouping.js` groups round participants by clan tag within each team (reusing `extractClanGroups`). The plugin computes it live; the two replay tools recompute it from logged player names. The engine's eq.-7 math is unchanged — only the size it indexes changes (`partyOffsets[partySize-1]`).

**Tech Stack:** Node.js ESM, Sequelize (SQLite dev), custom assert-based test runner (`testing/run-all-tests.js`, `npm test`).

## Global Constraints

- **Neutral by default:** `partyOffsets` defaults to `[0.0 × 10]` → engine identical to classic TrueSkill. Golden tests must stay green.
- **Scale 0–50**, `beta = 25/6 ≈ 4.167`. Do not change engine math.
- **ESM only** (`"type": "module"`); relative imports include the `.js` extension.
- **Tests run via** `npm test` (`node testing/run-all-tests.js`); each suite exports `default async function (runTest)` and asserts by throwing `Error`.
- **Party grouping options** everywhere default to: `caseSensitive=false`, `maxEditDistance=1`, `ignoredTags=[]`. `computePartySizes` applies these defaults via `??`, so passing `undefined` is safe.
- **Party size > 10** clamps to `partyOffsets[9]` (offset table length stays 10).
- **Dev stage:** legacy `squadID`/`squadSize` DB columns are dropped, not preserved.
- **Commit** after each task's tests pass. Trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.

---

## PART A — Party effect (with `partyCaseSensitive`, `partyMaxEditDistance`)

### Task 1: `computePartySizes()` grouping function

**Files:**
- Modify: `utils/elo-clan-grouping.js` (add export; import already has `normalizeTag`, `extractClanGroups` in-module)
- Test: `testing/test-clan-grouping.js` (append cases)

**Interfaces:**
- Consumes: existing `extractClanGroups(players, {minSize, caseSensitive, maxEditDistance, maxSize})`, `normalizeTag(raw)` (same module).
- Produces: `computePartySizes(players, options?) → Map<eosID, {partySize:number, clanTag:string|null}>`
  where `players: Array<{eosID, name, teamID}>` and `options: {caseSensitive=false, maxEditDistance=1, ignoredTags=[]}`.
  Grouping is per `teamID`; a player is in a party only with same-tag members on the **same team**; `minSize` is 2 (singletons/no-tag → `{partySize:1, clanTag:null}`). The `ignoredTags` branch is present but inert until PART B wires the option.

- [ ] **Step 1: Write the failing tests** — append inside the `export default` block of `testing/test-clan-grouping.js`, before its closing `}`. Also add `computePartySizes` to the import at the top:

```js
// add to the top import list:
//   import { extractRawPrefix, normalizeTag, levenshteinDistance, extractClanGroups, computePartySizes } from '../utils/elo-clan-grouping.js';

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
  });

  await runTest('computePartySizes: maxEditDistance 0 does not merge near tags', async () => {
    const players = [
      { eosID: 'a', name: 'CAV1 One', teamID: 1 },
      { eosID: 'b', name: 'CAV2 Two', teamID: 1 }
    ];
    if (computePartySizes(players, { maxEditDistance: 0 }).get('a').partySize !== 1) throw new Error('editDistance 0 ⇒ no merge');
    if (computePartySizes(players, { maxEditDistance: 1 }).get('a').partySize !== 2) throw new Error('editDistance 1 ⇒ merge');
  });

  await runTest('computePartySizes: ignoredTags ⇒ members treated as public (PART B)', async () => {
    const players = [
      { eosID: 'a', name: '[TR] One', teamID: 1 },
      { eosID: 'b', name: '[TR] Two', teamID: 1 }
    ];
    const m = computePartySizes(players, { ignoredTags: ['TR'] });
    if (m.get('a').partySize !== 1 || m.get('a').clanTag !== null) throw new Error('ignored tag ⇒ public');
  });
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `npm test 2>&1 | grep -A2 computePartySizes`
Expected: FAIL — `computePartySizes is not a function` / `is not exported`.

- [ ] **Step 3: Implement** — append to `utils/elo-clan-grouping.js`:

```js
/**
 * Party size + clan tag per player, team-bound. Single source of truth for
 * the TrueSkill2 party (eq. 7) factor — used live by the plugin and on replay
 * by tools/elo-rebuild.js and tools/elo-calibrate.js.
 *
 * @param {Array<{eosID, name, teamID}>} players  all round participants
 * @param {Object} [options]
 *   caseSensitive   {boolean}  default false — passed to extractClanGroups
 *   maxEditDistance {number}   default 1     — Levenshtein merge (0 = exact)
 *   ignoredTags     {string[]} default []    — treated as public (no clan)
 * @returns {Map<string, {partySize:number, clanTag:string|null}>}
 */
export function computePartySizes(players, options = {}) {
  const caseSensitive   = options.caseSensitive ?? false;
  const maxEditDistance = options.maxEditDistance ?? 1;
  const ignore = new Set((options.ignoredTags ?? []).map(normalizeTag).filter(Boolean));

  const result = new Map();
  const byTeam = new Map();
  for (const p of players || []) {
    if (!p?.eosID) continue;
    result.set(p.eosID, { partySize: 1, clanTag: null }); // default solo
    if (!p.name) continue;
    const t = p.teamID ?? 0;
    if (!byTeam.has(t)) byTeam.set(t, []);
    byTeam.get(t).push(p);
  }

  for (const teamPlayers of byTeam.values()) {
    const groups = extractClanGroups(teamPlayers, {
      minSize: 2, caseSensitive, maxEditDistance, maxSize: Infinity
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
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `npm test 2>&1 | grep -c "computePartySizes.*PASS" ; npm test 2>&1 | grep -i "FAIL" || echo NO_FAILURES`
Expected: 6 passing computePartySizes lines; `NO_FAILURES`.

- [ ] **Step 5: Commit**

```bash
git add utils/elo-clan-grouping.js testing/test-clan-grouping.js
git commit -m "feat: computePartySizes — team-bound clan-tag grouping

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Rename `squadOffsets → partyOffsets` in parameters

**Files:**
- Modify: `utils/elo-parameters.js:53` (default), `:135` (identifiability pin), surrounding comments
- Test: `testing/test-elo-parameters.js` (lines 15,16,26,30,32,33,34,41–44,50)

**Interfaces:**
- Produces: `DEFAULT_PARAMETERS.partyOffsets` (length 10, all 0), `loadParameters({partyOffsets})` merges element-wise and forces `partyOffsets[0]=0`.

- [ ] **Step 1: Update the tests first** — in `testing/test-elo-parameters.js`, replace every `squadOffsets` with `partyOffsets` (12 occurrences) and reword the identifiability test title to `partyOffsets[0] forced to 0`. Example replacements:

```js
    if (p.partyOffsets.length !== 10) throw new Error(`partyOffsets must have 10 entries`);
    if (p.partyOffsets.some(v => v !== 0)) throw new Error(`partyOffsets must default to all-zero (neutral)`);
    if (!Object.isFrozen(p.partyOffsets) || !Object.isFrozen(p.killParams)) throw new Error(`nested values must be frozen`);
    // Overrides test:
    const p = loadParameters({ beta: 5.0, partyOffsets: [0, 0, 0, 1.0] });
    if (p.partyOffsets.length !== 10) throw new Error(`override must pad partyOffsets to 10`);
    if (p.partyOffsets[3] !== 1.0) throw new Error(`override at index 3 failed`);
    if (p.partyOffsets[4] !== 0) throw new Error(`unspecified array tail must keep default`);
    // Identifiability test:
  await runTest('Overrides: partyOffsets[0] forced to 0 (identifiability)', async () => {
    const p = loadParameters({ partyOffsets: [2.5, 0, 0, 1.0] });
    if (p.partyOffsets[0] !== 0) throw new Error(`partyOffsets[0] must be forced to 0, got ${p.partyOffsets[0]}`);
    if (p.partyOffsets[3] !== 1.0) throw new Error(`other overrides must still apply`);
```

- [ ] **Step 2: Run, verify fail**

Run: `npm test 2>&1 | grep -i "EloParameters" -A6 | grep -i fail`
Expected: FAIL — `partyOffsets` undefined on the parameter object.

- [ ] **Step 3: Implement** — in `utils/elo-parameters.js`:
  - Line 53 area: rename the block and comment:

```js
    // --- Party offset (eq. 7). Index i = party size i+1. ---
    // Clan-tag co-membership per team (NOT in-game squads). NEUTRAL by default.
    // partyOffsets[0] (solo) is pinned to 0 for identifiability.
    partyOffsets: Array.from({ length: 10 }, () => 0.0),
```

  - In `loadParameters` (line 135): `params.partyOffsets[0] = 0; // paper fixes offset(1) = 0`

- [ ] **Step 4: Run, verify pass**

Run: `npm test 2>&1 | grep -i "EloParameters" -A6`
Expected: all EloParameters cases PASS.

- [ ] **Step 5: Commit**

```bash
git add utils/elo-parameters.js testing/test-elo-parameters.js
git commit -m "refactor: rename squadOffsets to partyOffsets (eq.7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Engine reads `partySize` / `partyOffsets`

**Files:**
- Modify: `utils/elo-trueskill2-engine.js:32` (JSDoc), `:41-58` (`squadShifts`→`partyShifts`)
- Test: `testing/test-elo-trueskill2-engine.js` (lines 94,100,101,127,129,133,137,139,143,149,150,155,309)

**Interfaces:**
- Consumes: `perPlayerMeta[eosID].partySize`, `parameters.partyOffsets` (from Task 2).
- Produces: unchanged `computeRoundUpdate(...)` output; party shift applied via `teamMeta.*.perPlayerShifts`.

- [ ] **Step 1: Update the tests** — in `testing/test-elo-trueskill2-engine.js` replace `squadOffsets`→`partyOffsets` and `squadSize`→`partySize` (13 occurrences); reword titles `Squad offset` → `Party offset`. Representative:

```js
    partyOffsets: [0, 0, 0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5]
    for (let i = 0; i < 4; i++) meta[`t1_${i}`] = { partySize: 4 };
    for (let i = 0; i < 4; i++) meta[`t2_${i}`] = { partySize: 1 };
    const withMeta = computeRoundUpdate(t1, t2, 'team1win', { a: { partySize: 1 }, b: { partySize: 1 } }, TUNED_SQUAD);
      throw new Error('partySize=1 must match baseline exactly (partyOffsets[0] === 0)');
  await runTest('Party offset: neutral DEFAULT_PARAMETERS ignore partySize', async () => {
    const r1 = computeRoundUpdate(t1, t2, 'team1win', { a: { partySize: 9 }, b: { partySize: 1 } }, DEFAULT_PARAMETERS);
      throw new Error('with neutral DEFAULT_PARAMETERS, partySize must have no effect');
  await runTest('Party offset: oversized partySize clamps to last offset entry', async () => {
      metaAt10[`t1_${i}`] = { partySize: 10 };
      metaAt99[`t1_${i}`] = { partySize: 99 };
      throw new Error('partySize beyond the offset table must clamp to the last entry');
    const withEmptyMeta = computeRoundUpdate(t1, t2, 'team1win', { a: { partySize: 1 }, b: { partySize: 1 } }, TUNED_KD);
```
(Also rename the local `TUNED_SQUAD` fixture variable to `TUNED_PARTY` for clarity — update both its definition and uses.)

- [ ] **Step 2: Run, verify fail**

Run: `npm test 2>&1 | grep -i "TrueSkill2Engine" -A20 | grep -i fail`
Expected: FAIL — party offset cases (partyOffsets undefined ⇒ shift not applied).

- [ ] **Step 3: Implement** — replace the `squadShifts` block (`utils/elo-trueskill2-engine.js:41-58`):

```js
  // Party-offset factor (eq. 7): per-player performance-mean shift by clan-tag
  // party size. partyOffsets[0] (solo) is pinned to 0, so partySize=1 yields no
  // shift. Ratio-weighting and slot-scaling happen inside teamFactorMessages.
  const partyShifts = (team) => {
    const offsets = parameters.partyOffsets;
    if (!offsets || offsets.length === 0) return null;
    return team.map((p) => {
      const size = perPlayerMeta[p.eosID]?.partySize ?? 1;
      const idx = Math.min(Math.max(size - 1, 0), offsets.length - 1);
      return offsets[idx] ?? 0;
    });
  };

  const teamMeta = {
    team1: { perPlayerShifts: partyShifts(team1) },
    team2: { perPlayerShifts: partyShifts(team2) }
  };
```
  Also update the JSDoc at line 32: `eosID → { partySize, clanTag, kills, deaths, quit, experience, timePlayedMin }`.

- [ ] **Step 4: Run, verify pass**

Run: `npm test 2>&1 | grep -i "TrueSkill2Engine" -A20`
Expected: all engine cases PASS (including the 20 goldens — neutral default unaffected).

- [ ] **Step 5: Commit**

```bash
git add utils/elo-trueskill2-engine.js testing/test-elo-trueskill2-engine.js
git commit -m "refactor: engine indexes partyOffsets by partySize

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: DB schema — drop `squadID/squadSize`, add `partySize/clanTag`

**Files:**
- Modify: `utils/elo-database.js:293-301` (model attrs), `:375-395` (`_ensureTrueSkill2Columns`)
- Test: `testing/test-elo-database.js` (lines 87,88,106,107,143)

**Interfaces:**
- Produces: `Elo_RoundPlayers` columns `partySize INTEGER NULL`, `clanTag STRING NULL`; legacy `squadID/squadSize` dropped on migrate.

- [ ] **Step 1: Update the tests** — in `testing/test-elo-database.js`:
  - The insert fixture (lines 87-88): replace `squadID: 4, squadSize: 6,` with `partySize: 6, clanTag: 'ACE',`.
  - The read asserts (lines 106-107): replace with

```js
    if (read.partySize !== 6) throw new Error(`partySize column missing or wrong: ${read.partySize}`);
    if (read.clanTag !== 'ACE') throw new Error(`clanTag column missing or wrong: ${read.clanTag}`);
```
  - The column-existence list (line 143): replace `'squadID', 'squadSize'` with `'partySize', 'clanTag'`.

- [ ] **Step 2: Run, verify fail**

Run: `npm test 2>&1 | grep -i "EloDatabase" -A8 | grep -i fail`
Expected: FAIL — unknown column `partySize`/`clanTag`.

- [ ] **Step 3: Implement** — in `utils/elo-database.js`:
  - Model attributes (replace the `squadID`/`squadSize` blocks at 294-301):

```js
           // --- TrueSkill2 observation columns (additive; see ensureTrueSkill2Columns) ---
           partySize: {
             type: Sequelize.INTEGER,
             allowNull: true
           },
           clanTag: {
             type: Sequelize.STRING,
             allowNull: true
           },
```
  - `_ensureTrueSkill2Columns` — swap the two columns and add a legacy drop:

```js
    const columns = {
      partySize: { type: Sequelize.INTEGER, allowNull: true },
      clanTag: { type: Sequelize.STRING, allowNull: true },
      kills: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      deaths: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      quit: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      experienceBefore: { type: Sequelize.INTEGER, allowNull: true }
    };

    for (const [name, spec] of Object.entries(columns)) {
      if (!desc[name]) {
        await queryInterface.addColumn('Elo_RoundPlayers', name, spec);
        Logger.verbose('EloTracker', 1, `[DB] Migration: added column Elo_RoundPlayers.${name}`);
      }
    }

    // Dev-stage: drop legacy in-game-squad columns (best-effort; no data to keep).
    for (const legacy of ['squadID', 'squadSize']) {
      if (desc[legacy]) {
        try {
          await queryInterface.removeColumn('Elo_RoundPlayers', legacy);
          Logger.verbose('EloTracker', 1, `[DB] Migration: dropped legacy column Elo_RoundPlayers.${legacy}`);
        } catch (e) {
          Logger.verbose('EloTracker', 1, `[DB] Migration: could not drop ${legacy}: ${e.message}`);
        }
      }
    }
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test 2>&1 | grep -i "EloDatabase" -A8`
Expected: all EloDatabase cases PASS.

- [ ] **Step 5: Commit**

```bash
git add utils/elo-database.js testing/test-elo-database.js
git commit -m "feat(db): replace squad columns with partySize/clanTag; drop legacy

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Plugin — options, `_buildPerPlayerMeta`, log & DB rows

**Files:**
- Modify: `plugins/elo-tracker.js` — imports (top), `optionsSpecification` (~line 209), `_buildPerPlayerMeta` (622-659), match-log player maps (1048-1049, 1075-1076), DB `playerRows` map (1115-1116), constructor comment (242-243)
- Test: `testing/test-elo-tracker.js` (rewrite the PerPlayerMeta squad test at 269-286; update persistence test at 325-375)

**Interfaces:**
- Consumes: `computePartySizes` (Task 1), `partySize`/`clanTag` DB columns (Task 4), `partyOffsets` engine (Task 3).
- Produces: `perPlayerMeta[eosID] = { clanTag, partySize, experience, kills, deaths, timePlayedMin, quitDetected, quit }`; log/DB rows carry `clanTag`, `partySize`.

- [ ] **Step 1: Rewrite the two tests** in `testing/test-elo-tracker.js`:

Replace the PerPlayerMeta test (269-286) with:

```js
  await runTest('PerPlayerMeta: partySize by clan tag per team; no tag ⇒ solo', async () => {
    const { tracker } = await makeTrackerForTest();
    const participants = [
      { eosID: 'a', name: '[ACE] Alpha',  assignedTeamID: 1, participationRatio: 1 },
      { eosID: 'b', name: '[ACE] Bravo',  assignedTeamID: 1, participationRatio: 1 },
      { eosID: 'c', name: '[ACE] Charlie',assignedTeamID: 1, participationRatio: 0.1 }, // ineligible, still counts
      { eosID: 'd', name: '[ACE] Delta',  assignedTeamID: 2, participationRatio: 1 },   // same tag, other team
      { eosID: 'e', name: 'NoClanGuy',    assignedTeamID: 2, participationRatio: 1 }
    ];
    const eligible = participants.filter((p) => p.participationRatio >= 0.15);
    const meta = tracker._buildPerPlayerMeta(participants, eligible);

    if (meta.a.partySize !== 3) throw new Error(`a: party of 3 (incl. ineligible c) expected, got ${meta.a.partySize}`);
    if (meta.a.clanTag !== 'ACE') throw new Error(`a: clanTag ACE expected, got ${meta.a.clanTag}`);
    if (meta.d.partySize !== 1) throw new Error(`d: lone ACE on other team must not merge, got ${meta.d.partySize}`);
    if (meta.e.partySize !== 1 || meta.e.clanTag !== null) throw new Error(`e: no clan ⇒ solo/null`);
    if (meta.c) throw new Error('ineligible players get no meta entry');
  });
```

In the persistence test (325-375): the endRound mock names must bear a shared tag so `partySize` is meaningful. Change lines 337-338 names to `'[XYZ] P1'` and `'[XYZ] P2'` (p3 stays a non-clan name), then replace the log/DB assertions at 360-361 and 367 with:

```js
    if (logP1.clanTag !== 'XYZ') throw new Error(`log clanTag expected XYZ, got ${logP1.clanTag}`);
    if (logP1.partySize !== 2) throw new Error(`log partySize expected 2, got ${logP1.partySize}`);
    // ... and in the DB-row assertion:
    if (rowP1.kills !== 5 || rowP1.deaths !== 2 || rowP1.partySize !== 2 || rowP1.clanTag !== 'XYZ') {
      throw new Error(`DB row TS2 fields wrong: ${JSON.stringify(rowP1)}`);
    }
```

- [ ] **Step 2: Run, verify fail**

Run: `npm test 2>&1 | grep -i "EloTracker" -A30 | grep -i fail`
Expected: FAIL — `meta.a.partySize` undefined / `logP1.clanTag` undefined.

- [ ] **Step 3: Implement** — in `plugins/elo-tracker.js`:
  - Add import near the other `utils/` imports at the top:

```js
import { computePartySizes } from '../utils/elo-clan-grouping.js';
```
  - Constructor comment (242-243): replace with

```js
    // Kills = PLAYER_WOUNDED downs; deaths = PLAYER_DIED (revives negate a death).
    // Party size (eq.7) is derived from clan tags at round end, not in-game squads.
```
  - `optionsSpecification`: insert before the `trueskill2:` entry (~line 210):

```js
       partyCaseSensitive: {
         required: false,
         description: 'Match clan tags case-sensitively (no normalization). Default false = normalized (case/homoglyph-insensitive).',
         default: false,
         type: 'boolean'
       },
       partyMaxEditDistance: {
         required: false,
         description: 'Levenshtein distance for merging near-identical clan tags (0 = exact only).',
         default: 1,
         type: 'number'
       },
```
   and update the `trueskill2` description text `squadOffsets` → `partyOffsets`.
  - Replace `_buildPerPlayerMeta` body (622-659) with:

```js
  _buildPerPlayerMeta(participants, eligible, quitters = null, roundEndTime = null) {
    const startTime = this.session.roundStartTime;
    const roundDurationMin =
      roundEndTime != null && startTime != null
        ? Math.max(0, (roundEndTime - startTime) / 60000)
        : 0;

    // Clan-tag parties per team; ALL participants count (even ineligible ones).
    const partyByEos = computePartySizes(
      participants.map((p) => ({ eosID: p.eosID, name: p.name, teamID: p.assignedTeamID })),
      {
        caseSensitive: this.options.partyCaseSensitive,
        maxEditDistance: this.options.partyMaxEditDistance,
        ignoredTags: this.options.partyIgnoredTags // undefined until PART B ⇒ []
      }
    );

    const perPlayerMeta = {};
    for (const p of eligible) {
      const quitDetected = quitters?.has(p.eosID) ?? false;
      const party = partyByEos.get(p.eosID) ?? { partySize: 1, clanTag: null };
      perPlayerMeta[p.eosID] = {
        clanTag: party.clanTag,
        partySize: party.partySize,
        // Experience (eq. 8) = rounds played BEFORE this round.
        experience: this.eloCache.get(p.eosID)?.roundsPlayed ?? 0,
        // Kill/death observations (eq. 9)
        kills: this.killsByEosID.get(p.eosID) ?? 0,
        deaths: this.deathsByEosID.get(p.eosID) ?? 0,
        timePlayedMin: roundDurationMin * p.participationRatio,
        quitDetected,
        quit: this.options.enableQuitPenalty ? quitDetected : false
      };
    }
    return perPlayerMeta;
  }
```
  - Match-log player maps — replace `squadID: meta.squadID ?? 0,` / `squadSize: meta.squadSize ?? 1,` (both team1 map ~1048 and team2 map ~1075) with:

```js
            clanTag: meta.clanTag ?? null,
            partySize: meta.partySize ?? 1,
```
  - DB `playerRows` map (~1115-1116): replace `squadID: p.squadID, squadSize: p.squadSize,` with:

```js
        partySize: p.partySize,
        clanTag: p.clanTag,
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test 2>&1 | grep -i "EloTracker" -A30`
Expected: all EloTracker cases PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/elo-tracker.js testing/test-elo-tracker.js
git commit -m "feat: plugin computes clan-tag party size for eq.7 factor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Rebuild tool — recompute party from logged names + CLI flags

**Files:**
- Modify: `tools/elo-rebuild.js` — imports, `rebuildFromLog` (per-match meta loop ~130-141), `main()` (~180-195), usage comment
- Test: `testing/test-elo-rebuild.js` (regression only — fixture names lack tags ⇒ partySize 1 everywhere ⇒ neutral parity preserved; no change expected)

**Interfaces:**
- Consumes: `computePartySizes` (Task 1).
- Produces: `rebuildFromLog(matchlogPath, backupPath, paramOverrides, options)` where `options.partyOptions = {caseSensitive, maxEditDistance, ignoredTags}`.

- [ ] **Step 1: Confirm the regression baseline first**

Run: `npm test 2>&1 | grep -i "EloRebuild" -A10`
Expected: PASS (records current green baseline before editing).

- [ ] **Step 2: Implement** — in `tools/elo-rebuild.js`:
  - Add import: `import { computePartySizes } from '../utils/elo-clan-grouping.js';`
  - In `rebuildFromLog`, read `const partyOptions = options.partyOptions ?? {};` near the other option reads (after `applyQuitPenalty`).
  - In the per-match loop, before building `perPlayerMeta`, add:

```js
    const partyByEos = computePartySizes(
      match.players.map(pl => ({ eosID: pl.eosID, name: pl.name, teamID: pl.teamID })),
      partyOptions
    );
```
  - Replace the two meta lines `squadID: p.squadID ?? 0,` / `squadSize: p.squadSize ?? 1,` with:

```js
        clanTag: (partyByEos.get(p.eosID) ?? {}).clanTag ?? null,
        partySize: (partyByEos.get(p.eosID) ?? {}).partySize ?? 1,
```
  - In `main()`, parse the new flags and pass them through:

```js
  const partyCaseSensitive = process.argv.includes('--party-case-sensitive');
  const edArg = process.argv.find(a => a.startsWith('--party-max-edit-distance='));
  const partyMaxEditDistance = edArg ? Number(edArg.split('=')[1]) : 1;
  // strip the new flags from positional args:
  const args = process.argv.slice(2).filter(a =>
    a !== '--apply-quit-penalty' &&
    a !== '--party-case-sensitive' &&
    !a.startsWith('--party-max-edit-distance='));
```
   then pass `{ applyQuitPenalty, partyOptions: { caseSensitive: partyCaseSensitive, maxEditDistance: partyMaxEditDistance } }` as the `options` arg of `rebuildFromLog`. Update the usage string to list `[--party-case-sensitive] [--party-max-edit-distance=N]` and note they must mirror the live plugin config.

- [ ] **Step 3: Run, verify still green**

Run: `npm test 2>&1 | grep -i "EloRebuild" -A10`
Expected: PASS unchanged (fixture names have no clan tags ⇒ partySize 1 ⇒ identical to neutral replay).

- [ ] **Step 4: Smoke-run the CLI**

Run: `node tools/elo-rebuild.js testing/fixtures/rebuild-sample.jsonl /dev/null /tmp/party-rebuild.json && echo OK`
Expected: `OK` and a written `/tmp/party-rebuild.json` (no crash).

- [ ] **Step 5: Commit**

```bash
git add tools/elo-rebuild.js
git commit -m "feat(rebuild): recompute party sizes from logged names + CLI flags

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Calibrator — party-aware win prob, cache, stage-2 sweep

**Files:**
- Modify: `tools/elo-calibrate.js` — imports, CLI flag parse (top), match loader (`rl.on('line')`, cache `match.partyByEos`), `winProbability` (90-124), `replayMatches` meta (150-164), `ts2GridSearch` (279-318), stage-2 output header (~409)

**Interfaces:**
- Consumes: `computePartySizes` (Task 1), `partyOffsets` (Task 2).
- Produces: calibrator sweeps `partyOffsets` (was `squadOffsets`); gate `hasParty`.

- [ ] **Step 1: Implement** — in `tools/elo-calibrate.js`:
  - Add import: `import { computePartySizes } from '../utils/elo-clan-grouping.js';`
  - After the `jsonlPath`/`dbPath` parse, add party-option flags:

```js
const PARTY_OPTIONS = {
  caseSensitive: process.argv.includes('--party-case-sensitive'),
  maxEditDistance: (() => {
    const a = process.argv.find(x => x.startsWith('--party-max-edit-distance='));
    return a ? Number(a.split('=')[1]) : 1;
  })()
};
```
  - In `rl.on('line')`, after `matches.push({...})`, attach the cached party map (compute once per match):

```js
  match.partyByEos = computePartySizes(
    players.map(pl => ({ eosID: pl.eosID, name: pl.name, teamID: pl.teamID })),
    PARTY_OPTIONS
  );
  matches[matches.length - 1].partyByEos = match.partyByEos;
```
   (Attach to the pushed object; if the push uses a fresh literal, set `partyByEos` on it directly.)
  - `winProbability`: rename `squadShiftOf → partyShiftOf`, read `parameters.partyOffsets` and `perPlayerMeta[p.eosID]?.partySize`.
  - `replayMatches` per-player meta (150-164): replace `squadID: p.squadID ?? 0,` / `squadSize: p.squadSize ?? 1,` with:

```js
        clanTag: (match.partyByEos?.get(p.eosID) ?? {}).clanTag ?? null,
        partySize: (match.partyByEos?.get(p.eosID) ?? {}).partySize ?? 1,
```
  - `ts2GridSearch`:

```js
  const hasParty = matches.some(m => [...(m.partyByEos?.values() ?? [])].some(v => v.partySize > 1));
  const s4s = hasParty ? [0, 0.5, 0.83, 1.2] : [0]; // 4-stack party boost
  if (!hasParty) console.log('  (no clan parties in log — skipping partyOffset sweep)');
  // inside the loop:
  const partyOffsets = Array.from({ length: 10 }, (_, i) => (i < 1 ? 0 : (s4 / 3) * i));
  const overrides = { beta: BETA, tau: TAU, experienceOffsets, partyOffsets, quitParams: {...} };
```
   Remove the old `hasSquad` / `squadOffsets` lines. Update the stage-2 results header label `squad4` → `party4`.

- [ ] **Step 2: Verify it loads & the full suite is green**

Run: `npm test 2>&1 | tail -5`
Expected: overall PASS summary, 0 failures.

- [ ] **Step 3: Smoke-run the calibrator** (needs a JSONL + a DB backup JSON; use the fixture and a minimal backup)

Run:
```bash
printf '{"players":[]}' > /tmp/db.json
node tools/elo-calibrate.js testing/fixtures/rebuild-sample.jsonl /tmp/db.json 2>&1 | grep -i "party\|STAGE 2" | head
```
Expected: runs without throwing; prints the STAGE 2 header and a party-related line (`no clan parties in log — skipping partyOffset sweep`, since fixture names have no tags).

- [ ] **Step 4: Commit**

```bash
git add tools/elo-calibrate.js
git commit -m "feat(calibrate): sweep partyOffsets from recomputed clan parties

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Documentation

**Files:**
- Modify: `docs/rating-engine-guide.md`, `docs/trueskill2-explained.md`, `docs/trueskill2-erklaerung.md`, `README.md`

- [ ] **Step 1: Update `docs/rating-engine-guide.md`**
  - §2 event list: `PLAYER_WOUNDED`/`PLAYER_DIED` unchanged; note squad size is now clan-tag party size.
  - §4 "Squad factor (eq. 7)" → replace the paragraph with:

```markdown
**Party factor (eq. 7) — `partyOffsets`.** A per-party-size performance offset,
where a "party" is players sharing a **clan tag on the same team** (detected from
their names, not in-game squads). It shifts the *team mean* used in the win/loss
comparison, ratio-weighted and slot-scaled the same way the team mean is. Index =
party size − 1 (solo/no-tag/single-tag pinned to 0). Detection is tunable via the
plugin options `partyCaseSensitive`, `partyMaxEditDistance` and `partyIgnoredTags`.
Neutral default = no effect.
```
  - §5 config table: `squadOffsets` row → `partyOffsets`; add rows for `partyCaseSensitive` (default `false`), `partyMaxEditDistance` (default `1`), `partyIgnoredTags` (default `[]`).
  - §6 calibrate wording: "4-stack squad boost" → "4-stack party boost"; "no squad sizes in log" → "no clan parties in log".

- [ ] **Step 2: Update `docs/trueskill2-explained.md` and `docs/trueskill2-erklaerung.md`** — eq. 7 section: rename "squad offset" → "party offset (clan tag)"; note Squad in-game squads are NOT used; grouping is clan-tag co-membership per team.

- [ ] **Step 3: Update `README.md`** — any `squadOffsets` mention → `partyOffsets`; one line that the party effect uses clan tags.

- [ ] **Step 4: Verify no stale references remain**

Run: `grep -rn "squadOffsets\|squadSize\|squad offset\|Squad factor" docs README.md plugins utils tools || echo CLEAN`
Expected: `CLEAN` (or only historical/CHANGELOG mentions you intentionally keep).

- [ ] **Step 5: Commit**

```bash
git add docs README.md
git commit -m "docs: party (clan-tag) factor replaces squad factor

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## PART B — `partyIgnoredTags` option (follow-up)

### Task 9: Expose `partyIgnoredTags` as config (plugin + tools)

The ignore filter already exists in `computePartySizes` (Task 1) and is unit-tested there. This task only makes it *reachable via config*.

**Files:**
- Modify: `plugins/elo-tracker.js` (`optionsSpecification`), `tools/elo-rebuild.js` (`main`), `tools/elo-calibrate.js` (`PARTY_OPTIONS`), `docs/rating-engine-guide.md`
- Test: `testing/test-elo-tracker.js` (one integration case)

**Interfaces:**
- Consumes: `computePartySizes(..., {ignoredTags})` (already forwarded by the plugin/tool call sites from PART A).
- Produces: plugin option `partyIgnoredTags: string[]`; CLI flag `--ignore-tags=A,B` on both tools.

- [ ] **Step 1: Write the failing integration test** — append to `testing/test-elo-tracker.js`:

```js
  await runTest('PerPlayerMeta: partyIgnoredTags treats community tag as public', async () => {
    const server = createMockServer();
    const tracker = new EloTracker(server, { ...mockOptions, partyIgnoredTags: ['ACE'] }, mockConnectors);
    tracker.db = createMockDb();
    tracker.session = createMockSession();
    await tracker.mount();
    const participants = [
      { eosID: 'a', name: '[ACE] Alpha', assignedTeamID: 1, participationRatio: 1 },
      { eosID: 'b', name: '[ACE] Bravo', assignedTeamID: 1, participationRatio: 1 }
    ];
    const meta = tracker._buildPerPlayerMeta(participants, participants);
    if (meta.a.partySize !== 1 || meta.a.clanTag !== null) {
      throw new Error(`ignored tag must make members public, got ${JSON.stringify(meta.a)}`);
    }
  });
```

- [ ] **Step 2: Run, verify fail**

Run: `npm test 2>&1 | grep -i "partyIgnoredTags treats" -A2`
Expected: FAIL — `partySize` is 2 (option not declared/forwarded yet, so `this.options.partyIgnoredTags` is `undefined` → but the call already forwards it; the failure is that `mockOptions` lacks it AND the option isn't declared, so it stays undefined ⇒ []). If it already passes because Task 5 forwards `undefined`→`[]`, the real gap is the *declared default*; assert instead that the declared default exists (see Step 3) and keep this test as the behavioral guard.

- [ ] **Step 3: Implement**
  - `plugins/elo-tracker.js` `optionsSpecification`: add after `partyMaxEditDistance`:

```js
       partyIgnoredTags: {
         required: false,
         description: 'Clan tags to treat as public (community tags that are not real clans). Matched normalized. Default empty.',
         default: [],
         type: 'array'
       },
```
   (The `_buildPerPlayerMeta` call already forwards `this.options.partyIgnoredTags` from Task 5.)
  - `tools/elo-rebuild.js` `main()`: parse `--ignore-tags`:

```js
  const igArg = process.argv.find(a => a.startsWith('--ignore-tags='));
  const partyIgnoredTags = igArg ? igArg.split('=')[1].split(',').map(s => s.trim()).filter(Boolean) : [];
```
   add `!a.startsWith('--ignore-tags=')` to the positional-args filter, and include `ignoredTags: partyIgnoredTags` in the `partyOptions` object. Update usage string.
  - `tools/elo-calibrate.js` `PARTY_OPTIONS`: add

```js
  ignoredTags: (() => {
    const a = process.argv.find(x => x.startsWith('--ignore-tags='));
    return a ? a.split('=')[1].split(',').map(s => s.trim()).filter(Boolean) : [];
  })()
```

- [ ] **Step 4: Run, verify pass**

Run: `npm test 2>&1 | grep -i "partyIgnoredTags treats" -A2 ; npm test 2>&1 | tail -3`
Expected: the ignore case PASS; overall suite PASS, 0 failures.

- [ ] **Step 5: Doc line + commit**
  - `docs/rating-engine-guide.md`: ensure the `partyIgnoredTags` row (added in Task 8) describes: "list of clan tags treated as public (community tags); default empty; matched normalized". Add the same `--ignore-tags=A,B` flag to the §7 rebuild/calibrate usage examples.

```bash
git add plugins/elo-tracker.js tools/elo-rebuild.js tools/elo-calibrate.js docs/rating-engine-guide.md testing/test-elo-tracker.js
git commit -m "feat: partyIgnoredTags option — community tags treated as public

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review (author checklist — completed)

- **Spec coverage:** grouping fn (T1), rename params/engine (T2,T3), DB drop+add (T4), plugin wiring+options (T5), rebuild recompute+flags (T6), calibrate sweep+flags (T7), docs (T8), ignoredTags option (T9). All spec §6 files covered.
- **Placeholders:** none — every code step shows the actual edit.
- **Type consistency:** `computePartySizes(players, {caseSensitive, maxEditDistance, ignoredTags}) → Map<eosID,{partySize, clanTag}>` used identically in T5/T6/T7; meta keys `partySize`/`clanTag` consistent across plugin, engine (`partySize`), log, DB (`partySize`/`clanTag`), tools.
- **Ordering:** T1→T2→T3 (core) → T4 (schema) → T5 (plugin writes to schema) → T6,T7 (tools) → T8 (docs) → T9 (PART B). Each task ends green and committable.
