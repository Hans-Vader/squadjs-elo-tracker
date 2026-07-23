/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                  TRUESKILL2 FACTOR LIBRARY                    ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Pure-math factor library for the TrueSkill2 engine
 * (utils/elo-trueskill2-engine.js). No orchestration here.
 *
 * Gaussian representation: natural-parameter form
 *   precision      π = 1/σ²
 *   precision-mean τ = μ/σ²
 * which is closed under multiplication — the EP combine operation.
 *
 * A "message" is a Gaussian factor contribution in natural form:
 *   { deltaPrecision, deltaPrecisionMean }
 * `combineMessages(prior, messages)` computes
 *   posterior.π = prior.π + Σ mᵢ.deltaPrecision
 *   posterior.τ = prior.τ + Σ mᵢ.deltaPrecisionMean
 *
 * Schedule note (amendment A6): the engine runs ONE PARALLEL EP pass —
 * every factor message is computed from the player's prior and all
 * messages are combined once. Exact when only the team factor is active
 * (neutral defaults); an approximation of iterated EP otherwise.
 */

import * as gauss from './elo-gauss.js';

export const EMPTY_MESSAGE = Object.freeze({ deltaPrecision: 0, deltaPrecisionMean: 0 });

/**
 * Convert (mu, sigma) to natural form.
 * Note: sigma = 0 cannot be represented (infinite precision) and throws;
 * callers uphold the repo-wide 0.5 sigma floor.
 */
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
    throw new Error(`posterior precision <= 0 (${precision}); factor message instability`);
  }
  return { precision, precisionMean };
}

/**
 * Team-comparison factor: the classic TrueSkill two-team update expressed as
 * natural-form messages. Reproduces the pre-refactor
 * EloCalculator.computeTeamUpdate math exactly (golden-tested), with two
 * deliberate differences:
 *   - NO τ² inside the message — dynamics noise is applied ONCE by the engine
 *     after all factor messages are combined (amendment A2, paper step 2(d)).
 *   - v/w carry the inverse-Mills tail guard from elo-gauss.js (amendment A5).
 *
 * @param {Array<{mu, sigma, participationRatio?}>} team1
 * @param {Array<{mu, sigma, participationRatio?}>} team2
 * @param {'team1win'|'team2win'|'draw'} outcome
 * @param {Object} parameters   needs beta, drawProbability
 * @param {Object} teamMeta     optional { team1: { perPlayerShifts }, team2: { perPlayerShifts } }
 *                              per-player additive performance-mean shifts
 *                              (party-offset factor, eq. 7), index-aligned with
 *                              the team arrays. Summed here with the SAME
 *                              ratio-weighting and 50-slot scaling as teamMu so
 *                              the two can never drift apart.
 *
 * @returns {{
 *   empty?: boolean, degenerate?: boolean,
 *   team1Messages: Array, team2Messages: Array,
 *   teamMu1, teamMu2, teamSigmaSq1, teamSigmaSq2, c,
 *   effectiveN1, effectiveN2, nTotal, epsilon, tRaw
 * }}
 * Messages carry { deltaPrecision, deltaPrecisionMean, vVal, wVal }.
 */
export function teamFactorMessages(team1, team2, outcome, parameters, teamMeta = {}) {
  const beta = parameters.beta;
  const drawP = parameters.drawProbability;

  // Edge case: empty teams (legacy parity)
  if (team1.length === 0 && team2.length === 0) {
    return { empty: true, team1Messages: [], team2Messages: [] };
  }

  const getRatio = (p) => p.participationRatio ?? 1.0;

  // Effective headcount (sum of participation ratios), capped at 50 slots to
  // prevent disconnected "ghost" players from inflating variance.
  let effectiveN1 = team1.reduce((sum, p) => sum + getRatio(p), 0);
  let effectiveN2 = team2.reduce((sum, p) => sum + getRatio(p), 0);
  const scale1 = effectiveN1 > 50.0 ? 50.0 / effectiveN1 : 1.0;
  const scale2 = effectiveN2 > 50.0 ? 50.0 / effectiveN2 : 1.0;
  effectiveN1 *= scale1;
  effectiveN2 *= scale2;

  // Party-offset mean shift (eq. 7): each player's performance mean is
  // skill + partyOffset(size); the team mean therefore shifts by the
  // ratio-weighted, slot-scaled sum of the per-player offsets.
  const sumShifts = (team, shifts, scale) => {
    if (!shifts) return 0;
    let total = 0;
    for (let i = 0; i < team.length; i++) {
      total += (shifts[i] ?? 0) * getRatio(team[i]);
    }
    return total * scale;
  };
  const meanShift1 = sumShifts(team1, teamMeta.team1?.perPlayerShifts, scale1);
  const meanShift2 = sumShifts(team2, teamMeta.team2?.perPlayerShifts, scale2);

  const teamMu1 = team1.reduce((sum, p) => sum + p.mu * getRatio(p), 0) * scale1 + meanShift1;
  const teamMu2 = team2.reduce((sum, p) => sum + p.mu * getRatio(p), 0) * scale2 + meanShift2;
  const teamSigmaSq1 =
    team1.reduce((sum, p) => sum + (p.sigma * p.sigma + beta * beta) * getRatio(p), 0) * scale1;
  const teamSigmaSq2 =
    team2.reduce((sum, p) => sum + (p.sigma * p.sigma + beta * beta) * getRatio(p), 0) * scale2;

  const c = Math.sqrt(teamSigmaSq1 + teamSigmaSq2);

  if (c === 0) {
    // Legacy parity: zero updates (only reachable with zero sigma AND zero beta)
    return {
      degenerate: true,
      team1Messages: team1.map(() => EMPTY_MESSAGE),
      team2Messages: team2.map(() => EMPTY_MESSAGE),
      teamMu1,
      teamMu2,
      teamSigmaSq1,
      teamSigmaSq2,
      c,
      effectiveN1,
      effectiveN2
    };
  }

  const nTotal = effectiveN1 + effectiveN2;
  const epsilon = Math.sqrt(nTotal) * beta * Math.sqrt(2) * gauss.erfInv(drawP);
  const tRaw = (teamMu1 - teamMu2) / c;

  const buildMessage = (player, isTeam1) => {
    const sigmaSq = player.sigma * player.sigma;

    let vVal, wVal;
    let isWinner = null;

    if (outcome === 'draw') {
      const t = isTeam1 ? tRaw : -tRaw;
      vVal = gauss.vDraw(t, epsilon / c);
      wVal = gauss.wDraw(t, epsilon / c);
    } else {
      // Win/loss: t from the WINNER's perspective; loser's deltaMu negated below.
      const tWinner = outcome === 'team1win' ? tRaw : -tRaw;
      isWinner = outcome === 'team1win' ? isTeam1 : !isTeam1;
      vVal = gauss.v(tWinner, epsilon / c);
      wVal = gauss.w(tWinner, epsilon / c);
    }

    let deltaMu = (sigmaSq / c) * vVal;
    if (outcome !== 'draw' && !isWinner) deltaMu = -deltaMu;

    const deltaSigmaFactor = Math.min((sigmaSq / (c * c)) * wVal, 1 - 1e-10);
    // No τ² here — see amendment A2.
    const newSigmaSq = sigmaSq * (1 - deltaSigmaFactor);
    const newMu = player.mu + deltaMu;

    // Convert the (mu, sigma) update into a natural-form message:
    //   message.deltaPrecision     = posterior π − prior π
    //   message.deltaPrecisionMean = posterior τ − prior τ
    const priorPrec = 1 / sigmaSq;
    const postPrec = 1 / newSigmaSq;
    return {
      deltaPrecision: postPrec - priorPrec,
      deltaPrecisionMean: newMu * postPrec - player.mu * priorPrec,
      vVal,
      wVal
    };
  };

  return {
    team1Messages: team1.map((p) => buildMessage(p, true)),
    team2Messages: team2.map((p) => buildMessage(p, false)),
    teamMu1,
    teamMu2,
    teamSigmaSq1,
    teamSigmaSq2,
    c,
    effectiveN1,
    effectiveN2,
    nTotal,
    epsilon,
    tRaw
  };
}

/**
 * Quit-penalty factor message (paper Section 9, online form).
 *
 * A quit is one extra one-sided observation of the "mini-game"
 *     D = perf_i − perf_o_i < m_q,  D ~ N(mu_i − muOther, σ² + β² + varOther + v_q)
 * i.e. the standard TrueSkill LOSS update with margin m_q — exactly the
 * paper's own online interpretation (p.18: "a mini-game between the player
 * and a rescaled version of the enemy team").
 *
 * This is the deterministic-quit limit (p_u→0, p_r→1) of the paper's
 * eq.-13 noisy-OR — the STRONGEST possible penalty. The paper itself notes
 * the full model already over-penalizes slightly; calibrate quitParams.mQ
 * before enabling the plugin's quit gate.
 *
 * @param {Object} player       { mu, sigma }
 * @param {number} muOther      mean of the AVERAGE opposing performance
 * @param {number} varOther     variance of that AVERAGE (teamSigmaSq/N², A1)
 * @param {Object} parameters   uses beta, quitParams.{mQ, vQ}
 * @returns {{deltaPrecision, deltaPrecisionMean}}
 */
/**
 * Individual-statistics factor message (paper Section 8, eq. 9).
 *
 * Observation model (c ∈ {kill, death}):
 *   count ~ max(0, N((w_p·perf_i + w_o·perf_o_i)·tp, v·tp))
 * Marginalising perf_i ~ N(skill_i, β²) and perf_o_i ~ N(muOther, varOther):
 *   count | skill_i ~ N(a·skill_i + b, V)
 *   a = w_p·tp,  b = w_o·muOther·tp,  V = w_p²β²tp² + w_o²·varOther·tp² + v·tp
 *
 * count > 0  → exact linear-Gaussian message: {a²/V, a(count−b)/V}.
 * count === 0 → the max(0,·) truncation bites (common in Squad: medics,
 *   logistics). We observe "count ≤ 0" instead — a censored update
 *   (amendment A3) via the same v/w machinery. Note this is the exact
 *   eq.-9 semantics: the latent could be far below 0, so conditioning on
 *   "≤ 0" pulls HARDER than naively pinning the Gaussian at exactly 0
 *   whenever the expected count is well above zero.
 *
 * @param {Object} player        { mu, sigma }
 * @param {number} count         observed kill or death count (≥ 0)
 * @param {number} muOther       mean of the AVERAGE opposing performance
 * @param {number} varOther      variance of that AVERAGE (teamSigmaSq/N², A1)
 * @param {number} timePlayedMin minutes played (paper's tp_i)
 * @param {Object} weightParams  { wPlayer, wOpponent, variance } — killParams or deathParams
 * @param {Object} parameters    uses .beta
 * @returns {{deltaPrecision, deltaPrecisionMean}}
 */
export function killDeathFactorMessage(player, count, muOther, varOther, timePlayedMin, weightParams, parameters) {
  if (!(timePlayedMin > 0) || !Number.isFinite(count)) return EMPTY_MESSAGE;
  const { wPlayer: wP, wOpponent: wO, variance: v } = weightParams ?? {};
  if (!wP) return EMPTY_MESSAGE; // a = 0 ⇒ message is identically zero
  const beta = parameters.beta;
  const tp = timePlayedMin;

  const a = wP * tp;
  const b = (wO ?? 0) * muOther * tp;
  const V = wP * wP * beta * beta * tp * tp + (wO ?? 0) * (wO ?? 0) * varOther * tp * tp + (v ?? 0) * tp;
  if (!(V > 0)) return EMPTY_MESSAGE;

  if (count > 0) {
    // Exact linear-Gaussian observation on skill_i.
    return {
      deltaPrecision: (a * a) / V,
      deltaPrecisionMean: (a * (count - b)) / V
    };
  }

  // Censored update: observe count ≤ 0 under count ~ N(a·mu + b, V + a²σ²).
  const sigmaSq = player.sigma * player.sigma;
  const s = Math.sqrt(V + a * a * sigmaSq);
  if (!(s > 0)) return EMPTY_MESSAGE;
  const t = (a * player.mu + b) / s;
  const vWin = gauss.v(-t, 0); // λ = φ(t)/Φ(−t), tail-guarded
  const wVal = gauss.w(-t, 0);

  const newMu = player.mu - ((a * sigmaSq) / s) * vWin;
  const safeFactor = Math.min(((a * a * sigmaSq) / (s * s)) * wVal, 1 - 1e-10);
  const newSigmaSq = sigmaSq * (1 - safeFactor);

  const priorPrec = 1 / sigmaSq;
  const postPrec = 1 / newSigmaSq;
  return {
    deltaPrecision: postPrec - priorPrec,
    deltaPrecisionMean: newMu * postPrec - player.mu * priorPrec
  };
}

export function quitFactorMessage(player, muOther, varOther, parameters) {
  const sigmaSq = player.sigma * player.sigma;
  const beta = parameters.beta;
  const { mQ, vQ } = parameters.quitParams ?? {};
  if (!Number.isFinite(mQ) || !(vQ > 0)) return EMPTY_MESSAGE;

  const totalVar = sigmaSq + beta * beta + varOther + vQ;
  const c = Math.sqrt(totalVar);
  if (!(c > 0)) return EMPTY_MESSAGE;

  // Observe D < mQ ⇒ standard loss update from the "winner" (mini-game
  // opponent) perspective: t_win = −t with t = (E[D] − mQ)/c.
  const t = (player.mu - muOther - mQ) / c;
  const vWin = gauss.v(-t, 0); // ≥ 0; tail-guarded
  const wVal = gauss.w(-t, 0); // ∈ (0, 1); tail-guarded

  const newMu = player.mu - (sigmaSq / c) * vWin;
  const safeFactor = Math.min((sigmaSq / (c * c)) * wVal, 1 - 1e-10);
  const newSigmaSq = sigmaSq * (1 - safeFactor);

  const priorPrec = 1 / sigmaSq;
  const postPrec = 1 / newSigmaSq;
  return {
    deltaPrecision: postPrec - priorPrec,
    deltaPrecisionMean: newMu * postPrec - player.mu * priorPrec
  };
}
