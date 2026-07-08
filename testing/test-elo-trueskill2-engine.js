import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import EloCalculator from '../utils/elo-calculator.js';
import { computeRoundUpdate } from '../utils/elo-trueskill2-engine.js';
import { DEFAULT_PARAMETERS } from '../utils/elo-parameters.js';
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
