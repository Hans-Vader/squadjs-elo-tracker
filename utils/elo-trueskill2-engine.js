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
  teamFactorMessages
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
  const teamMeta = {}; // squad-offset mean shifts arrive with the eq.-7 factor
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

  const buildUpdate = (player, teamMessage) => {
    const prior = fromMuSigma(player.mu, player.sigma);
    const posterior = combineMessages(prior, [teamMessage]);
    const { mu, sigma } = toMuSigma(posterior);

    // Dynamics noise applied ONCE, after all factor messages (amendment A2).
    const newSigma = Math.sqrt(sigma * sigma + tau * tau);

    return {
      deltaMu: mu - player.mu,
      deltaSigma: player.sigma - newSigma,
      vVal: teamMessage.vVal ?? 0,
      wVal: teamMessage.wVal ?? 0
    };
  };

  const team1Updates = team1.map((p, i) => buildUpdate(p, tfm.team1Messages[i]));
  const team2Updates = team2.map((p, i) => buildUpdate(p, tfm.team2Messages[i]));

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
