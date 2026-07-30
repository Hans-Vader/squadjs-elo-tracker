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
  quitFactorMessage,
  killDeathFactorMessage
} from './elo-trueskill2-factors.js';
import { partyOffsetAt } from './elo-parameters.js';

/**
 * Run a single round through the TrueSkill2 inference pipeline.
 *
 * @param {Array<{eosID?, mu, sigma, participationRatio?}>} team1
 * @param {Array<{eosID?, mu, sigma, participationRatio?}>} team2
 * @param {'team1win'|'team2win'|'draw'} outcome
 * @param {Object} perPlayerMeta  eosID → { partySize, clanTag, kills, deaths,
 *                                quit, experience, timePlayedMin } (all optional)
 * @param {Object} parameters     frozen object from elo-parameters.js
 * @param {Object} [options]
 *   scaleTeamDeltaByRatio {boolean} default true — apply each player's
 *   participationRatio to the TEAM factor's delta inside the engine (partial
 *   play). The quit, kill/death and experience contributions are per-event or
 *   already time-normalized and enter UNSCALED — the old caller-side blanket
 *   scaling diluted them and inverted the quit-penalty gradient (an earlier
 *   quit got a milder penalty). The legacy computeTeamUpdate facade passes
 *   false to keep its raw-delta contract.
 *
 * @returns {{ team1Updates, team2Updates, debug? }}
 *   Updates are FINAL: newMu = mu + deltaMu and newSigma = sigma − deltaSigma
 *   (callers floor sigma). No caller-side participation scaling.
 */
export function computeRoundUpdate(team1, team2, outcome, perPlayerMeta, parameters, options = {}) {
  const scaleTeamDeltaByRatio = options.scaleTeamDeltaByRatio ?? true;
  // Party-offset factor (eq. 7): per-player performance-mean shift by clan-tag
  // party size. partyOffsets[0] (solo) is pinned to 0, so partySize=1 yields no
  // shift. Ratio-weighting and slot-scaling happen inside teamFactorMessages.
  const partyShifts = (team) => {
    const offsets = parameters.partyOffsets;
    if (!offsets || offsets.length === 0) return null;
    return team.map((p) => partyOffsetAt(offsets, perPlayerMeta[p.eosID]?.partySize ?? 1));
  };

  const teamMeta = {
    team1: { perPlayerShifts: partyShifts(team1) },
    team2: { perPlayerShifts: partyShifts(team2) }
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

    // Kill/death observations (eq. 9) need a play-time to normalize against.
    const tp = meta.timePlayedMin;
    if (tp > 0) {
      if (Number.isFinite(meta.kills)) {
        messages.push(
          killDeathFactorMessage(player, meta.kills, opponentMu, opponentVar, tp, parameters.killParams, parameters)
        );
      }
      if (Number.isFinite(meta.deaths)) {
        messages.push(
          killDeathFactorMessage(player, meta.deaths, opponentMu, opponentVar, tp, parameters.deathParams, parameters)
        );
      }
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

    let deltaMu = newMu - player.mu;
    let deltaSigma = player.sigma - newSigma;

    // Partial play: scale ONLY the team factor's contribution by the played
    // fraction (legacy convention, bit-exact on the team-only path). The
    // remaining contributions (quit, kill/death, experience) are per-event or
    // already time-normalized and stay unscaled.
    const ratio = player.participationRatio ?? 1;
    if (scaleTeamDeltaByRatio && ratio !== 1) {
      const teamOnly = toMuSigma(combineMessages(prior, [teamMessage]));
      const teamSigma = Math.sqrt(teamOnly.sigma * teamOnly.sigma + tau * tau);
      deltaMu = (teamOnly.mu - player.mu) * ratio + (newMu - teamOnly.mu);
      deltaSigma = (player.sigma - teamSigma) * ratio + (teamSigma - newSigma);
    }

    return {
      deltaMu,
      deltaSigma,
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
