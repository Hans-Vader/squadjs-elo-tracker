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
