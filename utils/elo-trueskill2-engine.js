/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                     TRUESKILL2 ENGINE                         ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Orchestrates the TrueSkill2 factors (utils/elo-trueskill2-factors.js)
 * into a per-round rating update. One PARALLEL EP pass: every factor
 * message is computed from the player's prior; messages are combined
 * once; dynamics noise (τ²) is applied once at the end (paper step 2(d),
 * amendment A2).
 *
 * With neutral DEFAULT_PARAMETERS and empty perPlayerMeta this reproduces
 * the pre-refactor closed-form TrueSkill update exactly (golden-tested in
 * testing/test-elo-trueskill2-engine.js).
 */

import {
  fromMuSigma,
  toMuSigma,
  combineMessages,
  teamFactorMessages,
  quitFactorMessage
} from './elo-trueskill2-factors.js';

/**
 * Run a single round through the TrueSkill2 inference pipeline.
 *
 * @param {Array<{eosID?, mu, sigma, participationRatio?}>} team1
 * @param {Array<{eosID?, mu, sigma, participationRatio?}>} team2
 * @param {'team1win'|'team2win'|'draw'} outcome
 * @param {Object} perPlayerMeta  eosID → { squadSize, squadID, kills, deaths,
 *                                quit, experience, timePlayedMin } (all optional)
 * @param {Object} parameters     frozen object from elo-parameters.js
 *
 * @returns {{ team1Updates, team2Updates, debug? }}
 *   Updates use the legacy convention: caller scales by participationRatio,
 *   then newMu = mu + deltaMu and newSigma = sigma − deltaSigma.
 */
export function computeRoundUpdate(team1, team2, outcome, perPlayerMeta, parameters) {
  // Squad-offset factor (eq. 7): per-player performance-mean shifts by squad
  // size. squadOffsets[0] (solo) is pinned to 0, so the default squadSize=1
  // yields no shift. Ratio-weighting and slot-scaling happen inside
  // teamFactorMessages, next to the teamMu computation they must mirror.
  const squadShifts = (team) => {
    const offsets = parameters.squadOffsets;
    if (!offsets || offsets.length === 0) return null;
    return team.map((p) => {
      const size = perPlayerMeta[p.eosID]?.squadSize ?? 1;
      const idx = Math.min(Math.max(size - 1, 0), offsets.length - 1);
      return offsets[idx] ?? 0;
    });
  };

  const teamMeta = {
    team1: { perPlayerShifts: squadShifts(team1) },
    team2: { perPlayerShifts: squadShifts(team2) }
  };
  const tfm = teamFactorMessages(team1, team2, outcome, parameters, teamMeta);

  // Legacy parity for degenerate inputs
  if (tfm.empty) {
    return { team1Updates: [], team2Updates: [] };
  }
  if (tfm.degenerate) {
    return {
      team1Updates: team1.map(() => ({ deltaMu: 0, deltaSigma: 0, vVal: 0, wVal: 0 })),
      team2Updates: team2.map(() => ({ deltaMu: 0, deltaSigma: 0, vVal: 0, wVal: 0 }))
    };
  }

  const tau = parameters.tau ?? 0;

  // Opposing-team AVERAGE performance statistics for the quit and kill/death
  // factors. teamMu is a ratio-weighted SUM, so the average divides by
  // effectiveN once; the variance of the average divides by N TWICE
  // (amendment A1 — Var[mean] = Var[sum]/N²).
  const safeN1 = Math.max(tfm.effectiveN1, 1e-9);
  const safeN2 = Math.max(tfm.effectiveN2, 1e-9);
  const team1OtherMu = tfm.teamMu2 / safeN2;
  const team2OtherMu = tfm.teamMu1 / safeN1;
  const team1OtherVar = tfm.teamSigmaSq2 / (safeN2 * safeN2);
  const team2OtherVar = tfm.teamSigmaSq1 / (safeN1 * safeN1);

  // Experience offset (eq. 8): biased random walk on skill after each match,
  // win or lose. Index = matches played before this round, clamped to the table.
  const experienceShift = (player) => {
    const offsets = parameters.experienceOffsets;
    if (!offsets || offsets.length === 0) return 0;
    const exp = perPlayerMeta[player.eosID]?.experience ?? 0;
    const idx = Math.min(Math.max(Math.floor(exp), 0), offsets.length - 1);
    return offsets[idx] ?? 0;
  };

  // Collect all factor messages for one player (parallel EP pass, A6).
  const buildMessages = (player, teamMessage, opponentMu, opponentVar) => {
    const messages = [teamMessage];
    const meta = perPlayerMeta[player.eosID];
    if (!meta) return messages;

    if (meta.quit) {
      messages.push(quitFactorMessage(player, opponentMu, opponentVar, parameters));
    }
    return messages;
  };

  const buildUpdate = (player, teamMessage, opponentMu, opponentVar) => {
    const prior = fromMuSigma(player.mu, player.sigma);
    const messages = buildMessages(player, teamMessage, opponentMu, opponentVar);
    const { mu, sigma } = toMuSigma(combineMessages(prior, messages));

    // Dynamics noise applied ONCE, after all factor messages (amendment A2).
    const newSigma = Math.sqrt(sigma * sigma + tau * tau);
    const newMu = mu + experienceShift(player);

    return {
      deltaMu: newMu - player.mu,
      deltaSigma: player.sigma - newSigma,
      vVal: teamMessage.vVal ?? 0,
      wVal: teamMessage.wVal ?? 0
    };
  };

  const team1Updates = team1.map((p, i) => buildUpdate(p, tfm.team1Messages[i], team1OtherMu, team1OtherVar));
  const team2Updates = team2.map((p, i) => buildUpdate(p, tfm.team2Messages[i], team2OtherMu, team2OtherVar));

  return {
    team1Updates,
    team2Updates,
    debug: {
      teamMu1: tfm.teamMu1,
      teamMu2: tfm.teamMu2,
      teamSigmaSq1: tfm.teamSigmaSq1,
      teamSigmaSq2: tfm.teamSigmaSq2,
      c: tfm.c,
      effectiveN1: tfm.effectiveN1,
      effectiveN2: tfm.effectiveN2,
      nTotal: tfm.nTotal,
      epsilon: tfm.epsilon,
      tRaw: tfm.tRaw,
      vVal: team1Updates.length > 0 ? team1Updates[0].vVal : 0,
      wVal: team1Updates.length > 0 ? team1Updates[0].wVal : 0
    }
  };
}
