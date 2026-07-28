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
  const offsetsArray = Array.from({ length: 10 }, () => 0.0);
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

    // --- Party offset (eq. 7). Index i = party size i+1. ---
    // Clan-tag co-membership per team (NOT in-game squads). NEUTRAL by default.
    // partyOffsets[0] (solo) is pinned to 0 for identifiability.
    partyOffsets: offsetsArray,

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
 * Clamped eq.-7 offset lookup, shared by the engine and the calibrator so the
 * indexing rule (index = partySize − 1, clamped to the table, missing ⇒ 0)
 * exists exactly once.
 */
export function partyOffsetAt(offsets, size) {
  if (!offsets || offsets.length === 0) return 0;
  const idx = Math.min(Math.max((size ?? 1) - 1, 0), offsets.length - 1);
  return offsets[idx] ?? 0;
}

/**
 * Range/type validation for a merged parameter object. The `trueskill2`
 * config block is hand-edited JSON (SquadJS config.json) — typos like
 * `drawProbability: 1` (⇒ erfInv(1) = Infinity) or a German decimal-comma
 * string `"7,5"` compute to Infinity/NaN WITHOUT throwing and would be
 * silently persisted as ratings every round. Fail fast at load instead.
 */
function validateParameters(params) {
  const fin = (v) => typeof v === 'number' && Number.isFinite(v);
  const fail = (key, value, rule) => {
    throw new Error(`Invalid trueskill2 config: ${key} = ${JSON.stringify(value)} — ${rule}`);
  };

  if (!fin(params.mu0)) fail('mu0', params.mu0, 'must be a finite number');
  if (!fin(params.v0) || !(params.v0 > 0)) fail('v0', params.v0, 'must be a finite number > 0');
  if (!fin(params.beta) || !(params.beta > 0)) fail('beta', params.beta, 'must be a finite number > 0');
  if (!fin(params.tau) || params.tau < 0) fail('tau', params.tau, 'must be a finite number >= 0');
  if (!fin(params.tauPerMinute) || params.tauPerMinute < 0) {
    fail('tauPerMinute', params.tauPerMinute, 'must be a finite number >= 0');
  }
  if (!fin(params.drawProbability) || params.drawProbability < 0 || params.drawProbability >= 1) {
    fail('drawProbability', params.drawProbability, 'must be a number in [0, 1) — e.g. 0.01 for 1%');
  }
  for (const key of ['partyOffsets', 'experienceOffsets']) {
    params[key].forEach((entry, i) => {
      if (!fin(entry)) fail(`${key}[${i}]`, entry, 'must be a finite number');
    });
  }
  for (const key of ['killParams', 'deathParams']) {
    const o = params[key];
    if (!fin(o.wPlayer)) fail(`${key}.wPlayer`, o.wPlayer, 'must be a finite number');
    if (!fin(o.wOpponent)) fail(`${key}.wOpponent`, o.wOpponent, 'must be a finite number');
    if (!fin(o.variance) || o.variance < 0) fail(`${key}.variance`, o.variance, 'must be a finite number >= 0');
  }
  if (!fin(params.quitParams.mQ) || params.quitParams.mQ > 0) {
    fail('quitParams.mQ', params.quitParams.mQ, 'must be a finite number <= 0 (paper constraint; positive would reward quitting)');
  }
  if (!fin(params.quitParams.vQ) || !(params.quitParams.vQ > 0)) {
    fail('quitParams.vQ', params.quitParams.vQ, 'must be a finite number > 0');
  }
}

/**
 * Build a parameter object by merging user overrides onto the defaults.
 * - Arrays are merged element-wise and keep the canonical default length.
 * - Plain objects are shallow-merged (nested defaults survive partial overrides).
 * - `undefined`/`null` overrides are ignored.
 * - partyOffsets[0] is forced back to 0 (identifiability).
 * - The merged result is validated (see validateParameters) — invalid values
 *   throw here, at plugin mount / tool start, never mid-round.
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
  params.partyOffsets[0] = 0; // paper fixes offset(1) = 0
  validateParameters(params);
  return deepFreeze(params);
}
