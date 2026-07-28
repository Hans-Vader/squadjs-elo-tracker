import {
  COUNT_STATS,
  MIN_STAT_SAMPLES,
  MIN_STAT_ROUNDS,
  buildPerPlayerMetaFromLog,
  computeStatNormalization,
  buildCountParams
} from '../utils/elo-calibration-utils.js';
import { computeRoundUpdate } from '../utils/elo-trueskill2-engine.js';
import { loadParameters } from '../utils/elo-parameters.js';

/**
 * Test suite for the shared calibration/replay helpers.
 * Registered in run-all-tests.js; each case runs via runTest(name, fn).
 */
export default async function runCalibrationUtilsTests(runTest) {
  // Synthetic log: `rounds` rounds of 45 min, `perTeam` players per team,
  // constant per-player counts so the expected rates are exact.
  const makeMatches = ({ rounds = 12, perTeam = 10, kills = 6, deaths = 5, revives = 2 } = {}) =>
    Array.from({ length: rounds }, (_, r) => ({
      matchId: `m${r}`,
      outcome: 'team1win',
      roundDuration: 45 * 60000,
      players: Array.from({ length: perTeam * 2 }, (_, i) => ({
        eosID: `p${i}`,
        teamID: i < perTeam ? 1 : 2,
        participationRatio: 1,
        kills,
        deaths,
        revives
      }))
    }));

  await runTest('buildPerPlayerMetaFromLog: maps log fields, missing stats stay undefined', async () => {
    const match = {
      roundDuration: 30 * 60000,
      players: [
        { eosID: 'a', participationRatio: 0.5, squadID: 3, squadSize: 4, kills: 7, deaths: 2, revives: 1, quit: true },
        { eosID: 'old', participationRatio: 1 } // pre-upgrade record
      ]
    };
    const meta = buildPerPlayerMetaFromLog(match, (id) => (id === 'a' ? 42 : 0), true);
    if (meta.a.timePlayedMin !== 15) throw new Error(`timePlayedMin expected 15, got ${meta.a.timePlayedMin}`);
    if (meta.a.experience !== 42 || meta.a.kills !== 7 || meta.a.revives !== 1) throw new Error('field mapping wrong');
    if (meta.a.quit !== true) throw new Error('quit flag must pass through when applyQuit=true');
    if (meta.old.kills !== undefined || meta.old.revives !== undefined) {
      throw new Error('missing stats must stay undefined (keeps factors inert)');
    }
    const gated = buildPerPlayerMetaFromLog(match, () => 0, false);
    if (gated.a.quit !== false) throw new Error('applyQuit=false must suppress quit flags');
  });

  await runTest('computeStatNormalization: exposure-weighted mean/tpBar exact; zero-spread stats excluded', async () => {
    // Half the players 4 kills, half 8 → exact mean 6/45 per minute, sd > 0.
    // Revives stay uniform (2 for everyone) → sd = 0 → must be excluded.
    const matches = makeMatches().map((m) => ({
      ...m,
      players: m.players.map((p, i) => ({ ...p, kills: i % 2 === 0 ? 4 : 8 }))
    }));
    const norm = computeStatNormalization(matches);
    if (Math.abs(norm.kills.mean - 6 / 45) > 1e-12) throw new Error(`kills mean expected ${6 / 45}, got ${norm.kills.mean}`);
    if (!(norm.kills.sd > 0)) throw new Error('kills sd must be positive');
    if (Math.abs(norm.kills.tpBar - 45) > 1e-9) throw new Error(`tpBar expected 45, got ${norm.kills.tpBar}`);
    if (norm.totalRounds !== 12) throw new Error(`totalRounds expected 12, got ${norm.totalRounds}`);
    if (norm.revives) throw new Error('zero-spread stat must be excluded from the bundle');
  });

  await runTest('computeStatNormalization: evidence floor excludes thin stats', async () => {
    // Vary counts so sd > 0, but too few rounds/samples for revives.
    const matches = makeMatches({ rounds: MIN_STAT_ROUNDS + 2 }).map((m, r) => ({
      ...m,
      players: m.players.map((p, i) => ({
        ...p,
        kills: (i + r) % 7,
        deaths: (i + r) % 5,
        // revives only on the last 2 rounds (post-upgrade records)
        ...(r >= MIN_STAT_ROUNDS ? { revives: i % 3 } : { revives: undefined })
      }))
    }));
    const norm = computeStatNormalization(matches);
    if (!norm.kills || !norm.deaths) throw new Error('kills/deaths should pass the evidence floor');
    if (norm.revives) throw new Error(`revives from only 2 rounds must be excluded (floor: ${MIN_STAT_SAMPLES} samples / ${MIN_STAT_ROUNDS} rounds)`);
    if (norm.kills.rounds !== MIN_STAT_ROUNDS + 2) throw new Error('per-stat round coverage wrong');
  });

  await runTest('computeStatNormalization: short-exposure outliers do not inflate the SD', async () => {
    const base = makeMatches({ rounds: 12 }).map((m, r) => ({
      ...m,
      players: m.players.map((p, i) => ({ ...p, kills: (i + r) % 7 }))
    }));
    const unweightedRef = computeStatNormalization(base).kills.sd;
    // Add a 3-minute player with 3 kills (1.0/min vs population ~0.07/min)
    const withOutlier = base.map((m, r) =>
      r === 0
        ? { ...m, players: [...m.players, { eosID: 'blip', teamID: 1, participationRatio: 3 / 45, kills: 3, deaths: 0, revives: 0 }] }
        : m
    );
    const weightedSd = computeStatNormalization(withOutlier).kills.sd;
    // tp-weighting: one 3-minute sample carries 3/45 of a full player's weight,
    // so the SD must move only marginally (an unweighted SD would jump).
    if (weightedSd > unweightedRef * 1.1) {
      throw new Error(`short-exposure outlier inflated sd from ${unweightedRef} to ${weightedSd}`);
    }
  });

  // --- The regression test for the mis-specification bug: with raw counts
  // and no intercept, an AVERAGE performer read as massive over-performance
  // (observed: +35 mu swings). The intercept (wOpponent) must anchor the
  // average performer at their prior.
  const NORM = {
    totalRounds: 100,
    kills: { mean: 0.14, sd: 0.067, n: 8000, rounds: 100, tpBar: 45 },
    deaths: { mean: 0.12, sd: 0.05, n: 8000, rounds: 100, tpBar: 45 },
    revives: { mean: 0.045, sd: 0.045, n: 8000, rounds: 100, tpBar: 45 }
  };
  const BETA = 25 / 6;

  await runTest('buildCountParams: average performer stays anchored at the prior (regression)', async () => {
    const params = loadParameters({ tau: 0, ...buildCountParams(0.25, NORM, BETA) });
    const t1 = [{ eosID: 'A', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const t2 = [{ eosID: 'B', mu: 25, sigma: 8.333, participationRatio: 1 }];
    const avgMeta = (id) => ({
      [id]: {
        kills: Math.round(NORM.kills.mean * 45),
        deaths: Math.round(NORM.deaths.mean * 45),
        revives: Math.round(NORM.revives.mean * 45),
        timePlayedMin: 45
      }
    });
    const r = computeRoundUpdate(t1, t2, 'team1win', { ...avgMeta('A'), ...avgMeta('B') }, params);
    const baseline = computeRoundUpdate(t1, t2, 'team1win', {}, params);
    const drift = Math.abs(r.team1Updates[0].deltaMu - baseline.team1Updates[0].deltaMu);
    // Pre-fix this drift was tens of mu; count messages centred on the mean
    // must leave the win delta nearly untouched (small damping is expected).
    if (drift > 1.5) throw new Error(`average performer drifted ${drift} mu off baseline — intercept broken`);
    if (!Number.isFinite(r.team1Updates[0].deltaMu)) throw new Error('update must stay finite');
  });

  await runTest('buildCountParams: over-performers gain, magnitudes stay sane at λ=1', async () => {
    const params = loadParameters({ tau: 0, ...buildCountParams(1.0, NORM, BETA) });
    const t1 = [
      { eosID: 'star', mu: 25, sigma: 8.333, participationRatio: 1 },
      { eosID: 'avg', mu: 25, sigma: 8.333, participationRatio: 1 }
    ];
    const t2 = [
      { eosID: 'e1', mu: 25, sigma: 8.333, participationRatio: 1 },
      { eosID: 'e2', mu: 25, sigma: 8.333, participationRatio: 1 }
    ];
    const mk = (kills, deaths, revives) => ({ kills, deaths, revives, timePlayedMin: 45 });
    const meta = {
      star: mk(12, 3, 5), // well above expectation
      avg: mk(6, 5, 2),
      e1: mk(6, 5, 2),
      e2: mk(6, 5, 2)
    };
    const r = computeRoundUpdate(t1, t2, 'team1win', meta, params);
    const dStar = r.team1Updates[0].deltaMu;
    const dAvg = r.team1Updates[1].deltaMu;
    if (dStar <= dAvg) throw new Error('over-performer must gain more than the average teammate');
    // Sanity ceiling: even at λ=1 a single round must not swing double digits.
    if (Math.abs(dStar) > 10 || Math.abs(dAvg) > 10) {
      throw new Error(`per-round swing out of bounds: star=${dStar}, avg=${dAvg}`);
    }
  });

  await runTest('buildCountParams: explicit param keys, death sign, stats missing from norm omitted', async () => {
    const partial = { totalRounds: 50, kills: NORM.kills };
    const params = buildCountParams(0.5, partial, BETA);
    if (!params.killParams) throw new Error('killParams missing');
    if (params.deathParams || params.reviveParams) throw new Error('stats absent from norm must be omitted');
    if (!(params.killParams.wPlayer > 0)) throw new Error('kills wPlayer must be positive');
    const full = buildCountParams(0.5, NORM, BETA);
    if (!(full.deathParams.wPlayer < 0)) throw new Error('deaths wPlayer must be negative');
    if (!(full.deathParams.wOpponent > 0)) throw new Error('deaths wOpponent must be positive (stronger opponents ⇒ more deaths)');
    for (const { paramsKey } of COUNT_STATS) {
      const p = full[paramsKey];
      // Intercept property: expected rate of an average matchup = observed mean.
      const expectedRate = (p.wPlayer + p.wOpponent) * 25;
      const stat = COUNT_STATS.find((c) => c.paramsKey === paramsKey).stat;
      if (Math.abs(expectedRate - NORM[stat].mean) > 1e-12) {
        throw new Error(`${paramsKey}: intercept broken — expected rate ${expectedRate} vs mean ${NORM[stat].mean}`);
      }
    }
  });
}
