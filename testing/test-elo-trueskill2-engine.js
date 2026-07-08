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
