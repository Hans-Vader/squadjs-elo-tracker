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
 *                              (squad-offset factor, eq. 7), index-aligned with
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

  // Squad-offset mean shift (eq. 7): each player's performance mean is
  // skill + squadOffset(size); the team mean therefore shifts by the
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
