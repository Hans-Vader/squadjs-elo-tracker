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

  await runTest('Goldens: engine output = legacy golden deltas × participationRatio (20 scenarios)', async () => {
    // The engine applies participation scaling internally (team factor only);
    // the goldens pin the legacy UNSCALED deltas, so the expected value is
    // golden × ratio — for full-participation players that is the golden itself.
    const scaleExpected = (updates, team) => updates.map((u, i) => ({
      ...u,
      deltaMu: u.deltaMu * (team[i].participationRatio ?? 1),
      deltaSigma: u.deltaSigma * (team[i].participationRatio ?? 1)
    }));
    for (const { name, input, expected } of fixture.goldens) {
      const result = computeRoundUpdate(input.team1, input.team2, input.outcome, {}, DEFAULT_PARAMETERS);
      assertUpdatesMatch(result.team1Updates, scaleExpected(expected.team1Updates, input.team1), `${name} team1`);
      assertUpdatesMatch(result.team2Updates, scaleExpected(expected.team2Updates, input.team2), `${name} team2`);
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
    // t - e = -40: exp(-z²) underflows to exactly 0 (below ~ -38.6).
    const vVal = gauss.v(-40, 0);
    if (!nearlyEqual(vVal, 40, 1e-6)) throw new Error(`v(-40,0) should approach e - t = 40, got ${vVal}`);
    const wVal = gauss.w(-40, 0);
    if (!nearlyEqual(wVal, 1, 1e-6)) throw new Error(`w(-40,0) should approach 1, got ${wVal}`);
    // Sanity: non-tail values still finite/positive and match the direct formula
    const vMid = gauss.v(-2, 0.1);
    if (!(vMid > 0) || !Number.isFinite(vMid)) throw new Error(`v(-2,0.1) invalid: ${vMid}`);
  });

  await runTest('Tail: cdf negative tail is relative-accurate (no cancellation quantization)', async () => {
    // Reference values from an independent erfc continued-fraction evaluation
    // (~1e-13 relative). The old 0.5·(1+erf(x)) form quantized these to a few
    // multiples of machine epsilon (garbage below ~ -7.5, exactly 0 below -8.4).
    const refs = [
      [-8, 6.220961e-16],
      [-12, 1.776482e-33],
      [-20, 2.753624e-89]
    ];
    for (const [x, ref] of refs) {
      const got = gauss.cdf(x);
      const relErr = Math.abs(got - ref) / ref;
      if (!(relErr <= 1e-5)) {
        throw new Error(`cdf(${x}): got ${got}, reference ${ref} (rel err ${relErr})`);
      }
    }
  });

  await runTest('Tail: w accurate and inside [0,1] across the former garbage band', async () => {
    // Independent reference values (erfc continued fraction). The old cdf gave
    // w(-7.5,0)=0.46, w(-8,0)=2.27, w(-8.3,0)=-3.2 — including the WRONG SIGN,
    // which flips the sigma-update direction.
    const refs = [
      [-7, 0.98173809],
      [-7.5, 0.98388026],
      [-8, 0.98567512],
      [-8.3, 0.98661503]
    ];
    for (const [t, ref] of refs) {
      const got = gauss.w(t, 0);
      if (!nearlyEqual(got, ref, 1e-4)) {
        throw new Error(`w(${t},0): got ${got}, reference ${ref}`);
      }
    }
    // Full sweep: w must never leave [0,1], v must stay finite and positive.
    for (let t = -38; t <= 0; t += 0.05) {
      const wv = gauss.w(t, 0);
      const vv = gauss.v(t, 0);
      if (!(wv >= 0 && wv <= 1)) throw new Error(`w(${t},0) out of [0,1]: ${wv}`);
      if (!(vv >= 0) || !Number.isFinite(vv)) throw new Error(`v(${t},0) invalid: ${vv}`);
    }
  });

  // --- Participation scaling (inside the engine, team factor only) ---

  await runTest('Participation: team update scaled inside the engine (legacy convention)', async () => {
    // Teammates with identical ratings receive identical team messages; only
    // the participation ratio differs, so the applied deltas must differ by
    // exactly that ratio.
    const t1 = [
      { eosID: 'half', mu: 25, sigma: 8.333, participationRatio: 0.5 },
      { eosID: 'full', mu: 25, sigma: 8.333, participationRatio: 1.0 }
    ];
    const t2 = [
      { eosID: 'o1', mu: 25, sigma: 8.333, participationRatio: 1.0 },
      { eosID: 'o2', mu: 25, sigma: 8.333, participationRatio: 1.0 }
    ];
    const r = computeRoundUpdate(t1, t2, 'team1win', {}, DEFAULT_PARAMETERS);
    const [half, full] = r.team1Updates;
    if (!nearlyEqual(half.deltaMu, full.deltaMu * 0.5)) {
      throw new Error(`deltaMu not ratio-scaled: half=${half.deltaMu}, full=${full.deltaMu}`);
    }
    if (!nearlyEqual(half.deltaSigma, full.deltaSigma * 0.5)) {
      throw new Error(`deltaSigma not ratio-scaled: half=${half.deltaSigma}, full=${full.deltaSigma}`);
    }
  });

  await runTest('Participation: quit penalty NOT diluted by ratio (gradient not inverted)', async () => {
    // The quit factor is a per-event observation — an early quitter (low
    // participation ratio) must NOT receive a milder penalty than a late one.
    const QUIT = loadParameters({ quitParams: { mQ: -3, vQ: 1 } });
    const quitContribution = (ratio) => {
      const t1 = [{ eosID: 'q', mu: 25, sigma: 8.333, participationRatio: ratio }];
      const t2 = [{ eosID: 'o', mu: 25, sigma: 8.333, participationRatio: 1 }];
      const withQuit = computeRoundUpdate(t1, t2, 'team2win', { q: { quit: true } }, QUIT).team1Updates[0].deltaMu;
      const withoutQuit = computeRoundUpdate(t1, t2, 'team2win', {}, QUIT).team1Updates[0].deltaMu;
      return withQuit - withoutQuit;
    };
    const early = quitContribution(0.2);
    const late = quitContribution(0.45);
    if (!(early < 0)) throw new Error(`quit contribution must be negative, got ${early}`);
    if (Math.abs(early) < 0.85 * Math.abs(late)) {
      throw new Error(`early quitter penalized milder: ${early} vs ${late} — gradient inverted`);
    }
  });

  // --- Squad-offset factor (paper eq. 7) ---

  const TUNED_PARTY = loadParameters({
    partyOffsets: [0, 0, 0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5]
  });
  const four = (prefix) =>
    Array.from({ length: 4 }, (_, i) => ({ eosID: `${prefix}${i}`, mu: 25, sigma: 8.333, participationRatio: 1 }));
  const squadMeta = () => {
    const meta = {};
    for (let i = 0; i < 4; i++) meta[`t1_${i}`] = { partySize: 4 };
    for (let i = 0; i < 4; i++) meta[`t2_${i}`] = { partySize: 1 };
    return meta;
  };

  await runTest('Party offset: 4-stack favoured — smaller gain on win', async () => {
    const baseline = computeRoundUpdate(four('t1_'), four('t2_'), 'team1win', {}, TUNED_PARTY);
    const withSquads = computeRoundUpdate(four('t1_'), four('t2_'), 'team1win', squadMeta(), TUNED_PARTY);
    if (withSquads.team1Updates[0].deltaMu >= baseline.team1Updates[0].deltaMu) {
      throw new Error(
        `favoured squad should gain less on win: ${withSquads.team1Updates[0].deltaMu} vs ${baseline.team1Updates[0].deltaMu}`
      );
    }
  });

  await runTest('Party offset: 4-stack favoured — bigger loss on defeat', async () => {
    const baseline = computeRoundUpdate(four('t1_'), four('t2_'), 'team2win', {}, TUNED_PARTY);
    const withSquads = computeRoundUpdate(four('t1_'), four('t2_'), 'team2win', squadMeta(), TUNED_PARTY);
    if (withSquads.team1Updates[0].deltaMu >= baseline.team1Updates[0].deltaMu) {
      throw new Error('favoured squad losing must yield a more-negative deltaMu');
    }
  });

  await runTest('Party offset: solos (size 1) exactly match baseline', async () => {
    const t1 = [{ eosID: 'a', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const t2 = [{ eosID: 'b', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const baseline = computeRoundUpdate(t1, t2, 'team1win', {}, TUNED_PARTY);
    const withMeta = computeRoundUpdate(t1, t2, 'team1win', { a: { partySize: 1 }, b: { partySize: 1 } }, TUNED_PARTY);
    if (Math.abs(baseline.team1Updates[0].deltaMu - withMeta.team1Updates[0].deltaMu) > 1e-9) {
      throw new Error('partySize=1 must match baseline exactly (partyOffsets[0] === 0)');
    }
  });

  await runTest('Party offset: neutral DEFAULT_PARAMETERS ignore partySize', async () => {
    const t1 = [{ eosID: 'a', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const t2 = [{ eosID: 'b', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const r0 = computeRoundUpdate(t1, t2, 'team1win', {}, DEFAULT_PARAMETERS);
    const r1 = computeRoundUpdate(t1, t2, 'team1win', { a: { partySize: 9 }, b: { partySize: 1 } }, DEFAULT_PARAMETERS);
    if (Math.abs(r0.team1Updates[0].deltaMu - r1.team1Updates[0].deltaMu) > 1e-9) {
      throw new Error('with neutral DEFAULT_PARAMETERS, partySize must have no effect');
    }
  });

  await runTest('Party offset: oversized partySize clamps to last offset entry', async () => {
    const t1 = four('t1_');
    const t2 = four('t2_');
    const metaAt10 = squadMeta();
    const metaAt99 = squadMeta();
    for (let i = 0; i < 4; i++) {
      metaAt10[`t1_${i}`] = { partySize: 10 };
      metaAt99[`t1_${i}`] = { partySize: 99 };
    }
    const r10 = computeRoundUpdate(t1, t2, 'team1win', metaAt10, TUNED_PARTY);
    const r99 = computeRoundUpdate(t1, t2, 'team1win', metaAt99, TUNED_PARTY);
    if (Math.abs(r10.team1Updates[0].deltaMu - r99.team1Updates[0].deltaMu) > 1e-12) {
      throw new Error('partySize beyond the offset table must clamp to the last entry');
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

  // --- Kill/death individual-statistics factor (paper eq. 9) ---

  const TUNED_KD = loadParameters({
    killParams: { wPlayer: 0.1, wOpponent: -0.05, variance: 0.5 },
    deathParams: { wPlayer: -0.05, wOpponent: 0.1, variance: 0.5 }
  });

  await runTest('KD factor: high-scorer gains more than low-scorer on the same win', async () => {
    const t1 = [
      { eosID: 'A', mu: 25, sigma: 8.333, participationRatio: 1 },
      { eosID: 'B', mu: 25, sigma: 8.333, participationRatio: 1 }
    ];
    const t2 = four('e').slice(0, 2);
    const meta = {
      A: { kills: 25, deaths: 5, timePlayedMin: 20 },
      B: { kills: 5, deaths: 25, timePlayedMin: 20 },
      e0: { kills: 10, deaths: 10, timePlayedMin: 20 },
      e1: { kills: 10, deaths: 10, timePlayedMin: 20 }
    };
    const r = computeRoundUpdate(t1, t2, 'team1win', meta, TUNED_KD);
    const baseline = computeRoundUpdate(t1, t2, 'team1win', {}, TUNED_KD);
    // Guaranteed model property: better stats ⇒ strictly better update.
    // (Note: A-vs-baseline is NOT guaranteed — even at-expectation stats add
    // precision anchored near the current mu, damping the win bonus.)
    if (r.team1Updates[0].deltaMu <= r.team1Updates[1].deltaMu) {
      throw new Error('high-scorer A must gain more than under-performer B on the same win');
    }
    if (r.team1Updates[1].deltaMu >= baseline.team1Updates[1].deltaMu) {
      throw new Error('under-performer B must trail the no-stats baseline');
    }
  });

  await runTest('KD factor: high-scorer loses less on the same defeat', async () => {
    const t1 = [
      { eosID: 'A', mu: 25, sigma: 8.333, participationRatio: 1 },
      { eosID: 'B', mu: 25, sigma: 8.333, participationRatio: 1 }
    ];
    const t2 = four('e').slice(0, 2);
    const meta = {
      A: { kills: 30, deaths: 5, timePlayedMin: 20 },
      B: { kills: 5, deaths: 30, timePlayedMin: 20 }
    };
    const r = computeRoundUpdate(t1, t2, 'team2win', meta, TUNED_KD);
    if (r.team1Updates[0].deltaMu <= r.team1Updates[1].deltaMu) {
      throw new Error('high-scorer must lose less than under-performer on the same loss');
    }
  });

  await runTest('KD factor: missing stats leave the update identical to baseline', async () => {
    const t1 = [{ eosID: 'a', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const t2 = [{ eosID: 'b', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const baseline = computeRoundUpdate(t1, t2, 'team1win', {}, TUNED_KD);
    const withEmptyMeta = computeRoundUpdate(t1, t2, 'team1win', { a: { partySize: 1 }, b: { partySize: 1 } }, TUNED_KD);
    if (Math.abs(baseline.team1Updates[0].deltaMu - withEmptyMeta.team1Updates[0].deltaMu) > 1e-9) {
      throw new Error('meta without kills/timePlayedMin must not change the update');
    }
  });

  await runTest('KD factor: neutral DEFAULT_PARAMETERS ignore kill/death stats', async () => {
    const t1 = [{ eosID: 'a', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const t2 = [{ eosID: 'b', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const r0 = computeRoundUpdate(t1, t2, 'team1win', {}, DEFAULT_PARAMETERS);
    const r1 = computeRoundUpdate(
      t1, t2, 'team1win',
      { a: { kills: 50, deaths: 0, timePlayedMin: 20 }, b: { kills: 0, deaths: 50, timePlayedMin: 20 } },
      DEFAULT_PARAMETERS
    );
    if (Math.abs(r0.team1Updates[0].deltaMu - r1.team1Updates[0].deltaMu) > 1e-9) {
      throw new Error('neutral DEFAULT_PARAMETERS must ignore kill/death stats');
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
