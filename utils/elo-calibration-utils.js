/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                  CALIBRATION / REPLAY UTILS                   ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Shared helpers for the offline replay tools (tools/elo-calibrate.js,
 * tools/elo-rebuild.js): the match-log → perPlayerMeta mapping and the
 * count-stat normalisation behind the calibrator's λ sweep. One source so
 * a new stat cannot be wired into one tool and forgotten in the other.
 *
 * ── The λ scheme ────────────────────────────────────────────────
 * The eq.-9 count model is  count ~ N((wP·perf + wO·perf_o)·tp, v·tp)
 * with NO constant term — raw counts therefore need an intercept, or an
 * average player reads as massive over-performance. Per stat c we set:
 *
 *   wPlayer_c   = sign_c · λ · SD_c / β
 *       (a player 1β above average is expected to produce λ SDs more
 *        of the stat's per-minute rate — equal information per SD
 *        across stats, so medics and shooters weigh alike)
 *   wOpponent_c = mean_c / mu0 − wPlayer_c
 *       (intercept: an average player vs average opposition — both at
 *        mu0 — is expected to produce exactly the observed mean rate;
 *        for deaths this also gives the correct "stronger opponents ⇒
 *        more deaths" direction)
 *   variance_c  = SD_c² · tp̄_c
 *       (V = v·tp matches the observed per-round count spread at mean
 *        exposure: V(tp̄) = (SD_c·tp̄)²)
 *
 * mean/SD are EXPOSURE-WEIGHTED per-minute rates (weight = tp): a rate
 * observed over tp minutes has sampling variance ∝ 1/tp, so tp-weighting
 * is inverse-variance weighting and stops short rounds / low-participation
 * players from inflating the SD.
 */

export const COUNT_STATS = [
  { stat: 'kills', sign: +1, paramsKey: 'killParams' },
  { stat: 'deaths', sign: -1, paramsKey: 'deathParams' },
  { stat: 'revives', sign: +1, paramsKey: 'reviveParams' }
];

// Minimum evidence before a stat joins the λ bundle: an SD estimated from a
// handful of player-rounds (e.g. revives present only on the newest log
// records) is noise, not signal.
export const MIN_STAT_SAMPLES = 200; // player-round observations
export const MIN_STAT_ROUNDS = 10; // distinct rounds carrying the stat

/**
 * Match-log record → engine perPlayerMeta. Fields absent on pre-upgrade
 * records (kills/revives/...) stay undefined, which keeps the corresponding
 * engine factors inert for those rounds.
 *
 * @param {Object} match          parsed match-log line (players, roundDuration)
 * @param {(eosID: string) => number} experienceOf  rounds played BEFORE this round
 * @param {boolean} applyQuit     feed logged quit flags to the engine
 */
export function buildPerPlayerMetaFromLog(match, experienceOf, applyQuit) {
  const durMin = (match.roundDuration ?? 0) / 60000;
  const perPlayerMeta = {};
  for (const p of match.players) {
    perPlayerMeta[p.eosID] = {
      squadID: p.squadID ?? 0,
      squadSize: p.squadSize ?? 1,
      experience: experienceOf(p.eosID),
      kills: p.kills,
      deaths: p.deaths,
      revives: p.revives,
      timePlayedMin: durMin * (p.participationRatio ?? 1),
      quit: applyQuit ? (p.quit ?? false) : false
    };
  }
  return perPlayerMeta;
}

/**
 * Exposure-weighted per-minute mean/SD for each count stat, plus per-stat
 * coverage (sample count, rounds carrying the stat, mean exposure tp̄).
 * Stats below the evidence floor are omitted from the result.
 *
 * @param {Array} matches  parsed match-log records
 * @returns {Object} { totalRounds, [stat]: { mean, sd, n, rounds, tpBar } }
 */
export function computeStatNormalization(matches) {
  const acc = {};
  for (const { stat } of COUNT_STATS) {
    acc[stat] = { sumTp: 0, sumCount: 0, samples: [], rounds: 0 };
  }
  let totalRounds = 0;

  for (const match of matches) {
    const durMin = (match.roundDuration ?? 0) / 60000;
    if (!(durMin > 0)) continue;
    totalRounds++;
    const statsInRound = new Set();
    for (const p of match.players) {
      const tp = durMin * (p.participationRatio ?? 1);
      if (!(tp > 0)) continue;
      for (const { stat } of COUNT_STATS) {
        if (!Number.isFinite(p[stat])) continue;
        acc[stat].sumTp += tp;
        acc[stat].sumCount += p[stat];
        acc[stat].samples.push({ rate: p[stat] / tp, tp });
        statsInRound.add(stat);
      }
    }
    for (const stat of statsInRound) acc[stat].rounds++;
  }

  const norm = { totalRounds };
  for (const { stat } of COUNT_STATS) {
    const a = acc[stat];
    const n = a.samples.length;
    if (n < MIN_STAT_SAMPLES || a.rounds < MIN_STAT_ROUNDS || !(a.sumTp > 0)) continue;
    const mean = a.sumCount / a.sumTp;
    const weightedVar = a.samples.reduce((s, x) => s + x.tp * (x.rate - mean) ** 2, 0) / a.sumTp;
    const sd = Math.sqrt(weightedVar);
    if (!(sd > 0)) continue;
    norm[stat] = { mean, sd, n, rounds: a.rounds, tpBar: a.sumTp / n };
  }
  return norm;
}

/**
 * λ → concrete { killParams, deathParams, reviveParams } (present stats only).
 * See the module header for the formulas and why the intercept is mandatory.
 *
 * @param {number} lambda  individual-performance strength (0 = all off)
 * @param {Object} norm    computeStatNormalization() result
 * @param {number} beta    performance noise β of the parameter set
 * @param {number} mu0     prior mean (default 25 — the repo scale midpoint)
 */
export function buildCountParams(lambda, norm, beta, mu0 = 25.0) {
  const params = {};
  for (const { stat, sign, paramsKey } of COUNT_STATS) {
    const s = norm[stat];
    if (!s) continue;
    const wPlayer = (sign * lambda * s.sd) / beta;
    params[paramsKey] = {
      wPlayer,
      wOpponent: s.mean / mu0 - wPlayer,
      variance: s.sd * s.sd * s.tpBar
    };
  }
  return params;
}
