/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                        ELO CALCULATOR                         ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Thin, backwards-compatible facade over the TrueSkill2 engine
 * (utils/elo-trueskill2-engine.js). All Gaussian math lives in
 * utils/elo-gauss.js; factor math in utils/elo-trueskill2-factors.js.
 *
 * With the neutral DEFAULT_PARAMETERS this facade reproduces the original
 * closed-form TrueSkill (Herbrich 2007) update exactly — golden-tested
 * against pre-refactor outputs in testing/test-elo-trueskill2-engine.js.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 * EloCalculator (default)
 *   Static-only class. All methods and constants are static.
 *     computeTeamUpdate(team1, team2, outcome)
 *       Legacy entry point — returns raw deltaMu/deltaSigma per player.
 *       Reads BETA/TAU/DRAW_PROBABILITY at CALL TIME so runtime mutation
 *       (tools/elo-calibrate.js parameter sweeps) keeps working.
 *     getDefaultRating()
 *       Returns the default { mu, sigma } for a new player.
 *     BETA, TAU, DRAW_PROBABILITY, MU_DEFAULT, SIGMA_DEFAULT, SIGMA_MULTIPLIER
 *       Configurable static constants exposed for external tuning.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - computeTeamUpdate() returns RAW deltas. The caller must scale by
 *   participationRatio before writing to the database.
 * - deltaSigma is a REDUCTION value, applied as:
 *     newSigma = sigma - deltaSigma
 *   Do NOT change the subtraction to addition.
 * - The MU_DEFAULT, SIGMA_DEFAULT, BETA, and TAU constants form a
 *   mathematically interdependent set. If you wish to change the scale of
 *   the system, you must update all constants proportionally.
 * - TrueSkill2 factors (party offset, experience, quit, kill/death) are
 *   reachable only through computeRoundUpdate() in the engine — this
 *   facade always runs with neutral parameters plus the constants below.
 *
 * Author:
 * Discord: `real_slacker`
 *
 * ═══════════════════════════════════════════════════════════════
 */

import * as gauss from './elo-gauss.js';
import { computeRoundUpdate } from './elo-trueskill2-engine.js';
import { loadParameters } from './elo-parameters.js';

export default class EloCalculator {
  // --- ELO Scale Constants ---
  // WARNING: These constants form an interdependent mathematical set.
  // The system is designed around a 0-50 skill scale (with 25.0 as the midpoint).
  // If you change ONE of these values, you MUST change all others proportionally.
  static MU_DEFAULT = 25.0;              // Base skill estimate for new players
  static SIGMA_DEFAULT = 25.0 / 3.0;     // Initial uncertainty (mu / 3)
  static TAU = 25.0 / 100.0;             // Dynamic uncertainty floor (mu / 100)

  static SIGMA_MULTIPLIER = 3.0; // Used for CSR (Competitive Skill Rank) calculation: CSR = mu - 3 * sigma

  // Configurable constants (exposed as static properties; read at call time)
  static BETA = 25.0 / 6.0;              // Skill chain distance (mu / 6). Affects how fast ratings shift.
  static DRAW_PROBABILITY = 0.01;        // Probability of a draw. (1%)

  // --- Gaussian helpers (delegated to elo-gauss.js; kept for API compat) ---
  static _pdf(x) { return gauss.pdf(x); }
  static _cdf(x) { return gauss.cdf(x); }
  static _erf(x) { return gauss.erf(x); }
  static _erfInv(x) { return gauss.erfInv(x); }
  static _v(t, e) { return gauss.v(t, e); }
  static _w(t, e) { return gauss.w(t, e); }
  static _vDraw(t, e) { return gauss.vDraw(t, e); }
  static _wDraw(t, e) { return gauss.wDraw(t, e); }

  /**
   * Computes the TrueSkill update for two teams (legacy entry point).
   *
   * @param {Array<{mu: number, sigma: number, participationRatio?: number}>} team1
   * @param {Array<{mu: number, sigma: number, participationRatio?: number}>} team2
   * @param {'team1win' | 'team2win' | 'draw'} outcome
   * @returns {{
   *   team1Updates: Array<{deltaMu, deltaSigma, vVal, wVal}>,
   *   team2Updates: Array<{deltaMu, deltaSigma, vVal, wVal}>,
   *   debug?: Object
   * }}
   */
  static computeTeamUpdate(team1, team2, outcome) {
    // Read the statics at call time — elo-calibrate.js mutates them mid-sweep.
    const parameters = loadParameters({
      beta: this.BETA,
      tau: this.TAU,
      drawProbability: this.DRAW_PROBABILITY
    });
    return computeRoundUpdate(team1, team2, outcome, {}, parameters);
  }

  /**
   * Returns the default rating for a new player.
   * @returns {{mu: number, sigma: number}}
   */
  static getDefaultRating() {
    return {
      mu: this.MU_DEFAULT,
      sigma: this.SIGMA_DEFAULT
    };
  }
}
