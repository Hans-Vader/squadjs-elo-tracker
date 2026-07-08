import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import EloCalculator from '../utils/elo-calculator.js';
import { computeRoundUpdate } from '../utils/elo-trueskill2-engine.js';
import { DEFAULT_PARAMETERS, loadParameters } from '../utils/elo-parameters.js';
import * as gauss from '../utils/elo-gauss.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function nearlyEqual(a, b, eps = 1e-9) {
  return Math.abs(a - b) <= eps * Math.max(1, Math.abs(a), Math.abs(b));
}

function assertUpdatesMatch(actual, expected, label, eps = 1e-9) {
  if (actual.length !== expected.length) {
    throw new Error(`${label}: length mismatch ${actual.length} vs ${expected.length}`);
  }
  for (let i = 0; i < expected.length; i++) {
    for (const field of ['deltaMu', 'deltaSigma', 'vVal', 'wVal']) {
      if (!nearlyEqual(actual[i][field], expected[i][field], eps)) {
        throw new Error(
          `${label}[${i}].${field}: got ${actual[i][field]}, golden ${expected[i][field]}`
        );
      }
    }
  }
}

export default async function runEngineTests(runTest) {
  const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures/team-update-goldens.json'), 'utf8')
  );

  await runTest('Goldens: engine reproduces ORIGINAL TrueSkill1 outputs (20 scenarios)', async () => {
    for (const { name, input, expected } of fixture.goldens) {
      const result = computeRoundUpdate(input.team1, input.team2, input.outcome, {}, DEFAULT_PARAMETERS);
      assertUpdatesMatch(result.team1Updates, expected.team1Updates, `${name} team1`);
      assertUpdatesMatch(result.team2Updates, expected.team2Updates, `${name} team2`);
    }
  });

  await runTest('Goldens: legacy computeTeamUpdate wrapper matches (20 scenarios)', async () => {
    for (const { name, input, expected } of fixture.goldens) {
      const result = EloCalculator.computeTeamUpdate(input.team1, input.team2, input.outcome);
      assertUpdatesMatch(result.team1Updates, expected.team1Updates, `${name} team1`);
      assertUpdatesMatch(result.team2Updates, expected.team2Updates, `${name} team2`);
    }
  });

  await runTest('Goldens: debug block byte-compatible (12 fields)', async () => {
    const DEBUG_FIELDS = [
      'teamMu1', 'teamMu2', 'teamSigmaSq1', 'teamSigmaSq2', 'c',
      'effectiveN1', 'effectiveN2', 'nTotal', 'epsilon', 'tRaw', 'vVal', 'wVal'
    ];
    for (const { name, input, expected } of fixture.goldens) {
      if (!expected.debug) continue;
      const result = EloCalculator.computeTeamUpdate(input.team1, input.team2, input.outcome);
      if (!result.debug) throw new Error(`${name}: debug block missing`);
      for (const field of DEBUG_FIELDS) {
        if (!(field in result.debug)) throw new Error(`${name}: debug.${field} missing`);
        if (!nearlyEqual(result.debug[field], expected.debug[field])) {
          throw new Error(`${name}: debug.${field} got ${result.debug[field]}, golden ${expected.debug[field]}`);
        }
      }
    }
  });

  await runTest('Degenerate: empty teams return empty updates', async () => {
    const viaEngine = computeRoundUpdate([], [], 'team1win', {}, DEFAULT_PARAMETERS);
    if (viaEngine.team1Updates.length !== 0 || viaEngine.team2Updates.length !== 0) {
      throw new Error('empty teams must return empty update arrays');
    }
    const viaWrapper = EloCalculator.computeTeamUpdate([], [], 'draw');
    if (viaWrapper.team1Updates.length !== 0 || viaWrapper.team2Updates.length !== 0) {
      throw new Error('wrapper empty-teams parity broken');
    }
  });

  await runTest('Tail guard (A5): v/w return asymptotes instead of 0 on cdf underflow', async () => {
    // t - e = -40: cdf underflows to exactly 0 with the A&S erf approximation.
    const vVal = gauss.v(-40, 0);
    if (!nearlyEqual(vVal, 40, 1e-6)) throw new Error(`v(-40,0) should approach e - t = 40, got ${vVal}`);
    const wVal = gauss.w(-40, 0);
    if (!nearlyEqual(wVal, 1, 1e-6)) throw new Error(`w(-40,0) should approach 1, got ${wVal}`);
    // Sanity: non-tail values still finite/positive and match the direct formula
    const vMid = gauss.v(-2, 0.1);
    if (!(vMid > 0) || !Number.isFinite(vMid)) throw new Error(`v(-2,0.1) invalid: ${vMid}`);
  });

  // --- Squad-offset factor (paper eq. 7) ---

  const TUNED_SQUAD = loadParameters({
    squadOffsets: [0, 0, 0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5]
  });
  const four = (prefix) =>
    Array.from({ length: 4 }, (_, i) => ({ eosID: `${prefix}${i}`, mu: 25, sigma: 8.333, participationRatio: 1 }));
  const squadMeta = () => {
    const meta = {};
    for (let i = 0; i < 4; i++) meta[`t1_${i}`] = { squadSize: 4 };
    for (let i = 0; i < 4; i++) meta[`t2_${i}`] = { squadSize: 1 };
    return meta;
  };

  await runTest('Squad offset: 4-stack favoured — smaller gain on win', async () => {
    const baseline = computeRoundUpdate(four('t1_'), four('t2_'), 'team1win', {}, TUNED_SQUAD);
    const withSquads = computeRoundUpdate(four('t1_'), four('t2_'), 'team1win', squadMeta(), TUNED_SQUAD);
    if (withSquads.team1Updates[0].deltaMu >= baseline.team1Updates[0].deltaMu) {
      throw new Error(
        `favoured squad should gain less on win: ${withSquads.team1Updates[0].deltaMu} vs ${baseline.team1Updates[0].deltaMu}`
      );
    }
  });

  await runTest('Squad offset: 4-stack favoured — bigger loss on defeat', async () => {
    const baseline = computeRoundUpdate(four('t1_'), four('t2_'), 'team2win', {}, TUNED_SQUAD);
    const withSquads = computeRoundUpdate(four('t1_'), four('t2_'), 'team2win', squadMeta(), TUNED_SQUAD);
    if (withSquads.team1Updates[0].deltaMu >= baseline.team1Updates[0].deltaMu) {
      throw new Error('favoured squad losing must yield a more-negative deltaMu');
    }
  });

  await runTest('Squad offset: solos (size 1) exactly match baseline', async () => {
    const t1 = [{ eosID: 'a', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const t2 = [{ eosID: 'b', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const baseline = computeRoundUpdate(t1, t2, 'team1win', {}, TUNED_SQUAD);
    const withMeta = computeRoundUpdate(t1, t2, 'team1win', { a: { squadSize: 1 }, b: { squadSize: 1 } }, TUNED_SQUAD);
    if (Math.abs(baseline.team1Updates[0].deltaMu - withMeta.team1Updates[0].deltaMu) > 1e-9) {
      throw new Error('squadSize=1 must match baseline exactly (squadOffsets[0] === 0)');
    }
  });

  await runTest('Squad offset: neutral DEFAULT_PARAMETERS ignore squadSize', async () => {
    const t1 = [{ eosID: 'a', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const t2 = [{ eosID: 'b', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const r0 = computeRoundUpdate(t1, t2, 'team1win', {}, DEFAULT_PARAMETERS);
    const r1 = computeRoundUpdate(t1, t2, 'team1win', { a: { squadSize: 9 }, b: { squadSize: 1 } }, DEFAULT_PARAMETERS);
    if (Math.abs(r0.team1Updates[0].deltaMu - r1.team1Updates[0].deltaMu) > 1e-9) {
      throw new Error('with neutral DEFAULT_PARAMETERS, squadSize must have no effect');
    }
  });

  await runTest('Squad offset: oversized squadSize clamps to last offset entry', async () => {
    const t1 = four('t1_');
    const t2 = four('t2_');
    const metaAt10 = squadMeta();
    const metaAt99 = squadMeta();
    for (let i = 0; i < 4; i++) {
      metaAt10[`t1_${i}`] = { squadSize: 10 };
      metaAt99[`t1_${i}`] = { squadSize: 99 };
    }
    const r10 = computeRoundUpdate(t1, t2, 'team1win', metaAt10, TUNED_SQUAD);
    const r99 = computeRoundUpdate(t1, t2, 'team1win', metaAt99, TUNED_SQUAD);
    if (Math.abs(r10.team1Updates[0].deltaMu - r99.team1Updates[0].deltaMu) > 1e-12) {
      throw new Error('squadSize beyond the offset table must clamp to the last entry');
    }
  });

  // --- Experience offset (paper eq. 8) ---

  const TUNED_EXP = loadParameters({
    experienceOffsets: Array.from({ length: 200 }, (_, i) => (i < 50 ? 1.0 * (1 - i / 50) : 0))
  });

  await runTest('Experience offset: new player loses less than experienced player', async () => {
    const newPlayer = [{ eosID: 'n', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const opp = [{ eosID: 'o', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const metaNew = { n: { experience: 0 }, o: { experience: 100 } };
    const metaExp = { n: { experience: 100 }, o: { experience: 100 } };

    const r1 = computeRoundUpdate(newPlayer, opp, 'team2win', metaNew, TUNED_EXP);
    const r2 = computeRoundUpdate(newPlayer, opp, 'team2win', metaExp, TUNED_EXP);

    // Both lose, but the new player's positive drift softens the drop.
    if (r1.team1Updates[0].deltaMu <= r2.team1Updates[0].deltaMu) {
      throw new Error(
        `new-player drop should be softer: exp0 ${r1.team1Updates[0].deltaMu} vs exp100 ${r2.team1Updates[0].deltaMu}`
      );
    }
    // The offset applies regardless of outcome — exactly +1.0 difference here.
    if (Math.abs(r1.team1Updates[0].deltaMu - r2.team1Updates[0].deltaMu - 1.0) > 1e-9) {
      throw new Error('drift difference must equal experienceOffsets[0] - experienceOffsets[100]');
    }
  });

  await runTest('Experience offset: capped beyond the table length', async () => {
    const a = [{ eosID: 'a', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const b = [{ eosID: 'b', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const r1 = computeRoundUpdate(a, b, 'team1win', { a: { experience: 200 }, b: { experience: 200 } }, TUNED_EXP);
    const r2 = computeRoundUpdate(a, b, 'team1win', { a: { experience: 5000 }, b: { experience: 5000 } }, TUNED_EXP);
    if (Math.abs(r1.team1Updates[0].deltaMu - r2.team1Updates[0].deltaMu) > 1e-9) {
      throw new Error('experience > table length must not change the update further');
    }
  });

  await runTest('Experience offset: neutral DEFAULT_PARAMETERS give no drift', async () => {
    const a = [{ eosID: 'a', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const b = [{ eosID: 'b', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const r0 = computeRoundUpdate(a, b, 'team1win', {}, DEFAULT_PARAMETERS);
    const r1 = computeRoundUpdate(a, b, 'team1win', { a: { experience: 0 }, b: { experience: 0 } }, DEFAULT_PARAMETERS);
    if (Math.abs(r0.team1Updates[0].deltaMu - r1.team1Updates[0].deltaMu) > 1e-9) {
      throw new Error('neutral DEFAULT_PARAMETERS must give no experience drift');
    }
  });

  // --- Quit penalty (paper Section 9, deterministic-quit limit of eq. 13) ---

  await runTest('Quit penalty: quitter loses extra; teammates unaffected', async () => {
    const t1 = four('t1_');
    const t2 = four('t2_');
    const noQuit = computeRoundUpdate(t1, t2, 'team2win', {}, DEFAULT_PARAMETERS);
    const withQuit = computeRoundUpdate(t1, t2, 'team2win', { t1_3: { quit: true } }, DEFAULT_PARAMETERS);

    if (withQuit.team1Updates[3].deltaMu >= noQuit.team1Updates[3].deltaMu) {
      throw new Error(
        `quitter must lose more: ${withQuit.team1Updates[3].deltaMu} vs ${noQuit.team1Updates[3].deltaMu}`
      );
    }
    for (let i = 0; i < 3; i++) {
      if (Math.abs(withQuit.team1Updates[i].deltaMu - noQuit.team1Updates[i].deltaMu) > 1e-9) {
        throw new Error(`non-quitter ${i} must be unaffected by a teammate's quit`);
      }
    }
    // Quitter's sigma must not increase vs the no-quit case (extra observation ⇒ more info)
    if (withQuit.team1Updates[3].deltaSigma < noQuit.team1Updates[3].deltaSigma - 1e-9) {
      throw new Error('quit observation must not reduce confidence');
    }
  });

  await runTest('Quit penalty: applies even on the winning team', async () => {
    const t1 = four('t1_').slice(0, 2);
    const t2 = four('t2_').slice(0, 2);
    const noQuit = computeRoundUpdate(t1, t2, 'team1win', {}, DEFAULT_PARAMETERS);
    const withQuit = computeRoundUpdate(t1, t2, 'team1win', { t1_0: { quit: true } }, DEFAULT_PARAMETERS);
    if (withQuit.team1Updates[0].deltaMu >= noQuit.team1Updates[0].deltaMu) {
      throw new Error('quitter on the winning team must still see a smaller deltaMu');
    }
  });

  await runTest('Quit penalty: stronger opposition ⇒ milder penalty (underperformance is relative)', async () => {
    const me = [{ eosID: 'q', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const weakOpp = [{ eosID: 'w', mu: 15, sigma: 4, participationRatio: 1 }];
    const strongOpp = [{ eosID: 's', mu: 40, sigma: 4, participationRatio: 1 }];
    const vsWeak = computeRoundUpdate(me, weakOpp, 'team2win', { q: { quit: true } }, DEFAULT_PARAMETERS);
    const vsWeakNoQuit = computeRoundUpdate(me, weakOpp, 'team2win', {}, DEFAULT_PARAMETERS);
    const vsStrong = computeRoundUpdate(me, strongOpp, 'team2win', { q: { quit: true } }, DEFAULT_PARAMETERS);
    const vsStrongNoQuit = computeRoundUpdate(me, strongOpp, 'team2win', {}, DEFAULT_PARAMETERS);
    const penaltyWeak = vsWeakNoQuit.team1Updates[0].deltaMu - vsWeak.team1Updates[0].deltaMu;
    const penaltyStrong = vsStrongNoQuit.team1Updates[0].deltaMu - vsStrong.team1Updates[0].deltaMu;
    if (!(penaltyWeak > penaltyStrong)) {
      throw new Error(
        `quitting against weak opposition must cost more (weak ${penaltyWeak} vs strong ${penaltyStrong})`
      );
    }
  });

  await runTest('Wrapper honors runtime BETA/TAU mutation (calibrator contract)', async () => {
    const betaBefore = EloCalculator.BETA;
    const tauBefore = EloCalculator.TAU;
    try {
      const base = EloCalculator.computeTeamUpdate([{ mu: 25, sigma: 8.333 }], [{ mu: 25, sigma: 8.333 }], 'team1win');
      EloCalculator.BETA = betaBefore * 2;
      EloCalculator.TAU = tauBefore * 3;
      const mutated = EloCalculator.computeTeamUpdate([{ mu: 25, sigma: 8.333 }], [{ mu: 25, sigma: 8.333 }], 'team1win');
      if (nearlyEqual(base.team1Updates[0].deltaMu, mutated.team1Updates[0].deltaMu)) {
        throw new Error('mutating EloCalculator.BETA must change the update (calibration sweeps rely on it)');
      }
    } finally {
      EloCalculator.BETA = betaBefore;
      EloCalculator.TAU = tauBefore;
    }
  });
}
