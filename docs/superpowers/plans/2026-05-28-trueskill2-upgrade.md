# TrueSkill2 Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the closed-form TrueSkill (Herbrich 2007) update in `utils/elo-calculator.js` with a TrueSkill2 implementation (Minka, Cleven & Zaykov 2018) that adds squad offsets, experience-based skill drift, a quit-penalty factor, and individual kill/death statistics as Bayesian observations.

**Architecture:** The existing `EloCalculator.computeTeamUpdate` is a closed-form Expectation-Propagation (EP) update for the two-team comparison factor. We keep that factor and **add four new factors** (squad-offset mean shift, experience drift, quit observation, kill/death observation) whose messages combine with the team-factor message into the player's posterior. All factor messages are produced in natural-parameter form (precision π = 1/σ², precision-mean τ = μ/σ²) and combined by adding precisions and precision-means. A new `EloTrueSkill2Engine` orchestrates factor evaluation; the legacy `computeTeamUpdate` becomes a thin wrapper that delegates to the engine.

Skipped from the paper:
- **Mode correlation (Section 11)** — Squad has no meaningfully distinct game modes; layers are filtered by `ignoredGameModes` already.
- **Rprop parameter estimation (Section 4)** — replaced by manual + grid-search tuning via the existing `tools/elo-calibrate.js`.
- **Full iterative EP** — we apply factors in **one parallel pass**: every factor message is computed from the player's prior and all messages are combined once (there is NO sequential schedule; see Amendment A6). Exact at neutral defaults; an unquantified approximation when factors are strong (the paper iterates to a fixed point). Batch ("TrueSkill Through Time") inference is implemented by replaying matches through the same one-pass engine in `tools/elo-rebuild.js`.

**Tech Stack:** JavaScript ES modules (no TypeScript), Node.js, Sequelize ORM, SquadJS 4.1.0 plugin framework, custom test harness in `testing/run-all-tests.js`.

**Paper reference:** `/home/hans/PhpstormProjects/squadjs-elo-tracker/trueskill2.pdf`. Equation numbers in this plan refer to that paper.

**Scale note:** The existing code uses a 0–50 skill scale (μ₀=25, σ₀=8.333, β=4.167). The paper uses ~0–5 (β=1). We **keep the existing scale** and express all new offsets in the existing scale (multiply paper values by 4.167 where they involve β-relative magnitudes). The DB columns `mu`, `sigma` retain their current semantics.

---

## ⚠ Amendments (2026-07-08 verification pass) — THESE OVERRIDE THE TASK SNIPPETS BELOW

A 9-agent verification (5 code checkers against the actual sources, 4 math checkers against the paper)
confirmed the architecture and paper math, but found concrete errors in the task snippets. The code
blocks in Tasks 1–12 are **indicative, not literal** — where an amendment below contradicts a snippet,
the amendment wins.

**Locked product decisions:**
1. Neutral defaults — all TS2 factors ship disabled; engine reproduces TS1 until calibrated.
2. Quit penalty config-gated, default OFF (`enableQuitPenalty: false`). Quit detection is inherently
   unreliable (SquadJS `PLAYER_DISCONNECTED` never fires; departures only inferable from
   `server.players` diffs at ~30 s poll granularity; crash vs rage-quit indistinguishable). Quit flags
   are still detected + recorded to DB regardless of the gate.
3. History forward-only — old rounds lack kills/deaths/squad/quit; factors apply to new rounds only.

### A. Math fixes

- **A1 — opponent-average variance (Tasks 9+10).** `teamSigmaSq` is the variance of the team **sum**;
  the opponent mean uses `/N` (average). Variance of the average is `/N²`, not `/N`:
  `team1OtherVar = teamSigmaSq2 / (safeN2 * safeN2)` (and vice versa). Applies to both
  `quitFactorMessage` and `killDeathFactorMessage` inputs. (Paper eq. 11, p.16.)
- **A2 — τ² placement (Task 6).** Do NOT bake `+ tau²` into the team-factor message. Team message uses
  `newSigmaSq = sigmaSq * (1 - safeFactor)`; the engine applies dynamics **once, after** combining all
  messages: `posteriorVariance += tau²` (paper online step 2(d), p.8). Byte-equivalent at neutral
  defaults, correct when kill/death/quit messages also fire.
- **A3 — kill/death count = 0 (Task 10).** The `max(0,·)` truncation matters exactly at count 0
  (common in Squad: medics, logi). For `count === 0` use the censored one-sided update (observe
  `count ≤ 0`): with `count|skill ~ N(a·skill+b, V)`, `t = -(a·mu+b)/√(V + a²σ²)`, standard
  probit-Gaussian EP update via `gauss.v`/`gauss.w`, chain-rule scaled by `a·σ²/√(V+a²σ²)` (sign of
  `a` handles kills vs deaths). Linear-Gaussian message only for `count > 0`. The "typical Squad kill
  counts of 10–30" justification is wrong — delete it. NOTE (implementation finding): this censored
  update is the exact eq.-9 semantics and pulls HARDER than naively pinning the Gaussian at 0 when
  the expected count is well above zero — the latent's conditional mean lies below 0. That is
  faithful to the paper's model, not a softening.
- **A4 — delete `pU`/`pR` from `quitParams` (Tasks 1/9).** They are eq.-13 noisy-OR params that the
  factor never uses — dead config. Document that the implementation is the deterministic-quit limit
  (p_u→0, p_r→1) of eq. 13, the strongest-possible penalty (paper's own online "mini-game"
  interpretation, p.18), and that `mQ` (default −2.08 ⇒ ≈ −4.7 μ per quit) needs Squad calibration
  before `enableQuitPenalty` is turned on.
- **A5 — `gauss.v` tail guard (Task 6).** Legacy `if (denom === 0) return 0` zeroes the update on
  extreme upsets — wrong direction. In `utils/elo-gauss.js`: when `cdf(t−e)` underflows, return the
  inverse-Mills asymptote `e − t` (and `w → 1`). Add a tail unit test.
- **A6 — EP schedule (prose).** One **parallel** pass: all factor messages computed from the prior,
  combined once. No sequential schedule.

### B. Test-harness convention (systemic — every test snippet below is mis-shaped)

`testing/run-all-tests.js:36-42` hardcodes a `suites` array and calls **only
`module.default(runTest)`**. Top-level `export async function testX` is NEVER invoked, and the runner
always exits 0 (missing module ⇒ soft "Skipped").

- Every new test = `await runTest('name', async () => {...})` **inside** the suite's default-export
  function (pattern of `runSessionTests` / `runTrackerTests` / `runDatabaseTests`).
- New suites (`test-elo-parameters.js`, `test-elo-trueskill2-factors.js`,
  `test-elo-trueskill2-engine.js`, `test-elo-rebuild.js`) each need a default-export wrapper AND an
  entry in the `suites` array.
- "Verify it fails/passes" = inspect `[PASS]`/`[FAIL]`/`Skipped` lines, never the exit code.

### C. Per-task code corrections (real names/shapes)

- **Task 1:** no `pU`/`pR`; force `squadOffsets[0] = 0` in `loadParameters`; plugin wiring = one
  `trueskill2` options block in `optionsSpecification` (elo-tracker.js:158-191) and
  `this.params = loadParameters(this.options.trueskill2 ?? {})` in the constructor.
- **Task 2:** no `_openSegment`/`_closeSegment` helpers exist — segment creation is inlined at THREE
  sites (~88 new-join, ~112 reopen, ~128 team-change): capture `squadID` at ALL three. Destructure
  `squadID` in `updatePlayers` (line 78); normalize `?? 0` on BOTH sides of the change comparison.
  `endRound` param is `timestamp`, loop var `session`; add `dominantSquadID` inside the pushed
  participant literal (~206-215). Add non-destructive `snapshotParticipants(now)` (never mutate
  `segment.leaveTime` — segments are shared by reference with `activeSegment`; use
  `seg.leaveTime ?? now` locally; apply the same 0-time skip). No "null-teamID test" exists — add one.
- **Task 3:** kills from **`PLAYER_WOUNDED`** (has `teamkill` bool; Squad credits kills at the down),
  deaths from **`PLAYER_DIED`** (give-up/bleed-out; revives negate). Guard null
  `victim`/`attacker`/`teamID`; no kill credit when `teamkill === true` or attacker === victim.
  Handler pattern: pre-bind into `this.listeners` in the constructor, `removeListener`+`on` in
  `mount()`, `removeListener` in `unmount()` — never inline `.bind()` in `on(...)`, never
  `removeEventListener`. Round start time is `this.session.roundStartTime` (no `this.roundStartTime`
  exists). Quit detection: `lastSeenByEosID` refreshed in existing `onUpdatedPlayerInfo`; quitter =
  participation < `quitParticipationThreshold` AND absent > `quitGraceSeconds` (default 60 s ≈ 2 poll
  cycles). New options: `quitGraceSeconds`, `quitParticipationThreshold`, `enableQuitPenalty`
  (default false); `perPlayerMeta[id].quit` set only when enabled, DB `quit` column records the
  detected flag regardless. Read kills/deaths maps during ROUND_ENDED processing BEFORE any NEW_GAME
  clear (restart-recovery interleave, :269-274). Tests: build `makeTrackerForTest` from the existing
  mock patterns; set `tracker.ready = true`; stub `db.saveRoundStartTime`; drive
  `session.startRound(t)` with controlled timestamps (`onNewGame` uses `Date.now()`).
- **Task 4:** signature is `insertRoundPlayers(roundHistoryId, endedAt, playerRows)`;
  `bulkCreate` silently drops unknown keys (expected pre-fix failure = `read.squadID` undefined, not
  an SQL error). Use `Sequelize.INTEGER/BOOLEAN/...` (no `DataTypes` import exists). Run
  `ensureTrueSkill2Columns` after the four per-model `.sync()` calls (~305-308) **inside
  `_executeWithRetry`**; log via module-level `Logger.verbose('EloTracker', 1, ...)` (no
  `this.logger`). Tests: `db.initDB()`, `db.models.RoundPlayers`, in-memory sqlite built like
  test-elo-database.js:4-18.
- **Task 6:** `teamFactorMessages` must return the FULL legacy debug shape —
  `{teamMu1, teamMu2, teamSigmaSq1, teamSigmaSq2, c, effectiveN1, effectiveN2, nTotal, epsilon, tRaw,
  vVal, wVal}` — and the wrapper must reassemble it byte-compatible (`tools/elo-inspect.js:758-770`
  reads all 12 fields, untested by any suite). Wrapper reads `this.BETA`/`this.TAU` **at call time**
  (`tools/elo-calibrate.js:104-105` mutates them). The engine-vs-wrapper equivalence tests are
  tautological after the rewrite — BEFORE rewriting `computeTeamUpdate`, snapshot golden outputs of
  the ORIGINAL implementation (`testing/fixtures/team-update-goldens.json`, ~20 scenarios) and assert
  the engine matches to 1e-9. `fromMuSigma` throws on sigma=0 where legacy tolerated it — acceptable
  (0.5 floor everywhere); note it. Land steps 3–5 as ONE commit (no intermediate import cycle).
- **Tasks 7–10:** squad mean shift computed inside `teamFactorMessages` from its own
  `scale1`/`scale2` (do not duplicate the 50-slot scaling). Squad semantic: in-game squads (max 9),
  not pre-made parties — calibration decides the signal; `squadSize` = participants sharing
  `(assignedTeamID, dominantSquadID)`, squad 0 ⇒ size 1. `experience` read from
  `eloCache.get(id)?.roundsPlayed ?? 0` BEFORE the post-round cache write (test: new player ⇒ index
  0). `timePlayedMin = (roundEnd − session.roundStartTime)/60000 × participationRatio` (includes
  ~260 s staging — acceptable; per-minute normalization dilutes uniformly).
- **Task 10 step 5:** join meta into `playerRows` by eosID at elo-tracker.js:879-896 (rows come from
  `matchRecord.players`, no `meta` in scope there). ALSO add kills/deaths/squadID/squadSize/quit to
  the JSONL `matchRecord` players (:829-862) so future rebuilds/calibrations can replay the factors.
- **Task 11:** real log shape is a flat `match.players[]` with `teamID` (split by `=== 1/2`),
  `match.roundDuration` (ms — NOT `durationMs`), `match.outcome` incl. `'draw'` (skip draws like
  elo-calibrate.js:68). Keep the 2-arg CLI (`<matchlog.jsonl> <backup.json>`) and the
  restore-compatible output schema (steamID, discordID, name, wins, losses, roundsPlayed, lastSeen) —
  `!elo restore` and `elo-inspect.js` consume it. Fixture must use the REAL shape; new-factor fields
  optional per record.
- **Task 12:** this is a rewrite of the sweep loop, not an extension — keep the existing parse-once +
  replay-with-pre-match-snapshot structure (`replayMatches`, :116-159) and objective machinery; do
  NOT re-read the log per grid point. Grid = 324 evaluations (not "~1024").
  `evaluatePredictiveAccuracy` needs its own replay loop capturing pre-round teamMu.

### D. Accepted risks (document, don't fix)

- Quit detection ~30 s granularity; crash ≠ rage-quit; mitigated by the OFF gate + DB recording.
- One-pass parallel EP — exact at neutral defaults.
- Kill/death factor updates only the player, not opponents; opponent stats use prior, not cavity.
- Repo τ=0.25/match ≈ 60× the paper's γ in β-units — legacy behavior; calibration's problem.
- `utils/elo-commands.js` references `EloCalculator.*` without importing it — pre-existing, out of scope.

---

## File Structure

**New files (create):**

- `utils/elo-parameters.js` — central config object holding every TrueSkill2 parameter (β, τ, γ, ε, m₀, v₀, squadOffsets[10], experienceOffsets[200], killParams, deathParams, quitParams). Exports `DEFAULT_PARAMETERS` and `loadParameters(optionsFromPlugin)`. One responsibility: produce a frozen parameter object.
- `utils/elo-trueskill2-factors.js` — pure-math factor library. Exports Gaussian arithmetic helpers (in natural form), and one function per factor that returns a Gaussian message `{deltaPrecision, deltaPrecisionMean}` from the factor to each player's skill variable. Functions: `gaussianAdd`, `teamFactorMessage`, `killFactorMessage`, `deathFactorMessage`, `quitFactorMessage`. One responsibility: factor math, no orchestration.
- `utils/elo-trueskill2-engine.js` — orchestrator. Exports `computeRoundUpdate(team1, team2, outcome, perPlayerMeta, parameters)`. Loops factors, sums messages, applies experience drift, returns `{team1Updates, team2Updates}` in the same shape the existing plugin consumes. One responsibility: orchestration.
- `testing/test-elo-parameters.js`, `testing/test-elo-trueskill2-factors.js`, `testing/test-elo-trueskill2-engine.js` — unit tests.
- `testing/test-elo-trueskill2-integration.js` — end-to-end test through the engine with realistic match data.

**Modified files:**

- `utils/elo-calculator.js` — `computeTeamUpdate` becomes a thin wrapper delegating to the engine. Existing constants and erf/cdf helpers retained (the factor library imports them).
- `utils/elo-session-manager.js` — segments gain a `squadID` field; the diff in `updatePlayers` detects squad changes and rolls the segment. `endRound` returns `squadIDByEosID` (most-time squad) and `squadSizeByEosID`.
- `utils/elo-database.js` — `Elo_RoundPlayers` gains columns: `squadID`, `squadSize`, `kills`, `deaths`, `quit`, `experienceBefore`. `Elo_PlayerStats` adds nothing (mu/sigma/roundsPlayed already cover what's needed). Schema migration runs at startup.
- `plugins/elo-tracker.js` — subscribe to `PLAYER_DIED`; maintain `killsByEosID` and `deathsByEosID` Maps for the round; detect quitters at round end (participation < `minParticipationRatio` AND last-known-presence < round end - quit-window-seconds); pass per-player meta to the engine.
- `tools/elo-rebuild.js` — replay matches through `computeRoundUpdate`.
- `tools/elo-calibrate.js` — extend grid search to include `m_q`, `experienceOffset[0]`, `squadOffset[4]` (the only TrueSkill2 parameters worth tuning at this scale).

---

## Task 1: Parameters module and configuration plumbing

**Files:**
- Create: `utils/elo-parameters.js`
- Create: `testing/test-elo-parameters.js`
- Modify: `testing/run-all-tests.js:1-50` (register the new test suite)

- [ ] **Step 1: Write the failing test**

Create `testing/test-elo-parameters.js`:

```javascript
import { DEFAULT_PARAMETERS, loadParameters } from '../utils/elo-parameters.js';

export async function testDefaults() {
  const p = DEFAULT_PARAMETERS;
  if (p.beta !== 25.0 / 6.0) throw new Error(`beta default mismatch: ${p.beta}`);
  if (p.tau !== 25.0 / 100.0) throw new Error(`tau default mismatch: ${p.tau}`);
  if (p.drawProbability !== 0.01) throw new Error(`drawProbability default mismatch`);
  if (p.squadOffsets.length !== 10) throw new Error(`squadOffsets must have 10 entries`);
  if (p.squadOffsets[0] !== 0) throw new Error(`squadOffsets[0] must be 0 (solo baseline)`);
  if (p.experienceOffsets.length !== 200) throw new Error(`experienceOffsets must have 200 entries`);
  if (p.killParams.wPlayer === undefined) throw new Error(`killParams.wPlayer missing`);
  if (p.quitParams.mQ > 0) throw new Error(`m_q must be <= 0 (paper constraint)`);
  if (Object.isFrozen(p) !== true) throw new Error(`DEFAULT_PARAMETERS must be frozen`);
}

export async function testOverrides() {
  const p = loadParameters({ beta: 5.0, squadOffsets: [0, 0, 0, 1.0] });
  if (p.beta !== 5.0) throw new Error(`override of beta failed`);
  if (p.squadOffsets.length !== 10) throw new Error(`override must pad squadOffsets to 10`);
  if (p.squadOffsets[3] !== 1.0) throw new Error(`override at index 3 failed`);
  if (p.tau !== DEFAULT_PARAMETERS.tau) throw new Error(`unspecified field must keep default`);
}

export async function testOverridesAreFrozen() {
  const p = loadParameters({ beta: 5.0 });
  if (!Object.isFrozen(p)) throw new Error(`loadParameters result must be frozen`);
  if (!Object.isFrozen(p.squadOffsets)) throw new Error(`nested arrays must be frozen`);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node testing/run-all-tests.js`
Expected: FAIL with "Cannot find module '../utils/elo-parameters.js'" or similar.

- [ ] **Step 3: Implement `utils/elo-parameters.js`**

```javascript
/**
 * Central TrueSkill2 parameter object. All tunable parameters live here.
 * See trueskill2.pdf for definitions.
 *
 * Scale: 0–50 (existing repo convention). Paper values for β, m_q, offsets
 * have been multiplied by 4.167 (the repo's β/paper's β) when they are
 * β-relative magnitudes.
 */

const SCALE = 25.0 / 6.0; // = repo β; ratio repo:paper = 4.167:1

/**
 * Default parameters are NEUTRAL: every TrueSkill2 feature is disabled out
 * of the box (all offsets zero, kill/death weights zero), so the engine
 * reproduces TrueSkill1 behaviour bit-for-bit until the operator opts in.
 *
 * Operators turn features on by:
 *   (a) setting non-zero values in the plugin config block, OR
 *   (b) running `tools/elo-calibrate.js` on the match log and copying the
 *       resulting parameters into config.
 *
 * The paper's Halo-derived values don't transfer to Squad — calibrate.
 */
function buildDefaults() {
  return {
    // --- Prior on skill (eq. 1) ---
    mu0: 25.0,
    v0: (25.0 / 3.0) ** 2, // matches existing SIGMA_DEFAULT²

    // --- Performance noise (eq. 4) ---
    beta: SCALE, // 4.167

    // --- Dynamics noise (eq. 2 / 3) ---
    tau: 25.0 / 100.0,                  // per-match drift σ
    tauPerMinute: 0,                    // time-based drift; 0 disables it

    // --- Draw margin (eq. ε) ---
    drawProbability: 0.01,

    // --- Squad offset (eq. 7). Index i = squad size i+1. ---
    // NEUTRAL by default. Calibrated values from `elo-calibrate.js` typically
    // grow from 0 (solo) up to ~+0.7·β (≥10), per paper's Halo 5 fit.
    squadOffsets: Array.from({ length: 10 }, () => 0.0),

    // --- Experience offset (eq. 8). Capped at 200 matches. ---
    // NEUTRAL by default. A common shape is a small positive value at low
    // experience that decays to 0 — operator must calibrate against own data.
    experienceOffsets: Array.from({ length: 200 }, () => 0.0),

    // --- Kill factor (eq. 9). c=kill ---
    // count_i^kill ~ max(0, N((w_p·perf_i + w_o·perf_o_i)·tp, v·tp))
    // NEUTRAL: wPlayer=0 makes the factor message identically zero.
    killParams: {
      wPlayer: 0.0,
      wOpponent: 0.0,
      variance: 1.0      // any positive value; ignored when weights are zero
    },

    // --- Death factor (eq. 9). c=death ---
    deathParams: {
      wPlayer: 0.0,
      wOpponent: 0.0,
      variance: 1.0
    },

    // --- Quit factor (eq. 12-13) ---
    // m_q ≤ 0; v_q > 0. Defaults make the factor LARGE enough that it has
    // perceptible bite when quitFactorMessage IS invoked (which only happens
    // when perPlayerMeta[eosID].quit === true).
    quitParams: {
      mQ: -SCALE * 0.5,  // -2.08; rough paper-scale starting point
      vQ: 1.0,
      pU: 0.01,
      pR: 0.99
    },

    // --- Per-round behavioural thresholds (engine-level, not paper) ---
    quitParticipationThreshold: 0.5, // below this AND absent at end ⇒ quit
    minParticipationRatio: 0.15      // ELO eligibility floor (mirrors plugin)
  };
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
  }
  return obj;
}

export const DEFAULT_PARAMETERS = deepFreeze(buildDefaults());

/**
 * Build a parameter object merging user overrides onto defaults.
 * Arrays are padded to canonical lengths from the defaults.
 *
 * @param {Object} overrides
 * @returns {Object} frozen parameter object
 */
export function loadParameters(overrides = {}) {
  const params = buildDefaults();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(params[key]) && Array.isArray(value)) {
      const merged = params[key].slice();
      for (let i = 0; i < value.length && i < merged.length; i++) merged[i] = value[i];
      params[key] = merged;
    } else if (typeof params[key] === 'object' && typeof value === 'object') {
      params[key] = { ...params[key], ...value };
    } else {
      params[key] = value;
    }
  }
  return deepFreeze(params);
}
```

- [ ] **Step 4: Register the test suite in `testing/run-all-tests.js`**

Add an import and registration following the existing pattern. Open `testing/run-all-tests.js`, locate the existing list of imports/registrations, and add an entry for `test-elo-parameters.js` that exercises `testDefaults`, `testOverrides`, `testOverridesAreFrozen`. The exact insertion site depends on the existing harness; mirror the surrounding pattern.

- [ ] **Step 5: Run test to verify it passes**

Run: `node testing/run-all-tests.js`
Expected: PASS for all three parameter tests; all previously-passing tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add utils/elo-parameters.js testing/test-elo-parameters.js testing/run-all-tests.js
git commit -m "Add TrueSkill2 parameters module with defaults"
```

---

## Task 2: Capture squadID per session segment

**Files:**
- Modify: `utils/elo-session-manager.js` (segment tracking and `endRound` return shape)
- Modify: `testing/test-elo-session-manager.js` (add squad-change scenarios)

- [ ] **Step 1: Write the failing test**

Append to `testing/test-elo-session-manager.js`:

```javascript
export async function testSquadIDTrackedPerSegment() {
  const sm = new EloSessionManager();
  sm.startRound(1000);
  sm.updatePlayers([
    { eosID: 'p1', name: 'P1', steamID: 's1', teamID: 1, squadID: 3 }
  ], 1000);
  sm.updatePlayers([
    { eosID: 'p1', name: 'P1', steamID: 's1', teamID: 1, squadID: 5 }
  ], 60000); // moved squads
  const participants = sm.endRound(120000);
  const p1 = participants.find(x => x.eosID === 'p1');
  if (!p1.segments || p1.segments.length < 2) {
    throw new Error(`expected ≥2 segments after squad change, got ${p1.segments?.length}`);
  }
  // Most-time squad: each segment is 60s, so the squad-tiebreaker keeps the earliest squadID.
  if (p1.dominantSquadID !== 3 && p1.dominantSquadID !== 5) {
    throw new Error(`dominantSquadID must be 3 or 5, got ${p1.dominantSquadID}`);
  }
}

export async function testDominantSquadIDByTime() {
  const sm = new EloSessionManager();
  sm.startRound(0);
  sm.updatePlayers([
    { eosID: 'p1', name: 'P1', steamID: 's1', teamID: 1, squadID: 3 }
  ], 0);
  sm.updatePlayers([
    { eosID: 'p1', name: 'P1', steamID: 's1', teamID: 1, squadID: 5 }
  ], 30000); // squad change at 30s
  // Total round 100s: 30s in squad 3, 70s in squad 5
  const participants = sm.endRound(100000);
  const p1 = participants.find(x => x.eosID === 'p1');
  if (p1.dominantSquadID !== 5) {
    throw new Error(`dominantSquadID should be the squad with more time (5), got ${p1.dominantSquadID}`);
  }
}

export async function testUnassignedSquadIsZero() {
  const sm = new EloSessionManager();
  sm.startRound(0);
  sm.updatePlayers([
    { eosID: 'p1', name: 'P1', steamID: 's1', teamID: 1, squadID: null }
  ], 0);
  const participants = sm.endRound(60000);
  const p1 = participants.find(x => x.eosID === 'p1');
  if (p1.dominantSquadID !== 0) {
    throw new Error(`null squadID should become 0 (unassigned), got ${p1.dominantSquadID}`);
  }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node testing/run-all-tests.js`
Expected: FAIL — `p1.segments[i].squadID` undefined, `p1.dominantSquadID` undefined.

- [ ] **Step 3: Modify `utils/elo-session-manager.js` to track squadID per segment**

In `updatePlayers`, when comparing the cached player to the incoming player, treat a `squadID` change exactly like a `teamID` change: close the current segment and start a new one. In segment objects add a `squadID` field. Null squadID is normalized to `0` (the in-game "no squad" sentinel).

The minimal diff (concept; match surrounding code style):

```javascript
// Inside updatePlayers, where teamID change is detected:
const cachedSquadID = cached.activeSegment?.squadID ?? null;
const incomingSquadID = player.squadID ?? 0;
const cachedTeamID = cached.activeSegment?.teamID ?? null;
const incomingTeamID = player.teamID ?? null;
if (cachedTeamID !== incomingTeamID || cachedSquadID !== incomingSquadID) {
  this._closeSegment(cached, timestamp);
  this._openSegment(cached, incomingTeamID, incomingSquadID, timestamp);
}
```

In `_openSegment` (or whatever the existing helper is called), accept and persist `squadID`:

```javascript
_openSegment(record, teamID, squadID, timestamp) {
  record.activeSegment = { teamID, squadID, joinTime: timestamp, leaveTime: null };
  record.segments.push(record.activeSegment);
}
```

In `endRound`, after the existing participation-ratio computation, compute `dominantSquadID` per player:

```javascript
// For each participant:
const timeBySquad = new Map();
for (const seg of record.segments) {
  if (seg.teamID !== assignedTeamID) continue; // only segments on assigned team
  const duration = (seg.leaveTime ?? roundEndTime) - seg.joinTime;
  const sid = seg.squadID ?? 0;
  timeBySquad.set(sid, (timeBySquad.get(sid) ?? 0) + duration);
}
let dominantSquadID = 0;
let dominantTime = -1;
for (const [sid, t] of timeBySquad) {
  if (t > dominantTime) { dominantTime = t; dominantSquadID = sid; }
}
participant.dominantSquadID = dominantSquadID;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node testing/run-all-tests.js`
Expected: PASS for all three new squad tests; all existing session-manager tests still PASS (in particular the null-teamID test, since squadID change handling must not break teamID-only changes).

- [ ] **Step 5: Commit**

```bash
git add utils/elo-session-manager.js testing/test-elo-session-manager.js
git commit -m "Track squadID per session segment; expose dominantSquadID"
```

---

## Task 3: Capture per-round kill, death, and quit data

**Files:**
- Modify: `plugins/elo-tracker.js` (subscribe to `PLAYER_DIED`; maintain per-round Maps; detect quit at round end)
- Modify: `testing/test-elo-tracker.js` (add kill/death/quit scenarios)

- [ ] **Step 1: Write the failing test**

Append to `testing/test-elo-tracker.js`:

```javascript
export async function testKillDeathCountedPerRound() {
  const tracker = await makeTrackerForTest(); // existing helper, or create minimal stub
  tracker.onNewGame({ time: 0 });
  tracker.session.updatePlayers([
    { eosID: 'a', name: 'A', steamID: 'sa', teamID: 1, squadID: 1 },
    { eosID: 'b', name: 'B', steamID: 'sb', teamID: 2, squadID: 1 }
  ], 0);
  // Simulate three PLAYER_DIED events: B kills A twice; A kills B once
  tracker.onPlayerDied({ victim: { eosID: 'a' }, attacker: { eosID: 'b' }, time: 1000 });
  tracker.onPlayerDied({ victim: { eosID: 'a' }, attacker: { eosID: 'b' }, time: 2000 });
  tracker.onPlayerDied({ victim: { eosID: 'b' }, attacker: { eosID: 'a' }, time: 3000 });
  if (tracker.killsByEosID.get('a') !== 1) throw new Error(`A should have 1 kill, got ${tracker.killsByEosID.get('a')}`);
  if (tracker.killsByEosID.get('b') !== 2) throw new Error(`B should have 2 kills, got ${tracker.killsByEosID.get('b')}`);
  if (tracker.deathsByEosID.get('a') !== 2) throw new Error(`A should have 2 deaths`);
  if (tracker.deathsByEosID.get('b') !== 1) throw new Error(`B should have 1 death`);
}

export async function testSuicideAndTeamkillNotCounted() {
  const tracker = await makeTrackerForTest();
  tracker.onNewGame({ time: 0 });
  tracker.session.updatePlayers([
    { eosID: 'a', name: 'A', steamID: 'sa', teamID: 1, squadID: 1 },
    { eosID: 'c', name: 'C', steamID: 'sc', teamID: 1, squadID: 1 }
  ], 0);
  // suicide: attacker == victim
  tracker.onPlayerDied({ victim: { eosID: 'a' }, attacker: { eosID: 'a' }, time: 1000 });
  // teamkill: same teamID
  tracker.onPlayerDied({ victim: { eosID: 'c' }, attacker: { eosID: 'a' }, time: 2000 });
  // A still earns a "death" for being killed (own action) — but no kill.
  if (tracker.killsByEosID.get('a')) throw new Error(`suicide/teamkill should not count as kill`);
  if (tracker.deathsByEosID.get('a') !== 1) throw new Error(`death-from-suicide still counted`);
  if (tracker.deathsByEosID.get('c') !== 1) throw new Error(`teamkill victim still has a death`);
}

export async function testKillDeathClearedOnNewGame() {
  const tracker = await makeTrackerForTest();
  tracker.onNewGame({ time: 0 });
  tracker.session.updatePlayers([{ eosID: 'a', name: 'A', steamID: 'sa', teamID: 1, squadID: 1 }], 0);
  tracker.onPlayerDied({ victim: { eosID: 'a' }, attacker: { eosID: 'b' }, time: 1000 });
  tracker.onNewGame({ time: 10000 });
  if (tracker.killsByEosID.size !== 0) throw new Error(`killsByEosID must be cleared on NEW_GAME`);
  if (tracker.deathsByEosID.size !== 0) throw new Error(`deathsByEosID must be cleared on NEW_GAME`);
}

export async function testQuitDetectedAtRoundEnd() {
  const tracker = await makeTrackerForTest();
  tracker.onNewGame({ time: 0 });
  tracker.session.updatePlayers([
    { eosID: 'q', name: 'Q', steamID: 'sq', teamID: 1, squadID: 1 },
    { eosID: 's', name: 'S', steamID: 'ss', teamID: 1, squadID: 1 }
  ], 0);
  // Q leaves at 30s out of 100s — participation 0.3, below 0.5 quit threshold
  tracker.session.updatePlayers([
    { eosID: 's', name: 'S', steamID: 'ss', teamID: 1, squadID: 1 }
  ], 30000);
  // Round ends at 100s. Q is absent at end AND participation < 0.5 ⇒ quit.
  const quitters = tracker._detectQuittersAt(100000);
  if (!quitters.has('q')) throw new Error(`Q should be detected as quitter`);
  if (quitters.has('s')) throw new Error(`S should NOT be a quitter (full round)`);
}
```

`makeTrackerForTest()` should produce a minimal tracker instance with `session`, `killsByEosID`, `deathsByEosID`, `onPlayerDied`, `onNewGame`, and `_detectQuittersAt`. If no such helper exists, create one in this test file that constructs a plain object with the necessary methods bound from a real `EloTracker` after stubbing out the SquadJS server/db dependencies.

- [ ] **Step 2: Run tests to verify they fail**

Run: `node testing/run-all-tests.js`
Expected: FAIL — `onPlayerDied`, `killsByEosID`, `deathsByEosID`, `_detectQuittersAt` all undefined.

- [ ] **Step 3: Wire `PLAYER_DIED` and quit detection in `plugins/elo-tracker.js`**

Add fields to the tracker constructor (next to `eloCache`):

```javascript
this.killsByEosID = new Map();
this.deathsByEosID = new Map();
this.lastSeenByEosID = new Map(); // eosID → last UPDATED_PLAYER_INFORMATION timestamp
```

In `mount()` (or wherever existing event handlers are bound), subscribe to `PLAYER_DIED`:

```javascript
this.server.on('PLAYER_DIED', this.onPlayerDied.bind(this));
```

Add the handler:

```javascript
onPlayerDied(data) {
  const victim = data?.victim;
  const attacker = data?.attacker;
  if (!victim?.eosID) return;
  // Always count the death (suicide counts; teamkill counts; team-damage counts).
  this.deathsByEosID.set(victim.eosID, (this.deathsByEosID.get(victim.eosID) ?? 0) + 1);

  if (!attacker?.eosID) return;
  if (attacker.eosID === victim.eosID) return;          // suicide: no kill credit
  if (attacker.teamID != null && attacker.teamID === victim.teamID) return; // teamkill: no kill credit
  this.killsByEosID.set(attacker.eosID, (this.killsByEosID.get(attacker.eosID) ?? 0) + 1);
}
```

In `onNewGame()`, clear the maps:

```javascript
this.killsByEosID.clear();
this.deathsByEosID.clear();
this.lastSeenByEosID.clear();
```

In `onUpdatedPlayerInfo()`, record `lastSeenByEosID.set(eosID, now)` for every player currently in `server.players`.

Add `_detectQuittersAt(roundEndTime)`:

```javascript
_detectQuittersAt(roundEndTime) {
  const quitters = new Set();
  const quitGraceMs = this.options.quitGraceSeconds * 1000; // default 60s
  const threshold = this.params.quitParticipationThreshold;
  for (const participant of this.session.snapshotParticipants(roundEndTime)) {
    if (participant.participationRatio >= threshold) continue;
    const lastSeen = this.lastSeenByEosID.get(participant.eosID) ?? 0;
    const absent = (roundEndTime - lastSeen) > quitGraceMs;
    if (absent) quitters.add(participant.eosID);
  }
  return quitters;
}
```

`session.snapshotParticipants(roundEndTime)` is a non-destructive read; if the session manager only exposes `endRound`, add a `snapshotParticipants(now)` helper that returns the same shape without finalizing the round. Tests in the next step exercise it through the public path.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node testing/run-all-tests.js`
Expected: PASS for the four new tracker tests; existing tracker tests still PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/elo-tracker.js utils/elo-session-manager.js testing/test-elo-tracker.js
git commit -m "Capture per-round kills, deaths, and quit detection"
```

---

## Task 4: Database schema additions for TrueSkill2 metadata

**Files:**
- Modify: `utils/elo-database.js` (extend `Elo_RoundPlayers` model; add a startup migration)
- Modify: `testing/test-elo-database.js` (verify columns exist and bulk insert works)

- [ ] **Step 1: Write the failing test**

Append to `testing/test-elo-database.js`:

```javascript
export async function testRoundPlayersHasTrueSkill2Columns() {
  const db = await openInMemoryTestDB(); // existing helper using sqlite::memory:
  await db.initialize();

  const row = {
    matchId: 'm1',
    roundStartTime: 1000,
    roundHistoryId: 1,
    eosID: 'p1', steamID: 's1', name: 'P1',
    teamID: 1, participationRatio: 0.9,
    squadID: 4, squadSize: 6,
    kills: 12, deaths: 3, quit: false, experienceBefore: 27,
    muBefore: 25, sigmaBefore: 8.33,
    rawDeltaMu: 0.5, rawDeltaSigma: 0.1,
    scaledDeltaMu: 0.45, scaledDeltaSigma: 0.09,
    muAfter: 25.45, sigmaAfter: 8.24
  };
  await db.insertRoundPlayers([row]);

  const read = await db.RoundPlayers.findOne({ where: { eosID: 'p1' } });
  if (read.squadID !== 4) throw new Error(`squadID column missing or wrong: ${read.squadID}`);
  if (read.squadSize !== 6) throw new Error(`squadSize column missing`);
  if (read.kills !== 12) throw new Error(`kills column missing`);
  if (read.deaths !== 3) throw new Error(`deaths column missing`);
  if (read.quit !== false && read.quit !== 0) throw new Error(`quit column missing`);
  if (read.experienceBefore !== 27) throw new Error(`experienceBefore column missing`);
}
```

If `openInMemoryTestDB` doesn't exist, mirror the existing pattern from `test-elo-database.js` and create a tiny factory that opens a fresh in-memory sqlite Sequelize instance.

- [ ] **Step 2: Run test to verify it fails**

Run: `node testing/run-all-tests.js`
Expected: FAIL — Sequelize raises "no such column: squadID" or similar.

- [ ] **Step 3: Add columns to the `Elo_RoundPlayers` model**

In `utils/elo-database.js`, locate the `Elo_RoundPlayers` model definition (per the codebase map this is around line 230–290) and add these columns inside the field block:

```javascript
squadID:           { type: DataTypes.INTEGER, allowNull: true },
squadSize:         { type: DataTypes.INTEGER, allowNull: true },
kills:             { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
deaths:            { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
quit:              { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
experienceBefore:  { type: DataTypes.INTEGER, allowNull: true },
```

- [ ] **Step 4: Add a startup migration for existing deployments**

The existing code uses `sync()` without `alter:true` (intentional — see commit `5f06177`). For TrueSkill2 we need additive column changes. Add an explicit one-time additive migration right after `sync()`. In the database initializer (after the existing `await sequelize.sync({ ... })` call):

```javascript
async function ensureTrueSkill2Columns(sequelize, logger) {
  const queryInterface = sequelize.getQueryInterface();
  const desc = await queryInterface.describeTable('Elo_RoundPlayers').catch(() => null);
  if (!desc) return; // table not present (logging disabled), nothing to do

  const addIfMissing = async (name, spec) => {
    if (!desc[name]) {
      await queryInterface.addColumn('Elo_RoundPlayers', name, spec);
      logger.verbose(`[Elo] added column Elo_RoundPlayers.${name}`);
    }
  };
  await addIfMissing('squadID',          { type: DataTypes.INTEGER, allowNull: true });
  await addIfMissing('squadSize',        { type: DataTypes.INTEGER, allowNull: true });
  await addIfMissing('kills',            { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
  await addIfMissing('deaths',           { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 });
  await addIfMissing('quit',             { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false });
  await addIfMissing('experienceBefore', { type: DataTypes.INTEGER, allowNull: true });
}
```

Call `ensureTrueSkill2Columns(this.sequelize, this.logger)` right after the existing `sync()`.

- [ ] **Step 5: Extend `insertRoundPlayers` to pass through new fields**

The existing `insertRoundPlayers(rows)` should already forward unknown fields to Sequelize. Verify by reading the method (around line 470–520 per the map). If it explicitly whitelists columns, add the new ones to the whitelist.

- [ ] **Step 6: Run tests to verify they pass**

Run: `node testing/run-all-tests.js`
Expected: PASS for the new column test; all existing DB tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add utils/elo-database.js testing/test-elo-database.js
git commit -m "Add TrueSkill2 columns to Elo_RoundPlayers with additive migration"
```

---

## Task 5: Gaussian primitives in natural parameter form

**Files:**
- Create: `utils/elo-trueskill2-factors.js` (start with primitives only)
- Create: `testing/test-elo-trueskill2-factors.js`

- [ ] **Step 1: Write the failing test**

```javascript
import {
  fromMuSigma, toMuSigma, combineMessages, EMPTY_MESSAGE
} from '../utils/elo-trueskill2-factors.js';

export async function testRoundTripMuSigma() {
  const g = fromMuSigma(25, 8.333);
  const { mu, sigma } = toMuSigma(g);
  if (Math.abs(mu - 25) > 1e-9) throw new Error(`mu round-trip failed: ${mu}`);
  if (Math.abs(sigma - 8.333) > 1e-9) throw new Error(`sigma round-trip failed: ${sigma}`);
}

export async function testEmptyMessageIsIdentity() {
  const prior = fromMuSigma(20, 5);
  const post = combineMessages(prior, [EMPTY_MESSAGE]);
  const { mu, sigma } = toMuSigma(post);
  if (Math.abs(mu - 20) > 1e-9) throw new Error(`empty message changed mu`);
  if (Math.abs(sigma - 5) > 1e-9) throw new Error(`empty message changed sigma`);
}

export async function testCombiningTwoMessagesAddsPrecision() {
  // Prior: N(0, 1). Two identical observations N(2, 1) each shift the posterior to N(4/3, ...)
  const prior = fromMuSigma(0, 1);
  // A Gaussian observation N(2, 1) on the variable contributes precision 1 and prec-mean 2.
  const msg = { deltaPrecision: 1, deltaPrecisionMean: 2 };
  const post = combineMessages(prior, [msg, msg]);
  const { mu, sigma } = toMuSigma(post);
  // posterior precision = 1 + 1 + 1 = 3, posterior prec-mean = 0 + 2 + 2 = 4
  // ⇒ mu = 4/3, sigma² = 1/3 ⇒ sigma ≈ 0.5774
  if (Math.abs(mu - 4 / 3) > 1e-9) throw new Error(`mu mismatch: ${mu}`);
  if (Math.abs(sigma - Math.sqrt(1 / 3)) > 1e-9) throw new Error(`sigma mismatch: ${sigma}`);
}

export async function testNegativePrecisionMessageWidensPosterior() {
  // EP can yield negative precision messages when a factor is "uncertain enough."
  // The combiner must accept them as long as the posterior precision stays > 0.
  const prior = fromMuSigma(0, 1); // precision 1
  const msg = { deltaPrecision: -0.5, deltaPrecisionMean: 0 };
  const post = combineMessages(prior, [msg]);
  const { sigma } = toMuSigma(post);
  // posterior precision = 0.5 ⇒ sigma² = 2 ⇒ sigma = √2
  if (Math.abs(sigma - Math.sqrt(2)) > 1e-9) throw new Error(`sigma mismatch: ${sigma}`);
}

export async function testNonPositivePosteriorPrecisionThrows() {
  const prior = fromMuSigma(0, 1); // precision 1
  let threw = false;
  try {
    combineMessages(prior, [{ deltaPrecision: -1.5, deltaPrecisionMean: 0 }]);
  } catch (e) { threw = true; }
  if (!threw) throw new Error(`combineMessages must throw if posterior precision ≤ 0`);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node testing/run-all-tests.js`
Expected: FAIL — `utils/elo-trueskill2-factors.js` doesn't exist.

- [ ] **Step 3: Implement primitives in `utils/elo-trueskill2-factors.js`**

```javascript
/**
 * TrueSkill2 factor library.
 *
 * Gaussian representation: natural-parameter form
 *   precision π     = 1 / σ²
 *   precision-mean τ = μ / σ²
 * which is closed under multiplication (the EP operation).
 *
 * A "message" is a Gaussian in natural form, with the convention that
 * `combineMessages(prior, [m1, m2, ...])` computes
 *     posterior.π = prior.π + Σ mᵢ.deltaPrecision
 *     posterior.τ = prior.τ + Σ mᵢ.deltaPrecisionMean
 */

export const EMPTY_MESSAGE = Object.freeze({ deltaPrecision: 0, deltaPrecisionMean: 0 });

export function fromMuSigma(mu, sigma) {
  if (!(sigma > 0)) throw new Error(`sigma must be > 0, got ${sigma}`);
  const precision = 1 / (sigma * sigma);
  return { precision, precisionMean: mu * precision };
}

export function toMuSigma(g) {
  if (!(g.precision > 0)) {
    throw new Error(`Gaussian precision must be > 0, got ${g.precision}`);
  }
  const sigma = Math.sqrt(1 / g.precision);
  const mu = g.precisionMean / g.precision;
  return { mu, sigma };
}

export function combineMessages(prior, messages) {
  let precision = prior.precision;
  let precisionMean = prior.precisionMean;
  for (const m of messages) {
    precision += m.deltaPrecision;
    precisionMean += m.deltaPrecisionMean;
  }
  if (!(precision > 0)) {
    throw new Error(`posterior precision ≤ 0 (${precision}); factor message instability`);
  }
  return { precision, precisionMean };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node testing/run-all-tests.js`
Expected: PASS for all five primitives tests.

- [ ] **Step 5: Commit**

```bash
git add utils/elo-trueskill2-factors.js testing/test-elo-trueskill2-factors.js
git commit -m "Add Gaussian primitives in natural-parameter form for TrueSkill2"
```

---

## Task 6: Refactor team factor into the new engine (no behavioural change)

**Files:**
- Create: `utils/elo-trueskill2-engine.js`
- Modify: `utils/elo-trueskill2-factors.js` (add `teamFactorMessages`)
- Modify: `utils/elo-calculator.js` (`computeTeamUpdate` becomes a wrapper)
- Create: `testing/test-elo-trueskill2-engine.js`

This is a **behaviour-preserving refactor**. After this task, every existing `EloCalculator` test still passes byte-identical results.

- [ ] **Step 1: Write the failing equivalence test**

Create `testing/test-elo-trueskill2-engine.js`:

```javascript
import EloCalculator from '../utils/elo-calculator.js';
import { computeRoundUpdate } from '../utils/elo-trueskill2-engine.js';
import { DEFAULT_PARAMETERS } from '../utils/elo-parameters.js';

function makeTeam(n, mu, sigma, ratio = 1.0) {
  return Array.from({ length: n }, (_, i) => ({
    eosID: `t${mu}_${i}`,
    mu, sigma, participationRatio: ratio
  }));
}

function nearlyEqual(a, b, eps = 1e-6) {
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
}

export async function testEngineMatchesCalculator_1v1Win() {
  const team1 = [{ eosID: 'a', mu: 25, sigma: 8.333, participationRatio: 1 }];
  const team2 = [{ eosID: 'b', mu: 25, sigma: 8.333, participationRatio: 1 }];

  const legacy = EloCalculator.computeTeamUpdate(team1, team2, 'team1win');
  const engine = computeRoundUpdate(team1, team2, 'team1win', {}, DEFAULT_PARAMETERS);

  if (!nearlyEqual(legacy.team1Updates[0].deltaMu, engine.team1Updates[0].deltaMu)) {
    throw new Error(`team1 deltaMu mismatch: legacy=${legacy.team1Updates[0].deltaMu}, engine=${engine.team1Updates[0].deltaMu}`);
  }
  if (!nearlyEqual(legacy.team1Updates[0].deltaSigma, engine.team1Updates[0].deltaSigma)) {
    throw new Error(`team1 deltaSigma mismatch`);
  }
  if (!nearlyEqual(legacy.team2Updates[0].deltaMu, engine.team2Updates[0].deltaMu)) {
    throw new Error(`team2 deltaMu mismatch`);
  }
}

export async function testEngineMatchesCalculator_AsymmetricTeams() {
  const team1 = [
    ...makeTeam(3, 30, 5),
    ...makeTeam(2, 20, 8, 0.5)
  ];
  const team2 = makeTeam(5, 25, 7);
  const legacy = EloCalculator.computeTeamUpdate(team1, team2, 'team2win');
  const engine = computeRoundUpdate(team1, team2, 'team2win', {}, DEFAULT_PARAMETERS);
  for (let i = 0; i < team1.length; i++) {
    if (!nearlyEqual(legacy.team1Updates[i].deltaMu, engine.team1Updates[i].deltaMu, 1e-5)) {
      throw new Error(`team1[${i}] deltaMu mismatch: ${legacy.team1Updates[i].deltaMu} vs ${engine.team1Updates[i].deltaMu}`);
    }
    if (!nearlyEqual(legacy.team1Updates[i].deltaSigma, engine.team1Updates[i].deltaSigma, 1e-5)) {
      throw new Error(`team1[${i}] deltaSigma mismatch`);
    }
  }
}

export async function testEngineMatchesCalculator_Draw() {
  const team1 = makeTeam(4, 27, 6);
  const team2 = makeTeam(4, 23, 6);
  const legacy = EloCalculator.computeTeamUpdate(team1, team2, 'draw');
  const engine = computeRoundUpdate(team1, team2, 'draw', {}, DEFAULT_PARAMETERS);
  for (let i = 0; i < team1.length; i++) {
    if (!nearlyEqual(legacy.team1Updates[i].deltaMu, engine.team1Updates[i].deltaMu, 1e-5)) {
      throw new Error(`draw team1[${i}] deltaMu mismatch`);
    }
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node testing/run-all-tests.js`
Expected: FAIL — `computeRoundUpdate` does not exist.

- [ ] **Step 3: Add `teamFactorMessages` to the factor library**

Append to `utils/elo-trueskill2-factors.js`:

```javascript
import EloCalculator from './elo-calculator.js'; // for _pdf/_cdf/_erfInv/_v/_w/_vDraw/_wDraw

/**
 * Compute the team-factor messages to each player's skill variable.
 * This is the existing TrueSkill team-comparison update expressed as a
 * natural-form message (deltaPrecision, deltaPrecisionMean).
 *
 * Inputs preserve the existing legacy `computeTeamUpdate` semantics:
 *   - `team1`, `team2` arrays of { mu, sigma, participationRatio }
 *   - `outcome` ∈ { 'team1win', 'team2win', 'draw' }
 *   - `parameters` provides beta, drawProbability, and optional squad mean shift
 *
 * Optional `teamMeta` (per team) carries:
 *   { meanShift }   — total additive shift on teamMu (used by squad-offset factor)
 *
 * Returns: { team1Messages: [...], team2Messages: [...], teamMu1, teamMu2, c, debug }
 */
export function teamFactorMessages(team1, team2, outcome, parameters, teamMeta = {}) {
  const beta = parameters.beta;
  const drawP = parameters.drawProbability;

  if (team1.length === 0 && team2.length === 0) {
    return {
      team1Messages: [], team2Messages: [],
      teamMu1: 0, teamMu2: 0, c: 0,
      debug: { effectiveN1: 0, effectiveN2: 0 }
    };
  }

  const getRatio = (p) => p.participationRatio ?? 1.0;
  let effectiveN1 = team1.reduce((s, p) => s + getRatio(p), 0);
  let effectiveN2 = team2.reduce((s, p) => s + getRatio(p), 0);
  const scale1 = effectiveN1 > 50.0 ? 50.0 / effectiveN1 : 1.0;
  const scale2 = effectiveN2 > 50.0 ? 50.0 / effectiveN2 : 1.0;
  effectiveN1 *= scale1;
  effectiveN2 *= scale2;

  const meanShift1 = teamMeta.team1?.meanShift ?? 0;
  const meanShift2 = teamMeta.team2?.meanShift ?? 0;

  const teamMu1 = team1.reduce((s, p) => s + p.mu * getRatio(p), 0) * scale1 + meanShift1;
  const teamMu2 = team2.reduce((s, p) => s + p.mu * getRatio(p), 0) * scale2 + meanShift2;
  const teamSig1 = team1.reduce((s, p) => s + (p.sigma * p.sigma + beta * beta) * getRatio(p), 0) * scale1;
  const teamSig2 = team2.reduce((s, p) => s + (p.sigma * p.sigma + beta * beta) * getRatio(p), 0) * scale2;
  const c = Math.sqrt(teamSig1 + teamSig2);

  if (c === 0) {
    return {
      team1Messages: team1.map(() => EMPTY_MESSAGE),
      team2Messages: team2.map(() => EMPTY_MESSAGE),
      teamMu1, teamMu2, c,
      debug: { effectiveN1, effectiveN2 }
    };
  }

  const nTotal = effectiveN1 + effectiveN2;
  const epsilon = Math.sqrt(nTotal) * beta * Math.sqrt(2) * EloCalculator._erfInv(drawP);
  const tRaw = (teamMu1 - teamMu2) / c;

  const buildMessage = (player, isTeam1) => {
    const sigmaSq = player.sigma * player.sigma;
    let vVal, wVal, isWinner = null;
    if (outcome === 'draw') {
      const t = isTeam1 ? tRaw : -tRaw;
      vVal = EloCalculator._vDraw(t, epsilon / c);
      wVal = EloCalculator._wDraw(t, epsilon / c);
    } else {
      const tWinner = outcome === 'team1win' ? tRaw : -tRaw;
      isWinner = outcome === 'team1win' ? isTeam1 : !isTeam1;
      vVal = EloCalculator._v(tWinner, epsilon / c);
      wVal = EloCalculator._w(tWinner, epsilon / c);
    }
    let deltaMu = (sigmaSq / c) * vVal;
    if (outcome !== 'draw' && !isWinner) deltaMu = -deltaMu;
    const deltaSigmaFactor = Math.min((sigmaSq / (c * c)) * wVal, 1 - 1e-10);
    const newSigmaSq = sigmaSq * (1 - deltaSigmaFactor) + parameters.tau * parameters.tau;
    const newMu = player.mu + deltaMu;

    // Convert the (mu, sigma) update into a natural-form message:
    //   posterior precision = 1/newSigmaSq
    //   message deltaPrecision = posterior precision − prior precision
    //   message deltaPrecisionMean = newMu·posterior_precision − prior precision·prior mu
    const priorPrec = 1 / sigmaSq;
    const postPrec = 1 / newSigmaSq;
    return {
      deltaPrecision: postPrec - priorPrec,
      deltaPrecisionMean: newMu * postPrec - player.mu * priorPrec,
      _legacyDeltaMu: deltaMu,
      _legacyDeltaSigma: player.sigma - Math.sqrt(newSigmaSq),
      _vVal: vVal,
      _wVal: wVal
    };
  };

  return {
    team1Messages: team1.map(p => buildMessage(p, true)),
    team2Messages: team2.map(p => buildMessage(p, false)),
    teamMu1, teamMu2, c,
    debug: { effectiveN1, effectiveN2, nTotal, epsilon, tRaw }
  };
}
```

- [ ] **Step 4: Implement `utils/elo-trueskill2-engine.js`**

```javascript
import {
  fromMuSigma, toMuSigma, combineMessages, teamFactorMessages
} from './elo-trueskill2-factors.js';

/**
 * Run a single round through the TrueSkill2 inference pipeline.
 *
 * @param {Array<{eosID, mu, sigma, participationRatio}>} team1
 * @param {Array<{eosID, mu, sigma, participationRatio}>} team2
 * @param {'team1win'|'team2win'|'draw'} outcome
 * @param {Object} perPlayerMeta  Map of eosID → { squadSize, squadID, kills, deaths, quit, experience, timePlayed }
 * @param {Object} parameters     Frozen object from elo-parameters.js
 *
 * @returns {{
 *   team1Updates: Array<{deltaMu, deltaSigma}>,
 *   team2Updates: Array<{deltaMu, deltaSigma}>,
 *   debug
 * }}
 *
 * `deltaMu` and `deltaSigma` use the legacy convention: caller scales by
 * participationRatio, then sets newMu = mu + deltaMu, newSigma = sigma - deltaSigma.
 */
export function computeRoundUpdate(team1, team2, outcome, perPlayerMeta, parameters) {
  // === Phase A: team factor (existing behaviour) ===
  // Future tasks will compute teamMeta.meanShift from squad-offset / experience factors
  // and pass per-player additional factor messages (kill, death, quit) into combineMessages.
  const teamMeta = {}; // populated in later tasks
  const {
    team1Messages, team2Messages, debug
  } = teamFactorMessages(team1, team2, outcome, parameters, teamMeta);

  const buildUpdate = (player, message) => {
    const prior = fromMuSigma(player.mu, player.sigma);
    const posterior = combineMessages(prior, [message]);
    const { mu, sigma } = toMuSigma(posterior);
    return {
      deltaMu: mu - player.mu,
      deltaSigma: player.sigma - sigma,
      vVal: message._vVal ?? 0,
      wVal: message._wVal ?? 0
    };
  };

  return {
    team1Updates: team1.map((p, i) => buildUpdate(p, team1Messages[i])),
    team2Updates: team2.map((p, i) => buildUpdate(p, team2Messages[i])),
    debug
  };
}
```

- [ ] **Step 5: Extract Gaussian helpers into `utils/elo-gauss.js`**

To break the circular import that would arise (factors → calculator → engine → factors), move the pure-math helpers out of the calculator into a new module. Create `utils/elo-gauss.js`:

```javascript
export function pdf(x) {
  return (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x);
}

export function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return sign * y;
}

export function cdf(x) {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

export function erfInv(x) {
  const a = 0.147;
  const lnTerm = Math.log(1 - x * x);
  const term1 = 2 / (Math.PI * a) + lnTerm / 2;
  const term2 = lnTerm / a;
  const sign = x < 0 ? -1 : 1;
  return sign * Math.sqrt(Math.sqrt(term1 * term1 - term2) - term1);
}

export function v(t, e) {
  const denom = cdf(t - e);
  if (denom === 0) return 0;
  return pdf(t - e) / denom;
}

export function w(t, e) {
  const vVal = v(t, e);
  return vVal * (vVal + t - e);
}

export function vDraw(t, e) {
  const absDiff = cdf(e - t) - cdf(-e - t);
  if (absDiff === 0) return 0;
  return (pdf(-e - t) - pdf(e - t)) / absDiff;
}

export function wDraw(t, e) {
  const vd = vDraw(t, e);
  const absDiff = cdf(e - t) - cdf(-e - t);
  if (absDiff === 0) return vd * vd;
  const term = ((e - t) * pdf(e - t) - (-e - t) * pdf(-e - t)) / absDiff;
  return vd * vd + term;
}
```

Rewrite `utils/elo-calculator.js` to keep its public API as thin wrappers (so existing callers keep working):

```javascript
import * as gauss from './elo-gauss.js';
import { computeRoundUpdate } from './elo-trueskill2-engine.js';

export default class EloCalculator {
  static MU_DEFAULT = 25.0;
  static SIGMA_DEFAULT = 25.0 / 3.0;
  static TAU = 25.0 / 100.0;
  static BETA = 25.0 / 6.0;
  static DRAW_PROBABILITY = 0.01;
  static SIGMA_MULTIPLIER = 3.0;

  static _pdf(x)       { return gauss.pdf(x); }
  static _cdf(x)       { return gauss.cdf(x); }
  static _erf(x)       { return gauss.erf(x); }
  static _erfInv(x)    { return gauss.erfInv(x); }
  static _v(t, e)      { return gauss.v(t, e); }
  static _w(t, e)      { return gauss.w(t, e); }
  static _vDraw(t, e)  { return gauss.vDraw(t, e); }
  static _wDraw(t, e)  { return gauss.wDraw(t, e); }

  static computeTeamUpdate(team1, team2, outcome) {
    const params = {
      beta: this.BETA,
      tau: this.TAU,
      drawProbability: this.DRAW_PROBABILITY
    };
    return computeRoundUpdate(team1, team2, outcome, {}, params);
  }

  static getDefaultRating() {
    return { mu: this.MU_DEFAULT, sigma: this.SIGMA_DEFAULT };
  }
}
```

In `utils/elo-trueskill2-factors.js`, replace the `import EloCalculator` line at the top of Step 3 with:

```javascript
import * as gauss from './elo-gauss.js';
```

…and inside `teamFactorMessages`, replace `EloCalculator._erfInv(drawP)` with `gauss.erfInv(drawP)`, `EloCalculator._vDraw(...)` with `gauss.vDraw(...)`, `EloCalculator._wDraw(...)` with `gauss.wDraw(...)`, `EloCalculator._v(...)` with `gauss.v(...)`, `EloCalculator._w(...)` with `gauss.w(...)`.

- [ ] **Step 6: Run all tests to verify behavioural equivalence**

Run: `node testing/run-all-tests.js`
Expected: PASS for all three engine equivalence tests AND every single pre-existing test in `test-elo-calculator.js` / `test-elo-simulation.js` / `test-elo-tracker.js` / `test-elo-database.js`. If any pre-existing test regresses, the engine refactor is wrong — do NOT proceed.

- [ ] **Step 7: Commit**

```bash
git add utils/elo-calculator.js utils/elo-gauss.js utils/elo-trueskill2-engine.js utils/elo-trueskill2-factors.js testing/test-elo-trueskill2-engine.js
git commit -m "Refactor TrueSkill team update into factor + engine modules"
```

---

## Task 7: Squad-offset factor (paper Section 6, equation 7)

**Files:**
- Modify: `utils/elo-trueskill2-engine.js` (compute `teamMeta.team1.meanShift` from squad sizes)
- Modify: `testing/test-elo-trueskill2-engine.js` (new tests)

**Math:** Equation 7 is `perf_i ~ N(skill_i + squadOffset(size), β²)`. In a team game, the team's mean performance is the sum of player performances weighted by `timePlayed_i/L`. The squad offsets shift each player's performance mean by `squadOffset(size_i)`. The collective effect on `teamMu` is `Σ squadOffset(size_i) · participationRatio_i`, scaled by the same `scale1` factor the engine already applies. Variance is unchanged. So this is purely a mean-shift on each side.

- [ ] **Step 1: Write the failing test**

```javascript
import { DEFAULT_PARAMETERS, loadParameters } from '../utils/elo-parameters.js';

// Squad offsets are NEUTRAL in DEFAULT_PARAMETERS; these tests opt-in explicitly.
const TUNED = loadParameters({
  squadOffsets: [0, 0, 0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5]
});

export async function testSquadOffsetBoostsLargeSquadExpectedWin() {
  // Two teams of 4 with identical mu; team1 has all 4 in one squad of 4 (squadOffset[3]>0),
  // team2 has 4 solos (squadOffset[0]=0). Engine should predict team1 favourite,
  // so a team1 win yields a SMALLER deltaMu than the symmetric case.
  const team1 = Array.from({ length: 4 }, (_, i) => ({
    eosID: `t1_${i}`, mu: 25, sigma: 8.333, participationRatio: 1
  }));
  const team2 = Array.from({ length: 4 }, (_, i) => ({
    eosID: `t2_${i}`, mu: 25, sigma: 8.333, participationRatio: 1
  }));
  const meta = {
    t1_0: { squadSize: 4 }, t1_1: { squadSize: 4 }, t1_2: { squadSize: 4 }, t1_3: { squadSize: 4 },
    t2_0: { squadSize: 1 }, t2_1: { squadSize: 1 }, t2_2: { squadSize: 1 }, t2_3: { squadSize: 1 }
  };

  const baseline = computeRoundUpdate(team1, team2, 'team1win', {}, TUNED);
  const withSquads = computeRoundUpdate(team1, team2, 'team1win', meta, TUNED);

  if (withSquads.team1Updates[0].deltaMu >= baseline.team1Updates[0].deltaMu) {
    throw new Error(`expected smaller deltaMu when team1 is favoured by squad offset`);
  }
}

export async function testSquadOffsetPenalisesLargeSquadOnLoss() {
  const team1 = Array.from({ length: 4 }, (_, i) => ({ eosID: `t1_${i}`, mu: 25, sigma: 8.333, participationRatio: 1 }));
  const team2 = Array.from({ length: 4 }, (_, i) => ({ eosID: `t2_${i}`, mu: 25, sigma: 8.333, participationRatio: 1 }));
  const meta = {
    t1_0: { squadSize: 4 }, t1_1: { squadSize: 4 }, t1_2: { squadSize: 4 }, t1_3: { squadSize: 4 },
    t2_0: { squadSize: 1 }, t2_1: { squadSize: 1 }, t2_2: { squadSize: 1 }, t2_3: { squadSize: 1 }
  };
  const baseline = computeRoundUpdate(team1, team2, 'team2win', {}, TUNED);
  const withSquads = computeRoundUpdate(team1, team2, 'team2win', meta, TUNED);

  // Team1 lost despite squad advantage ⇒ they SHOULD lose more rating.
  if (withSquads.team1Updates[0].deltaMu >= baseline.team1Updates[0].deltaMu) {
    throw new Error(`team1 (favoured) losing should yield a more-negative deltaMu`);
  }
}

export async function testSquadOffsetZeroForSolos() {
  const team1 = [{ eosID: 'a', mu: 25, sigma: 8.333, participationRatio: 1 }];
  const team2 = [{ eosID: 'b', mu: 25, sigma: 8.333, participationRatio: 1 }];
  const meta = { a: { squadSize: 1 }, b: { squadSize: 1 } };
  const baseline = computeRoundUpdate(team1, team2, 'team1win', {}, TUNED);
  const withMeta = computeRoundUpdate(team1, team2, 'team1win', meta, TUNED);
  if (Math.abs(baseline.team1Updates[0].deltaMu - withMeta.team1Updates[0].deltaMu) > 1e-9) {
    throw new Error(`squadSize=1 should match baseline exactly (squadOffsets[0] === 0)`);
  }
}

export async function testNeutralDefaultsDisableSquadOffset() {
  // Sanity check: DEFAULT_PARAMETERS keeps Task 6's equivalence test valid.
  const team1 = [{ eosID: 'a', mu: 25, sigma: 8.333, participationRatio: 1 }];
  const team2 = [{ eosID: 'b', mu: 25, sigma: 8.333, participationRatio: 1 }];
  const r0 = computeRoundUpdate(team1, team2, 'team1win', {}, DEFAULT_PARAMETERS);
  const r1 = computeRoundUpdate(team1, team2, 'team1win',
    { a: { squadSize: 4 }, b: { squadSize: 1 } }, DEFAULT_PARAMETERS);
  if (Math.abs(r0.team1Updates[0].deltaMu - r1.team1Updates[0].deltaMu) > 1e-9) {
    throw new Error(`with neutral DEFAULT_PARAMETERS, squadSize must have no effect`);
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node testing/run-all-tests.js`
Expected: FAIL — currently `computeRoundUpdate` ignores `perPlayerMeta`.

- [ ] **Step 3: Compute the squad mean shift in the engine**

In `utils/elo-trueskill2-engine.js`, before calling `teamFactorMessages`, build `teamMeta`:

```javascript
function squadMeanShift(team, perPlayerMeta, parameters) {
  let shift = 0;
  let effectiveN = 0;
  for (const p of team) {
    const ratio = p.participationRatio ?? 1.0;
    effectiveN += ratio;
    const size = perPlayerMeta[p.eosID]?.squadSize ?? 1;
    const idx = Math.min(Math.max(size - 1, 0), parameters.squadOffsets.length - 1);
    shift += parameters.squadOffsets[idx] * ratio;
  }
  const scale = effectiveN > 50.0 ? 50.0 / effectiveN : 1.0;
  return shift * scale;
}

// inside computeRoundUpdate, before teamFactorMessages:
const teamMeta = {
  team1: { meanShift: squadMeanShift(team1, perPlayerMeta, parameters) },
  team2: { meanShift: squadMeanShift(team2, perPlayerMeta, parameters) }
};
```

Pass `teamMeta` through to `teamFactorMessages`. (The function already accepts and applies it.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `node testing/run-all-tests.js`
Expected: PASS for the three squad-offset tests; all earlier tests still PASS (the empty-meta path keeps shift=0 ⇒ identical to baseline).

- [ ] **Step 5: Wire `squadSize` from session manager into the plugin**

In `plugins/elo-tracker.js`, where the plugin builds the `team1Eligible.map(p => ...)` array before calling the engine, compute squad sizes:

```javascript
// After endRound(): participants has dominantSquadID per player. squad size = count of
// participants sharing the same (assignedTeamID, dominantSquadID), with squad 0 (no squad) treated as size 1.
function squadSizeOf(participant, allParticipants) {
  if (!participant.dominantSquadID || participant.dominantSquadID === 0) return 1;
  return allParticipants.filter(q =>
    q.assignedTeamID === participant.assignedTeamID &&
    q.dominantSquadID === participant.dominantSquadID
  ).length;
}

const perPlayerMeta = {};
for (const p of participants) {
  perPlayerMeta[p.eosID] = {
    squadID: p.dominantSquadID,
    squadSize: squadSizeOf(p, participants)
    // (kills, deaths, quit, experience filled in subsequent tasks)
  };
}
// then:
const result = computeRoundUpdate(team1Arr, team2Arr, outcome, perPlayerMeta, parameters);
```

- [ ] **Step 6: Run all tests to verify integration**

Run: `node testing/run-all-tests.js`
Expected: PASS across the board.

- [ ] **Step 7: Commit**

```bash
git add utils/elo-trueskill2-engine.js plugins/elo-tracker.js testing/test-elo-trueskill2-engine.js
git commit -m "Add squad-offset factor (paper eq. 7)"
```

---

## Task 8: Experience offset (paper Section 7, equation 8)

**Files:**
- Modify: `utils/elo-trueskill2-engine.js` (apply experience drift to mu after main update)
- Modify: `plugins/elo-tracker.js` (pass `experience = roundsPlayed` per player)
- Modify: `testing/test-elo-trueskill2-engine.js` (new tests)

**Math:** Equation 8 replaces the per-match dynamics `skill^{t+L} ~ N(skill^t, γ²)` with `skill^{t+L} ~ N(skill^t + experienceOffset(min(experience^t, 200)), γ²)`. Operationally: after the team factor produces the posterior on skill_i for the match, we add `experienceOffset(experience)` to `mu` (variance is unchanged). This applies regardless of win/loss.

- [ ] **Step 1: Write the failing test**

```javascript
import { DEFAULT_PARAMETERS, loadParameters } from '../utils/elo-parameters.js';

// Experience offsets are NEUTRAL in DEFAULT_PARAMETERS; opt-in here.
const TUNED_EXP = loadParameters({
  experienceOffsets: Array.from({ length: 200 }, (_, i) =>
    i < 50 ? 1.0 * (1 - i / 50) : 0
  )
});

export async function testExperienceOffsetAddsPositiveDriftForNewPlayer() {
  const newPlayer = [{ eosID: 'n', mu: 25, sigma: 8.333, participationRatio: 1 }];
  const opp       = [{ eosID: 'o', mu: 25, sigma: 8.333, participationRatio: 1 }];
  const metaNew = { n: { experience: 0,   squadSize: 1 }, o: { experience: 100, squadSize: 1 } };
  const metaExp = { n: { experience: 100, squadSize: 1 }, o: { experience: 100, squadSize: 1 } };

  const r1 = computeRoundUpdate(newPlayer, opp, 'team2win', metaNew, TUNED_EXP);
  const r2 = computeRoundUpdate(newPlayer, opp, 'team2win', metaExp, TUNED_EXP);

  // Both lose, but the new player loses LESS because their experience offset
  // is positive (added back after the match).
  if (r1.team1Updates[0].deltaMu <= r2.team1Updates[0].deltaMu) {
    throw new Error(`new-player drop should be smaller (more positive) than experienced-player drop`);
  }
}

export async function testExperienceOffsetCappedAt200() {
  const a = [{ eosID: 'a', mu: 25, sigma: 8.333, participationRatio: 1 }];
  const b = [{ eosID: 'b', mu: 25, sigma: 8.333, participationRatio: 1 }];
  const meta200 = { a: { experience: 200,  squadSize: 1 }, b: { experience: 200,  squadSize: 1 } };
  const meta5000 = { a: { experience: 5000, squadSize: 1 }, b: { experience: 5000, squadSize: 1 } };
  const r1 = computeRoundUpdate(a, b, 'team1win', meta200,  TUNED_EXP);
  const r2 = computeRoundUpdate(a, b, 'team1win', meta5000, TUNED_EXP);
  if (Math.abs(r1.team1Updates[0].deltaMu - r2.team1Updates[0].deltaMu) > 1e-9) {
    throw new Error(`experience > 200 must not change the update further`);
  }
}

export async function testNeutralDefaultsDisableExperienceOffset() {
  const a = [{ eosID: 'a', mu: 25, sigma: 8.333, participationRatio: 1 }];
  const b = [{ eosID: 'b', mu: 25, sigma: 8.333, participationRatio: 1 }];
  const r0 = computeRoundUpdate(a, b, 'team1win', {}, DEFAULT_PARAMETERS);
  const r1 = computeRoundUpdate(a, b, 'team1win',
    { a: { experience: 0, squadSize: 1 }, b: { experience: 0, squadSize: 1 } },
    DEFAULT_PARAMETERS);
  if (Math.abs(r0.team1Updates[0].deltaMu - r1.team1Updates[0].deltaMu) > 1e-9) {
    throw new Error(`neutral DEFAULT_PARAMETERS must give no experience drift`);
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node testing/run-all-tests.js`
Expected: FAIL — engine does not apply experience drift.

- [ ] **Step 3: Apply experience offset after the main update in the engine**

Modify the `buildUpdate` function inside `computeRoundUpdate`:

```javascript
const buildUpdate = (player, message) => {
  const prior = fromMuSigma(player.mu, player.sigma);
  const posterior = combineMessages(prior, [message]);
  let { mu, sigma } = toMuSigma(posterior);

  // Experience offset (paper eq. 8): biased random walk on skill after the match.
  const exp = perPlayerMeta[player.eosID]?.experience ?? 0;
  const idx = Math.min(Math.max(exp, 0), parameters.experienceOffsets.length - 1);
  mu += parameters.experienceOffsets[idx];

  return {
    deltaMu: mu - player.mu,
    deltaSigma: player.sigma - sigma,
    vVal: message._vVal ?? 0,
    wVal: message._wVal ?? 0
  };
};
```

- [ ] **Step 4: Wire `experience` from the plugin**

In `plugins/elo-tracker.js`, when building `perPlayerMeta`:

```javascript
perPlayerMeta[p.eosID] = {
  squadID:    p.dominantSquadID,
  squadSize:  squadSizeOf(p, participants),
  experience: this.eloCache.get(p.eosID)?.roundsPlayed ?? 0
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node testing/run-all-tests.js`
Expected: PASS for the three experience tests and all earlier tests.

- [ ] **Step 6: Commit**

```bash
git add utils/elo-trueskill2-engine.js plugins/elo-tracker.js testing/test-elo-trueskill2-engine.js
git commit -m "Add experience offset (paper eq. 8)"
```

---

## Task 9: Quit-penalty factor (paper Section 9)

**Files:**
- Modify: `utils/elo-trueskill2-factors.js` (add `quitFactorMessage`)
- Modify: `utils/elo-trueskill2-engine.js` (apply quit messages alongside the team message)
- Modify: `plugins/elo-tracker.js` (pass `quit` flag in perPlayerMeta)
- Modify: `testing/test-elo-trueskill2-engine.js` (new tests)

**Math (online interpretation, paper Section 9 last paragraphs):** A quit is treated as an additional observation `perf_i - perf_o_i < m_q` with Gaussian noise `v_q`. The opposing-team performance for player i is `perf_o_i = (Σ_{j∈enemy} ratio_j · perf_j)`. We approximate `perf_o_i ~ N(teamMu_other, teamSigmaSq_other)` (Gaussian sum, using the same effective-N scaling as the team factor). The "mini-game" comparison variable D = perf_i - perf_o_i has:

```
E[D]    = mu_i - teamMu_other_per_player_equivalent
Var[D]  = sigma_i² + β² + (teamSigmaSq_other / effectiveN_other) + v_q
```

Observing D < m_q yields a one-sided truncation. The EP message on skill_i is a (Δπ, Δτ) computed via the same `v(t)` / `w(t)` functions, with `t = (E[D] − m_q) / √Var[D]`, treating the observation as a "loss" for the quitter.

- [ ] **Step 1: Write the failing test**

```javascript
export async function testQuitterLosesExtraRatingComparedToCompleter() {
  // Two identical teams of 4. Team1 wins. In one scenario player t1_3 quit early.
  const team1 = Array.from({ length: 4 }, (_, i) => ({ eosID: `t1_${i}`, mu: 25, sigma: 8.333, participationRatio: 1 }));
  const team2 = Array.from({ length: 4 }, (_, i) => ({ eosID: `t2_${i}`, mu: 25, sigma: 8.333, participationRatio: 1 }));
  const meta = { t1_0: { squadSize: 1 }, t1_1: { squadSize: 1 }, t1_2: { squadSize: 1 }, t1_3: { squadSize: 1 } };
  for (const id of ['t2_0', 't2_1', 't2_2', 't2_3']) meta[id] = { squadSize: 1 };

  const noQuit  = computeRoundUpdate(team1, team2, 'team2win', meta, DEFAULT_PARAMETERS);
  const withQuit = computeRoundUpdate(
    team1, team2, 'team2win',
    { ...meta, t1_3: { squadSize: 1, quit: true } },
    DEFAULT_PARAMETERS
  );

  if (withQuit.team1Updates[3].deltaMu >= noQuit.team1Updates[3].deltaMu) {
    throw new Error(`quitter should lose more (smaller / more-negative deltaMu) than completer`);
  }
  // Non-quitters on the same team must not lose MORE rating because someone else quit.
  for (let i = 0; i < 3; i++) {
    if (withQuit.team1Updates[i].deltaMu < noQuit.team1Updates[i].deltaMu - 1e-6) {
      throw new Error(`non-quitter ${i} unfairly penalised`);
    }
  }
}

export async function testQuitWhileWinningStillPenalises() {
  // Paper observation: quit penalty applies regardless of match outcome.
  const team1 = Array.from({ length: 2 }, (_, i) => ({ eosID: `t1_${i}`, mu: 25, sigma: 8.333, participationRatio: 1 }));
  const team2 = Array.from({ length: 2 }, (_, i) => ({ eosID: `t2_${i}`, mu: 25, sigma: 8.333, participationRatio: 1 }));
  const noQuit = computeRoundUpdate(team1, team2, 'team1win', {}, DEFAULT_PARAMETERS);
  const withQuit = computeRoundUpdate(team1, team2, 'team1win', { t1_0: { squadSize: 1, quit: true } }, DEFAULT_PARAMETERS);
  if (withQuit.team1Updates[0].deltaMu >= noQuit.team1Updates[0].deltaMu) {
    throw new Error(`quitter on winning team must still see smaller deltaMu`);
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node testing/run-all-tests.js`
Expected: FAIL — engine ignores `quit`.

- [ ] **Step 3: Add `quitFactorMessage` to the factor library**

Append to `utils/elo-trueskill2-factors.js`:

```javascript
import * as gauss from './elo-gauss.js';

/**
 * Quit-penalty factor message to a single player's skill (paper Section 9, online form).
 *
 * The quitter is treated as having observed the outcome of a "mini-game"
 *     D = perf_i - perf_o_i < m_q  (with Gaussian noise v_q on D)
 * which is the same math as a normal one-sided TrueSkill loss with margin m_q.
 *
 * @param {Object} player         { mu, sigma }
 * @param {number} teamMuOther    posterior mean of the *opposing* team's average perf
 * @param {number} teamVarOther   variance of the opposing team's average perf
 *                                (= teamSigmaSqOther / effectiveN_other from the team factor)
 * @param {Object} parameters     frozen TrueSkill2 params (uses beta, quitParams.{mQ, vQ})
 *
 * @returns {{deltaPrecision, deltaPrecisionMean}} message to combine with team-factor message
 */
export function quitFactorMessage(player, teamMuOther, teamVarOther, parameters) {
  const sigmaSq = player.sigma * player.sigma;
  const beta = parameters.beta;
  const { mQ, vQ } = parameters.quitParams;

  // D = perf_i - perf_o_i ~ N(mu_i - teamMuOther, sigmaSq + β² + teamVarOther + vQ)
  const totalVar = sigmaSq + beta * beta + teamVarOther + vQ;
  const c = Math.sqrt(totalVar);
  if (!(c > 0)) return EMPTY_MESSAGE;

  // Observe D < mQ ⇒ t = (E[D] − mQ) / c, with the "loser" form (one-sided truncation below).
  const t = (player.mu - teamMuOther - mQ) / c;
  const vVal = -gauss.pdf(t) / Math.max(gauss.cdf(-t), 1e-12);   // negative
  const wVal = vVal * (vVal + t);                                // ∈ [0, 1)

  // Update on skill_i (NOT on perf_i): chain rule scales by sigmaSq/c and sigmaSq/c².
  const newMu = player.mu + (sigmaSq / c) * vVal;
  const safeFactor = Math.min((sigmaSq / (c * c)) * wVal, 1 - 1e-10);
  const newSigmaSq = sigmaSq * (1 - safeFactor);

  const priorPrec = 1 / sigmaSq;
  const postPrec = 1 / newSigmaSq;
  return {
    deltaPrecision: postPrec - priorPrec,
    deltaPrecisionMean: newMu * postPrec - player.mu * priorPrec
  };
}
```

- [ ] **Step 4: Apply quit messages in the engine**

First, extend `teamFactorMessages` (in `utils/elo-trueskill2-factors.js`) to expose `teamSigmaSq1`, `teamSigmaSq2`, `effectiveN1`, `effectiveN2` so the engine can compute per-player opposing-team statistics. At the bottom of `teamFactorMessages` where the existing return statement is, replace it with:

```javascript
return {
  team1Messages: team1.map(p => buildMessage(p, true)),
  team2Messages: team2.map(p => buildMessage(p, false)),
  teamMu1, teamMu2, c,
  teamSigmaSq1: teamSig1, teamSigmaSq2: teamSig2,
  effectiveN1, effectiveN2,
  debug: { nTotal, epsilon, tRaw }
};
```

Then rewrite `computeRoundUpdate` in `utils/elo-trueskill2-engine.js` so each player's message list includes the team-factor message AND a quit-factor message when applicable, with experience offset still applied at the end (per Task 8):

```javascript
import {
  fromMuSigma, toMuSigma, combineMessages,
  teamFactorMessages, quitFactorMessage
} from './elo-trueskill2-factors.js';

function squadMeanShift(team, perPlayerMeta, parameters) {
  let shift = 0, effectiveN = 0;
  for (const p of team) {
    const ratio = p.participationRatio ?? 1.0;
    effectiveN += ratio;
    const size = perPlayerMeta[p.eosID]?.squadSize ?? 1;
    const idx = Math.min(Math.max(size - 1, 0), parameters.squadOffsets.length - 1);
    shift += parameters.squadOffsets[idx] * ratio;
  }
  const scale = effectiveN > 50.0 ? 50.0 / effectiveN : 1.0;
  return shift * scale;
}

function experienceShift(player, perPlayerMeta, parameters) {
  const exp = perPlayerMeta[player.eosID]?.experience ?? 0;
  const idx = Math.min(Math.max(exp, 0), parameters.experienceOffsets.length - 1);
  return parameters.experienceOffsets[idx];
}

export function computeRoundUpdate(team1, team2, outcome, perPlayerMeta, parameters) {
  const teamMeta = {
    team1: { meanShift: squadMeanShift(team1, perPlayerMeta, parameters) },
    team2: { meanShift: squadMeanShift(team2, perPlayerMeta, parameters) }
  };

  const tfm = teamFactorMessages(team1, team2, outcome, parameters, teamMeta);
  const {
    team1Messages, team2Messages,
    teamMu1, teamMu2,
    teamSigmaSq1, teamSigmaSq2,
    effectiveN1, effectiveN2,
    debug
  } = tfm;

  const safeN1 = Math.max(effectiveN1, 1e-9);
  const safeN2 = Math.max(effectiveN2, 1e-9);
  const team1OtherMu  = teamMu2 / safeN2;
  const team2OtherMu  = teamMu1 / safeN1;
  const team1OtherVar = teamSigmaSq2 / safeN2;
  const team2OtherVar = teamSigmaSq1 / safeN1;

  const buildMessages = (player, baseMessage, opponentMu, opponentVar) => {
    const out = [baseMessage];
    const meta = perPlayerMeta[player.eosID];
    if (meta?.quit) {
      out.push(quitFactorMessage(player, opponentMu, opponentVar, parameters));
    }
    return out;
  };

  const updateOne = (player, baseMessage, opponentMu, opponentVar) => {
    const msgs = buildMessages(player, baseMessage, opponentMu, opponentVar);
    const prior = fromMuSigma(player.mu, player.sigma);
    let { mu, sigma } = toMuSigma(combineMessages(prior, msgs));
    mu += experienceShift(player, perPlayerMeta, parameters);
    return {
      deltaMu: mu - player.mu,
      deltaSigma: player.sigma - sigma,
      vVal: baseMessage._vVal ?? 0,
      wVal: baseMessage._wVal ?? 0
    };
  };

  return {
    team1Updates: team1.map((p, i) => updateOne(p, team1Messages[i], team1OtherMu, team1OtherVar)),
    team2Updates: team2.map((p, i) => updateOne(p, team2Messages[i], team2OtherMu, team2OtherVar)),
    debug: { ...debug, teamMu1, teamMu2, effectiveN1, effectiveN2 }
  };
}
```

This replaces the earlier (Task 6 / Task 8) versions of `computeRoundUpdate` — those were stepping stones; this is the final shape for this task.

- [ ] **Step 5: Wire `quit` flag in the plugin**

In `plugins/elo-tracker.js`, where `perPlayerMeta` is built, call `_detectQuittersAt(roundEndTime)` and set:

```javascript
const quitters = this._detectQuittersAt(roundEndTime);
for (const id of Object.keys(perPlayerMeta)) {
  perPlayerMeta[id].quit = quitters.has(id);
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node testing/run-all-tests.js`
Expected: PASS for the two quit tests; all earlier tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add utils/elo-trueskill2-engine.js utils/elo-trueskill2-factors.js plugins/elo-tracker.js testing/test-elo-trueskill2-engine.js
git commit -m "Add quit-penalty factor (paper Section 9, online form)"
```

---

## Task 10: Kill/death individual-statistics factor (paper Section 8, equation 9)

**Files:**
- Modify: `utils/elo-trueskill2-factors.js` (add `killDeathFactorMessage`)
- Modify: `utils/elo-trueskill2-engine.js` (include kill & death messages per player)
- Modify: `plugins/elo-tracker.js` (pass `kills`, `deaths`, `timePlayed` per player)
- Modify: `testing/test-elo-trueskill2-engine.js` (new tests)

**Math (Section 8, equation 9):**
```
count_i^c ~ max(0, N((w_p^c · perf_i + w_o^c · perf_o_i) · tp_i, v^c · tp_i))
```
with `perf_i ~ N(skill_i, β²)` and `perf_o_i ~ N(teamMuOther/effectiveN_other, teamSigmaSqOther/effectiveN_other)`.

Marginalising both performance variables (and ignoring the truncation at 0, which is rarely active for typical Squad kill counts of 10–30) gives:

```
count_i^c | skill_i ~ N(
    (w_p · skill_i + w_o · muOther) · tp,
    w_p² · β² · tp² + w_o² · varOther · tp² + v · tp
)
```

This is a linear-Gaussian observation on `skill_i` with slope `a = w_p · tp`, offset `b = w_o · muOther · tp`, and variance `V = w_p² · β² · tp² + w_o² · varOther · tp² + v · tp`. The natural-form message contribution:

```
deltaPrecision     = a² / V
deltaPrecisionMean = a · (count_i - b) / V
```

We compute one such message per (kill, death) observation per player and add them to the message list.

- [ ] **Step 1: Write the failing test**

```javascript
import { DEFAULT_PARAMETERS, loadParameters } from '../utils/elo-parameters.js';

// Kill/death weights are NEUTRAL in DEFAULT_PARAMETERS; opt-in with realistic values.
const TUNED_KD = loadParameters({
  killParams:  { wPlayer:  0.10, wOpponent: -0.05, variance: 0.5 },
  deathParams: { wPlayer: -0.05, wOpponent:  0.10, variance: 0.5 }
});

export async function testKillStatsBoostHighScorerOnSameOutcome() {
  // Two players on the winning team. Both contributed the same time. Player A scored
  // 25 kills / 5 deaths; player B scored 5 kills / 25 deaths. Both should still GAIN rating
  // (they won), but A should gain MORE than B.
  const team1 = [
    { eosID: 'A', mu: 25, sigma: 8.333, participationRatio: 1 },
    { eosID: 'B', mu: 25, sigma: 8.333, participationRatio: 1 }
  ];
  const team2 = Array.from({ length: 2 }, (_, i) => ({ eosID: `e${i}`, mu: 25, sigma: 8.333, participationRatio: 1 }));
  const meta = {
    A: { squadSize: 1, kills: 25, deaths: 5, timePlayedMin: 20 },
    B: { squadSize: 1, kills: 5,  deaths: 25, timePlayedMin: 20 },
    e0: { squadSize: 1, kills: 10, deaths: 10, timePlayedMin: 20 },
    e1: { squadSize: 1, kills: 10, deaths: 10, timePlayedMin: 20 }
  };
  const r = computeRoundUpdate(team1, team2, 'team1win', meta, TUNED_KD);
  if (r.team1Updates[0].deltaMu <= r.team1Updates[1].deltaMu) {
    throw new Error(`high-scorer A should gain MORE rating than under-performer B on the same win`);
  }
  if (r.team1Updates[1].deltaMu <= 0) {
    throw new Error(`B still won, deltaMu should still be > 0`);
  }
}

export async function testKillStatsDisabledWhenMissing() {
  // If perPlayerMeta omits kills/deaths/timePlayedMin for everyone, the result must
  // equal the no-stats baseline (within floating-point tolerance).
  const team1 = [{ eosID: 'a', mu: 25, sigma: 8.333, participationRatio: 1 }];
  const team2 = [{ eosID: 'b', mu: 25, sigma: 8.333, participationRatio: 1 }];
  const baseline = computeRoundUpdate(team1, team2, 'team1win', {}, TUNED_KD);
  const withZeroMeta = computeRoundUpdate(team1, team2, 'team1win',
    { a: { squadSize: 1 }, b: { squadSize: 1 } }, TUNED_KD);
  if (Math.abs(baseline.team1Updates[0].deltaMu - withZeroMeta.team1Updates[0].deltaMu) > 1e-9) {
    throw new Error(`missing kill stats should yield identical result`);
  }
}

export async function testKillStatsDoNotAffectLosingTeamUnfairly() {
  // High-kill player on losing team should lose LESS rating than a low-kill teammate.
  const team1 = [
    { eosID: 'A', mu: 25, sigma: 8.333, participationRatio: 1 },
    { eosID: 'B', mu: 25, sigma: 8.333, participationRatio: 1 }
  ];
  const team2 = Array.from({ length: 2 }, (_, i) => ({ eosID: `e${i}`, mu: 25, sigma: 8.333, participationRatio: 1 }));
  const meta = {
    A: { squadSize: 1, kills: 30, deaths: 5, timePlayedMin: 20 },
    B: { squadSize: 1, kills: 5, deaths: 30, timePlayedMin: 20 },
    e0: { squadSize: 1, kills: 15, deaths: 15, timePlayedMin: 20 },
    e1: { squadSize: 1, kills: 15, deaths: 15, timePlayedMin: 20 }
  };
  const r = computeRoundUpdate(team1, team2, 'team2win', meta, TUNED_KD);
  if (r.team1Updates[0].deltaMu <= r.team1Updates[1].deltaMu) {
    throw new Error(`high-scorer should lose LESS than under-performer on the same loss`);
  }
}

export async function testNeutralDefaultsDisableKillDeathFactor() {
  const team1 = [{ eosID: 'a', mu: 25, sigma: 8.333, participationRatio: 1 }];
  const team2 = [{ eosID: 'b', mu: 25, sigma: 8.333, participationRatio: 1 }];
  const r0 = computeRoundUpdate(team1, team2, 'team1win', {}, DEFAULT_PARAMETERS);
  const r1 = computeRoundUpdate(team1, team2, 'team1win',
    { a: { kills: 50, deaths: 0, timePlayedMin: 20, squadSize: 1 },
      b: { kills: 0,  deaths: 50, timePlayedMin: 20, squadSize: 1 } },
    DEFAULT_PARAMETERS);
  if (Math.abs(r0.team1Updates[0].deltaMu - r1.team1Updates[0].deltaMu) > 1e-9) {
    throw new Error(`neutral DEFAULT_PARAMETERS must ignore kill/death stats`);
  }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node testing/run-all-tests.js`
Expected: FAIL — engine ignores kills/deaths.

- [ ] **Step 3: Add `killDeathFactorMessage` to the factor library**

```javascript
/**
 * Individual statistics factor message (paper Section 8, equation 9).
 *
 * Observation:
 *   count ~ N((w_p · skill + w_o · muOther) · tp, w_p²·β²·tp² + w_o²·varOther·tp² + v·tp)
 *
 * The max(0, ·) truncation is dropped: for typical Squad kill counts (>>0)
 * the truncation contributes nothing measurable.
 *
 * @param {Object} player        { mu, sigma }   (used only for sanity; the factor message
 *                                                  does NOT depend on player.mu directly)
 * @param {number} count         observed kill or death count
 * @param {number} muOther       mean opposing-team per-player performance
 * @param {number} varOther      variance of opposing-team per-player performance
 * @param {number} timePlayedMin time played in minutes (consistent with paper's tp_i)
 * @param {Object} weightParams  { wPlayer, wOpponent, variance } from parameters.killParams or .deathParams
 * @param {Object} parameters    full params object (uses .beta)
 *
 * @returns {{deltaPrecision, deltaPrecisionMean}}
 */
export function killDeathFactorMessage(player, count, muOther, varOther, timePlayedMin, weightParams, parameters) {
  if (!(timePlayedMin > 0) || !Number.isFinite(count)) return EMPTY_MESSAGE;
  const { wPlayer: wP, wOpponent: wO, variance: v } = weightParams;
  const beta = parameters.beta;
  const tp = timePlayedMin;

  const a = wP * tp;
  const b = wO * muOther * tp;
  const V = wP * wP * beta * beta * tp * tp + wO * wO * varOther * tp * tp + v * tp;
  if (!(V > 0)) return EMPTY_MESSAGE;

  return {
    deltaPrecision: (a * a) / V,
    deltaPrecisionMean: a * (count - b) / V
  };
}
```

- [ ] **Step 4: Wire kill & death messages in the engine**

In `utils/elo-trueskill2-engine.js`, import `killDeathFactorMessage` and extend the `buildMessages` helper from Task 9 to add kill and death messages. Replace the existing `buildMessages` body with:

```javascript
import {
  fromMuSigma, toMuSigma, combineMessages,
  teamFactorMessages, quitFactorMessage, killDeathFactorMessage
} from './elo-trueskill2-factors.js';

// inside computeRoundUpdate, replacing the Task 9 version:
const buildMessages = (player, baseMessage, opponentMu, opponentVar) => {
  const out = [baseMessage];
  const meta = perPlayerMeta[player.eosID];
  if (!meta) return out;

  if (meta.quit) {
    out.push(quitFactorMessage(player, opponentMu, opponentVar, parameters));
  }
  const tp = meta.timePlayedMin;
  if (tp > 0) {
    if (Number.isFinite(meta.kills)) {
      out.push(killDeathFactorMessage(
        player, meta.kills, opponentMu, opponentVar, tp,
        parameters.killParams, parameters
      ));
    }
    if (Number.isFinite(meta.deaths)) {
      out.push(killDeathFactorMessage(
        player, meta.deaths, opponentMu, opponentVar, tp,
        parameters.deathParams, parameters
      ));
    }
  }
  return out;
};
```

`updateOne` from Task 9 already calls `buildMessages`, so no further engine wiring is needed.

- [ ] **Step 5: Wire `kills`, `deaths`, `timePlayedMin` from the plugin**

In `plugins/elo-tracker.js`:

```javascript
const roundDurationMin = Math.max(1e-6, (roundEndTime - this.roundStartTime) / 60000);
perPlayerMeta[p.eosID] = {
  squadID: p.dominantSquadID,
  squadSize: squadSizeOf(p, participants),
  experience: this.eloCache.get(p.eosID)?.roundsPlayed ?? 0,
  quit: quitters.has(p.eosID),
  kills: this.killsByEosID.get(p.eosID) ?? 0,
  deaths: this.deathsByEosID.get(p.eosID) ?? 0,
  timePlayedMin: roundDurationMin * p.participationRatio
};
```

Also persist these to `Elo_RoundPlayers` when `enableDatabaseLogging` is on:

```javascript
const roundPlayerRow = {
  // ...existing fields...,
  squadID:          meta.squadID,
  squadSize:        meta.squadSize,
  kills:            meta.kills,
  deaths:           meta.deaths,
  quit:             meta.quit,
  experienceBefore: meta.experience
};
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node testing/run-all-tests.js`
Expected: PASS for the three kill/death tests, all earlier tests still PASS.

- [ ] **Step 7: Commit**

```bash
git add utils/elo-trueskill2-engine.js utils/elo-trueskill2-factors.js plugins/elo-tracker.js testing/test-elo-trueskill2-engine.js
git commit -m "Add kill/death individual statistics factor (paper eq. 9)"
```

---

## Task 11: Offline rebuild (`tools/elo-rebuild.js`)

**Files:**
- Modify: `tools/elo-rebuild.js`
- Create: `testing/test-elo-rebuild.js` (small smoke test reading a fixture)
- Create: `testing/fixtures/rebuild-sample.jsonl` (10 synthetic match records)

The existing rebuild tool replays JSONL match logs through the calculator. We swap it to use `computeRoundUpdate` so the offline replay matches online updates exactly.

- [ ] **Step 1: Write the failing test**

```javascript
import { rebuildFromLog } from '../tools/elo-rebuild.js';
import fs from 'fs';
import path from 'path';

export async function testRebuildProducesSameRatingsAsOnline() {
  const fixturePath = path.join(import.meta.dirname, 'fixtures/rebuild-sample.jsonl');
  const result = rebuildFromLog(fixturePath, {/* default parameters */});
  if (!result.players || result.players.size === 0) {
    throw new Error(`rebuild should produce at least one player rating`);
  }
  // Spot check: a player who only ever won should have mu > 25.
  const winner = result.players.get('winner_eos');
  if (!winner || winner.mu <= 25) {
    throw new Error(`winner_eos should have rising mu, got ${winner?.mu}`);
  }
}
```

Create `testing/fixtures/rebuild-sample.jsonl` with 10 lines of synthetic match records matching the production log shape (one line per match with team rosters, kills, deaths, quit flags, outcome, durations).

- [ ] **Step 2: Run test to verify it fails**

Run: `node testing/run-all-tests.js`
Expected: FAIL — `rebuildFromLog` isn't exported, or its math is the legacy one.

- [ ] **Step 3: Refactor `tools/elo-rebuild.js`**

Replace the rating-update call site with the new engine:

```javascript
import { computeRoundUpdate } from '../utils/elo-trueskill2-engine.js';
import { loadParameters } from '../utils/elo-parameters.js';

export function rebuildFromLog(jsonlPath, paramOverrides = {}) {
  const parameters = loadParameters(paramOverrides);
  const players = new Map(); // eosID → { mu, sigma, roundsPlayed }

  const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    const match = JSON.parse(line);
    const team1 = match.team1.map(p => ({
      eosID: p.eosID,
      mu: players.get(p.eosID)?.mu ?? parameters.mu0,
      sigma: players.get(p.eosID)?.sigma ?? Math.sqrt(parameters.v0),
      participationRatio: p.participationRatio ?? 1
    }));
    const team2 = match.team2.map(p => ({
      eosID: p.eosID,
      mu: players.get(p.eosID)?.mu ?? parameters.mu0,
      sigma: players.get(p.eosID)?.sigma ?? Math.sqrt(parameters.v0),
      participationRatio: p.participationRatio ?? 1
    }));
    const perPlayerMeta = {};
    for (const p of [...match.team1, ...match.team2]) {
      perPlayerMeta[p.eosID] = {
        squadID: p.squadID,
        squadSize: p.squadSize,
        experience: players.get(p.eosID)?.roundsPlayed ?? 0,
        quit: p.quit ?? false,
        kills: p.kills ?? 0,
        deaths: p.deaths ?? 0,
        timePlayedMin: (match.durationMs ?? 0) * (p.participationRatio ?? 1) / 60000
      };
    }
    const { team1Updates, team2Updates } = computeRoundUpdate(team1, team2, match.outcome, perPlayerMeta, parameters);
    for (let i = 0; i < team1.length; i++) {
      const eosID = team1[i].eosID;
      const prev = players.get(eosID) ?? { mu: parameters.mu0, sigma: Math.sqrt(parameters.v0), roundsPlayed: 0 };
      const ratio = team1[i].participationRatio;
      const mu = prev.mu + team1Updates[i].deltaMu * ratio;
      const sigma = Math.max(prev.sigma - team1Updates[i].deltaSigma * ratio, 0.5);
      players.set(eosID, { mu, sigma, roundsPlayed: prev.roundsPlayed + 1 });
    }
    // team2 — same logic as team1 above
    for (let i = 0; i < team2.length; i++) {
      const eosID = team2[i].eosID;
      const prev = players.get(eosID) ?? { mu: parameters.mu0, sigma: Math.sqrt(parameters.v0), roundsPlayed: 0 };
      const ratio = team2[i].participationRatio;
      const mu = prev.mu + team2Updates[i].deltaMu * ratio;
      const sigma = Math.max(prev.sigma - team2Updates[i].deltaSigma * ratio, 0.5);
      players.set(eosID, { mu, sigma, roundsPlayed: prev.roundsPlayed + 1 });
    }
  }
  return { players, parameters };
}

// Preserve the existing CLI entrypoint behaviour:
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , inFile, outFile = 'rebuilt.json'] = process.argv;
  const { players, parameters } = rebuildFromLog(inFile);
  fs.writeFileSync(outFile, JSON.stringify({
    parameters,
    players: Array.from(players.entries(), ([eosID, r]) => ({ eosID, ...r }))
  }, null, 2));
  console.log(`Wrote ${outFile} (${players.size} players).`);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node testing/run-all-tests.js`
Expected: PASS for rebuild smoke test; nothing earlier regresses.

- [ ] **Step 5: Commit**

```bash
git add tools/elo-rebuild.js testing/test-elo-rebuild.js testing/fixtures/rebuild-sample.jsonl
git commit -m "Replay matches through TrueSkill2 engine in elo-rebuild"
```

---

## Task 12: Calibration tool & documentation

**Files:**
- Modify: `tools/elo-calibrate.js`
- Modify: `README.md`

The calibration tool already grid-searches BETA and TAU. Extend the grid to TrueSkill2's three most impactful parameters: `quitParams.mQ`, `experienceOffsets[0]` (the new-player drift), `squadOffsets[3]` (the 4-stack boost). Keep BETA, TAU in the grid for backward compat. Use predictive accuracy on a held-out fold as the objective (count of correctly predicted winners on matches in the log, evaluated by checking which team had the higher predicted team performance before the round).

- [ ] **Step 1: Sketch the new grid in `tools/elo-calibrate.js`**

Replace the existing two-parameter grid with a nested loop over 5 parameters. Keep step counts low (≤4 each) to keep the search tractable (~1024 evaluations max). For each grid point:

1. Build `loadParameters({ beta, tau, quitParams: { mQ }, experienceOffsets: padded, squadOffsets: padded })`.
2. Replay the log via `rebuildFromLog(path, paramOverrides)`.
3. Score predictive accuracy: for each match, predict the team with higher pre-match teamMu (using stored `mu` at that point in the replay); compare to actual outcome.
4. Print the best parameter combination and accuracy.

```javascript
import { rebuildFromLog } from './elo-rebuild.js';
import { DEFAULT_PARAMETERS } from '../utils/elo-parameters.js';

const grid = {
  beta:           [DEFAULT_PARAMETERS.beta * 0.8, DEFAULT_PARAMETERS.beta, DEFAULT_PARAMETERS.beta * 1.2],
  tau:            [DEFAULT_PARAMETERS.tau * 0.5, DEFAULT_PARAMETERS.tau, DEFAULT_PARAMETERS.tau * 2],
  mQ:             [-1.0, -2.0, -3.0],
  expOffset0:     [0.0, 0.1, 0.2, 0.4],
  squadOffset4:   [0.5, 0.83, 1.2]
};

function bestParameters(logPath) {
  let best = { accuracy: -Infinity, combo: null };
  for (const beta of grid.beta) for (const tau of grid.tau) for (const mQ of grid.mQ)
  for (const e0 of grid.expOffset0) for (const s4 of grid.squadOffset4) {
    const expOff = Array.from({ length: 200 }, (_, i) => i === 0 ? e0 : (i < 50 ? e0 * (1 - i / 50) : 0));
    const sqOff = [0, 0, 0, s4, 1.3, 1.7, 2.1, 2.4, 2.6, 2.9];
    const acc = evaluatePredictiveAccuracy(logPath, { beta, tau, quitParams: { mQ }, experienceOffsets: expOff, squadOffsets: sqOff });
    if (acc > best.accuracy) best = { accuracy: acc, combo: { beta, tau, mQ, e0, s4 } };
  }
  return best;
}
```

`evaluatePredictiveAccuracy` should replay the log and, for each match, compare predicted winner (team with higher teamMu pre-match) vs actual `match.outcome`. Skip draws.

- [ ] **Step 2: Update `README.md`**

Append a new section (or replace the existing rating-system section) summarising:

- That the rating system is now TrueSkill2 (Minka, Cleven & Zaykov 2018), citing the local PDF.
- The four added factors (squad offset, experience offset, quit penalty, kill/death stats) with one-sentence descriptions and the relevant paper equation number.
- The new config keys that the plugin accepts (mirror the option block from `loadParameters`).
- How to run `tools/elo-calibrate.js` and what parameters it now tunes.
- The new `Elo_RoundPlayers` columns and what they mean.

Keep the README ELO-section terse; the paper is the authoritative reference.

- [ ] **Step 3: Run all tests one final time**

Run: `node testing/run-all-tests.js`
Expected: ALL tests PASS. No skipped tests.

- [ ] **Step 4: Manual sanity run**

Run `node tools/elo-rebuild.js testing/fixtures/rebuild-sample.jsonl /tmp/rebuilt.json` and inspect `/tmp/rebuilt.json` for sane player ratings (mu ∈ [10, 40], sigma ∈ [0.5, 9]).

Run `node tools/elo-calibrate.js testing/fixtures/rebuild-sample.jsonl` (or your full log) and confirm it prints a best-combo without crashing.

- [ ] **Step 5: Commit**

```bash
git add tools/elo-calibrate.js README.md
git commit -m "Calibrate TrueSkill2 params and document the upgrade"
```

---

## Notes on what is intentionally NOT in this plan

- **Iterative EP across factors.** We apply each factor's message exactly once per match (one-pass EP). The paper's Infer.NET-generated code iterates to a fixed point; for online updates with relatively weak factors (kill/death and quit), one pass is within numerical noise of the converged answer.
- **Truncated-Gaussian correction for low kill counts.** The paper uses `max(0, ·)` to forbid negative counts; for Squad's typical 5–40 kill range the truncation contributes nothing and is dropped.
- **Mode correlation (Section 11).** Squad has no meaningfully distinct game modes; the plugin already filters seed/Jensen layers via `ignoredGameModes`.
- **Rprop parameter estimation.** Replaced by manual + small-grid calibration via `tools/elo-calibrate.js`. The paper says Rprop is only worthwhile with ≥1000 matches per mode and on a dataset where running 100 EP iterations is feasible.
- **Backward migration of historical `mu`/`sigma`.** Existing player ratings are kept as-is. To "reset" with the new model, run `tools/elo-rebuild.js` against the full match log and write the resulting ratings back to `Elo_PlayerStats`; this is a one-off operator action, not part of the plan.

---

## Open verification questions (resolve during implementation)

1. **SquadJS `PLAYER_DIED` payload shape.** The reference doc confirms the event exists but doesn't pin field names. Verify on first run that `data.victim.eosID`, `data.attacker.eosID`, `data.attacker.teamID` are populated. If `attacker.teamID` is null when both players are on the same team (teamkill), fall back to looking up the team in the session's player map.
2. **`server.players[i].squadID` field name and null-handling.** Verify that the field is literally `squadID` (not `squadId` or `squad`) and that "no squad" surfaces as `null` (not `0` or `undefined`). Adjust the session-manager null normalisation if so.
3. **Round duration source.** `endRound(roundEndTime) - roundStartTime` gives a wall-clock duration that *includes* the ~260s staging period. Verify whether `timePlayedMin` should subtract staging — if so, gate the round-start clock on staging-complete (the doc notes there's no reliable signal for this; use a fixed 280s offset from `NEW_GAME`).
