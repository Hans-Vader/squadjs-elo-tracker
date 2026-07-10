/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                   TRUESKILL2 PARAMETERS                       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Central TrueSkill2 parameter object. Every tunable parameter of the
 * rating engine lives here. Definitions and equation numbers below refer
 * to Minka, Cleven & Zaykov 2018, "TrueSkill 2" (Microsoft Research
 * MSR-TR-2018-8):
 * https://www.microsoft.com/en-us/research/publication/trueskill-2-improved-bayesian-skill-rating-system/
 *
 * Scale: 0–50 (existing repo convention, β = 25/6 ≈ 4.167 vs the paper's
 * β = 1). Any β-relative magnitude taken from the paper must be multiplied
 * by 4.167 before being used here.
 *
 * Defaults are NEUTRAL: every TrueSkill2 feature is disabled out of the
 * box (all offsets zero, kill/death weights zero), so the engine
 * reproduces classic TrueSkill behaviour until the operator opts in.
 *
 * Operators turn features on by:
 *   (a) setting non-zero values in the plugin's `trueskill2` config block, or
 *   (b) running `tools/elo-calibrate.js` on the match log and copying the
 *       resulting parameters into config.
 *
 * The paper's Halo-derived values do not transfer to Squad — calibrate.
 */

const SCALE = 25.0 / 6.0; // = repo β; ratio repo:paper = 4.167:1

function buildDefaults() {
  return {
    // --- Prior on skill (eq. 1) ---
    mu0: 25.0,
    v0: (25.0 / 3.0) ** 2, // matches existing SIGMA_DEFAULT²

    // --- Performance noise (eq. 4) ---
    beta: SCALE, // 4.167

    // --- Dynamics noise (eq. 2 / 3) ---
    // Per-match drift σ (the paper's γ). Applied ONCE per round, after all
    // factor messages are combined (amendment A2 / paper step 2(d)).
    tau: 25.0 / 100.0,
    tauPerMinute: 0, // time-based drift (paper's τ, eq. 3); 0 disables it

    // --- Draw margin ---
    drawProbability: 0.01,

    // --- Squad offset (eq. 7). Index i = squad size i+1. ---
    // NEUTRAL by default. squadOffsets[0] (solo) is pinned to 0 for
    // identifiability (the paper fixes squadOffset(1) = 0).
    // Note: Squad "squads" are in-game squads (max 9), not the pre-made
    // parties of the paper — calibrate before trusting the signal.
    squadOffsets: Array.from({ length: 10 }, () => 0.0),

    // --- Experience offset (eq. 8). Index = matches played, capped at 199. ---
    // NEUTRAL by default. Applied to mu after every match, win or lose.
    experienceOffsets: Array.from({ length: 200 }, () => 0.0),

    // --- Kill factor (eq. 9, c = kill) ---
    // count ~ max(0, N((w_p·perf_i + w_o·perf_o_i)·tp, v·tp))
    // NEUTRAL: zero weights make the factor message identically zero.
    killParams: {
      wPlayer: 0.0,
      wOpponent: 0.0,
      variance: 1.0 // v^kill; any positive value; ignored while weights are zero
    },

    // --- Death factor (eq. 9, c = death) ---
    deathParams: {
      wPlayer: 0.0,
      wOpponent: 0.0,
      variance: 1.0
    },

    // --- Quit factor (eq. 12; deterministic-quit limit of eq. 13) ---
    // Implemented as the paper's online "mini-game" interpretation (p.18):
    // a quit is one extra one-sided observation perf_i − perf_o_i < m_q.
    // This is the p_u→0, p_r→1 limit of eq. 13 — the strongest possible
    // penalty (the eq.-13 mixture params are deliberately NOT modelled).
    // m_q ≤ 0 (paper constraint); v_q > 0.
    // Default m_q = −2.08 yields ≈ −4.7 mu per quit at default sigma —
    // larger than a typical round swing. CALIBRATE before enabling the
    // plugin's `enableQuitPenalty` gate.
    quitParams: {
      mQ: -SCALE * 0.5, // −2.083
      vQ: 1.0
    }
    // NOTE: quit *detection* thresholds (quitGraceSeconds,
    // quitParticipationThreshold, enableQuitPenalty) are plugin options in
    // plugins/elo-tracker.js — they govern observation, not inference.
  };
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const key of Object.keys(obj)) deepFreeze(obj[key]);
  }
  return obj;
}

export const DEFAULT_PARAMETERS = deepFreeze(buildDefaults());

/**
 * Build a parameter object by merging user overrides onto the defaults.
 * - Arrays are merged element-wise and keep the canonical default length.
 * - Plain objects are shallow-merged (nested defaults survive partial overrides).
 * - `undefined`/`null` overrides are ignored.
 * - squadOffsets[0] is forced back to 0 (identifiability).
 *
 * @param {Object} overrides
 * @returns {Object} deep-frozen parameter object
 */
export function loadParameters(overrides = {}) {
  const params = buildDefaults();
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null) continue;
    if (!(key in params)) continue; // unknown keys are ignored, not smuggled in
    if (Array.isArray(params[key]) && Array.isArray(value)) {
      const merged = params[key].slice();
      for (let i = 0; i < value.length && i < merged.length; i++) {
        if (value[i] !== undefined && value[i] !== null) merged[i] = value[i];
      }
      params[key] = merged;
    } else if (
      typeof params[key] === 'object' &&
      params[key] !== null &&
      typeof value === 'object'
    ) {
      params[key] = { ...params[key], ...value };
    } else {
      params[key] = value;
    }
  }
  params.squadOffsets[0] = 0; // paper fixes squadOffset(1) = 0
  return deepFreeze(params);
}
