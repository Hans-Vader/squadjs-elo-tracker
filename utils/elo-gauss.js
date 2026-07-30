/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                    GAUSSIAN MATH HELPERS                      ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Standard-normal helpers shared by the legacy EloCalculator facade and
 * the TrueSkill2 factor library. Extracted from elo-calculator.js to break
 * the factors → calculator → engine → factors import cycle.
 *
 * - erf uses Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7); erfInv uses the
 *   Winitzki approximation. Both are fast and accurate enough for TrueSkill.
 * - cdf switches to a complementary-error-function continued fraction for the
 *   far negative tail (x <= -5.66). The 0.5·(1+erf) form loses all relative
 *   accuracy there: erf's round trip through 1 quantizes the tail to a few
 *   multiples of machine epsilon, and w = v·(v+x) amplifies that into garbage
 *   (negative w — a flipped sigma-update direction) in the band x ∈ (-8.4, -7.5).
 * - v/w carry an inverse-Mills tail guard (amendment A5): when cdf(t-e)
 *   underflows to exactly 0 (t - e below ~ -38.6, where exp(-x²/2) underflows),
 *   the exact asymptotes are returned (v → e - t, w → 1) instead of the legacy
 *   0 — a zero there would silently erase the update for an extreme upset,
 *   the wrong direction entirely.
 */

export function pdf(x) {
  return (1 / Math.sqrt(2 * Math.PI)) * Math.exp(-0.5 * x * x);
}

/**
 * Error function (erf) approximation.
 * Source: Abramowitz & Stegun 7.1.26
 */
export function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);

  return sign * y;
}

/**
 * erfc(z) for z >= 4 via the standard continued fraction
 *   erfc(z) = exp(-z²)/√π · 1/(z + K_{n≥1}((n/2)/z)),
 * evaluated by backward recurrence. Relative error < 1e-13 in this range —
 * the A&S polynomial is only absolute-accurate (1.5e-7) and drifts to ~1-16%
 * RELATIVE error in the deep tail, which w = v·(v+x) amplifies unacceptably.
 */
function erfcTail(z) {
  let t = 0;
  for (let n = 60; n >= 1; n--) t = n / 2 / (z + t);
  return Math.exp(-z * z) / Math.sqrt(Math.PI) / (z + t);
}

export function cdf(x) {
  if (x < 0) {
    const z = -x / Math.SQRT2;
    if (z >= 4) return 0.5 * erfcTail(z); // far tail: relative-accurate, no cancellation
  }
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Inverse error function (erfInv) approximation.
 * Source: Winitzki approximation
 */
export function erfInv(x) {
  const a = 0.147;
  const lnTerm = Math.log(1 - x * x);
  const term1 = 2 / (Math.PI * a) + lnTerm / 2;
  const term2 = lnTerm / a;
  const sign = x < 0 ? -1 : 1;

  return sign * Math.sqrt(Math.sqrt(term1 * term1 - term2) - term1);
}

/**
 * Win mean-correction factor V (inverse Mills ratio).
 * Tail guard: v(x) → -x as x → -∞, i.e. e - t here.
 */
export function v(t, e) {
  const denom = cdf(t - e);
  if (denom === 0) return e - t; // asymptote (was 0 in legacy — wrong direction)
  return pdf(t - e) / denom;
}

/**
 * Win variance-correction factor W ∈ (0, 1).
 * Tail guard: w → 1 as t - e → -∞ (the outcome was maximally informative).
 * Defensively clamped to [0, 1]: floating noise must never flip the sigma
 * update direction (w < 0) or overshoot the full-shrink limit (w > 1).
 */
export function w(t, e) {
  const denom = cdf(t - e);
  if (denom === 0) return 1; // asymptote (v*(v+t-e) would cancel to 0 here)
  const vVal = pdf(t - e) / denom;
  return Math.min(Math.max(vVal * (vVal + t - e), 0), 1);
}

/**
 * Draw mean-correction factor V_draw.
 */
export function vDraw(t, e) {
  const absDiff = cdf(e - t) - cdf(-e - t);
  if (absDiff === 0) return 0;
  return (pdf(-e - t) - pdf(e - t)) / absDiff;
}

/**
 * Draw variance-correction factor W_draw.
 */
export function wDraw(t, e) {
  const vd = vDraw(t, e);
  const absDiff = cdf(e - t) - cdf(-e - t);
  if (absDiff === 0) return vd * vd;

  const term = ((e - t) * pdf(e - t) - (-e - t) * pdf(-e - t)) / absDiff;
  return vd * vd + term;
}
