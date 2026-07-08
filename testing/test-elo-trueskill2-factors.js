import {
  fromMuSigma,
  toMuSigma,
  combineMessages,
  killDeathFactorMessage,
  EMPTY_MESSAGE
} from '../utils/elo-trueskill2-factors.js';
import { loadParameters } from '../utils/elo-parameters.js';

export default async function runFactorTests(runTest) {
  await runTest('Gaussian: mu/sigma round-trip through natural form', async () => {
    const g = fromMuSigma(25, 8.333);
    const { mu, sigma } = toMuSigma(g);
    if (Math.abs(mu - 25) > 1e-9) throw new Error(`mu round-trip failed: ${mu}`);
    if (Math.abs(sigma - 8.333) > 1e-9) throw new Error(`sigma round-trip failed: ${sigma}`);
  });

  await runTest('Gaussian: fromMuSigma rejects non-positive sigma', async () => {
    for (const bad of [0, -1, NaN]) {
      let threw = false;
      try {
        fromMuSigma(25, bad);
      } catch (e) {
        threw = true;
      }
      if (!threw) throw new Error(`fromMuSigma must throw for sigma=${bad}`);
    }
  });

  await runTest('Gaussian: EMPTY_MESSAGE is the identity', async () => {
    const prior = fromMuSigma(20, 5);
    const post = combineMessages(prior, [EMPTY_MESSAGE, EMPTY_MESSAGE]);
    const { mu, sigma } = toMuSigma(post);
    if (Math.abs(mu - 20) > 1e-9) throw new Error(`empty message changed mu: ${mu}`);
    if (Math.abs(sigma - 5) > 1e-9) throw new Error(`empty message changed sigma: ${sigma}`);
  });

  await runTest('Gaussian: combining messages adds precisions', async () => {
    // Prior N(0,1); two observations each contributing precision 1, prec-mean 2
    // ⇒ posterior precision 3, prec-mean 4 ⇒ mu = 4/3, sigma = sqrt(1/3)
    const prior = fromMuSigma(0, 1);
    const msg = { deltaPrecision: 1, deltaPrecisionMean: 2 };
    const post = combineMessages(prior, [msg, msg]);
    const { mu, sigma } = toMuSigma(post);
    if (Math.abs(mu - 4 / 3) > 1e-9) throw new Error(`mu mismatch: ${mu}`);
    if (Math.abs(sigma - Math.sqrt(1 / 3)) > 1e-9) throw new Error(`sigma mismatch: ${sigma}`);
  });

  await runTest('Gaussian: negative-precision message widens the posterior', async () => {
    // EP can produce negative-precision messages; the combiner must accept
    // them while the posterior precision stays positive.
    const prior = fromMuSigma(0, 1); // precision 1
    const post = combineMessages(prior, [{ deltaPrecision: -0.5, deltaPrecisionMean: 0 }]);
    const { sigma } = toMuSigma(post);
    if (Math.abs(sigma - Math.sqrt(2)) > 1e-9) throw new Error(`sigma mismatch: ${sigma}`);
  });

  await runTest('Gaussian: non-positive posterior precision throws', async () => {
    const prior = fromMuSigma(0, 1); // precision 1
    let threw = false;
    try {
      combineMessages(prior, [{ deltaPrecision: -1.5, deltaPrecisionMean: 0 }]);
    } catch (e) {
      threw = true;
    }
    if (!threw) throw new Error('combineMessages must throw if posterior precision <= 0');
  });

  // --- Kill/death factor messages (paper eq. 9) ---

  const KD_PARAMS = loadParameters({});
  const KILL_W = { wPlayer: 0.1, wOpponent: -0.05, variance: 0.5 };
  const DEATH_W = { wPlayer: -0.05, wOpponent: 0.1, variance: 0.5 };
  const PLAYER = { mu: 25, sigma: 8.333 };

  await runTest('KD factor: linear message monotonic in count; positive precision', async () => {
    const m5 = killDeathFactorMessage(PLAYER, 5, 25, 2, 20, KILL_W, KD_PARAMS);
    const m20 = killDeathFactorMessage(PLAYER, 20, 25, 2, 20, KILL_W, KD_PARAMS);
    if (!(m5.deltaPrecision > 0)) throw new Error('linear-Gaussian observation must add precision');
    if (Math.abs(m5.deltaPrecision - m20.deltaPrecision) > 1e-12) {
      throw new Error('linear message precision must not depend on the observed count');
    }
    if (!(m20.deltaPrecisionMean > m5.deltaPrecisionMean)) {
      throw new Error('more kills must pull the skill estimate up');
    }
  });

  await runTest('KD factor: count=0 uses censored update (weaker than linear, right direction)', async () => {
    // Kills (wPlayer > 0): zero kills is evidence of LOWER skill.
    const killMsg = killDeathFactorMessage(PLAYER, 0, 25, 2, 20, KILL_W, KD_PARAMS);
    const prior = fromMuSigma(PLAYER.mu, PLAYER.sigma);
    const killPost = toMuSigma(combineMessages(prior, [killMsg]));
    if (!(killPost.mu < PLAYER.mu)) throw new Error(`0 kills must lower mu, got ${killPost.mu}`);
    if (!(killPost.sigma <= PLAYER.sigma)) throw new Error('an observation must not increase sigma');

    // Deaths (wPlayer < 0): zero deaths is evidence of HIGHER skill.
    const deathMsg = killDeathFactorMessage(PLAYER, 0, 25, 2, 20, DEATH_W, KD_PARAMS);
    const deathPost = toMuSigma(combineMessages(prior, [deathMsg]));
    if (!(deathPost.mu > PLAYER.mu)) throw new Error(`0 deaths must raise mu, got ${deathPost.mu}`);

    // Exact eq.-9 semantics: count=0 ⇔ latent ≤ 0, whose conditional mean is
    // BELOW zero when the expected count is well above it — so the censored
    // update pulls harder than naively pinning the Gaussian at exactly 0.
    const naiveLinearAtZero = {
      deltaPrecision: killDeathFactorMessage(PLAYER, 1, 25, 2, 20, KILL_W, KD_PARAMS).deltaPrecision,
      // reconstruct a(0-b)/V from two linear evaluations (linear in count):
      deltaPrecisionMean:
        2 * killDeathFactorMessage(PLAYER, 1, 25, 2, 20, KILL_W, KD_PARAMS).deltaPrecisionMean -
        killDeathFactorMessage(PLAYER, 2, 25, 2, 20, KILL_W, KD_PARAMS).deltaPrecisionMean
    };
    const naivePost = toMuSigma(combineMessages(prior, [naiveLinearAtZero]));
    if (!(killPost.mu < naivePost.mu)) {
      throw new Error(
        `censored 0-count must integrate the negative latent tail (harder pull): ${killPost.mu} vs naive ${naivePost.mu}`
      );
    }
  });

  await runTest('KD factor: neutral weights / missing time yield the empty message', async () => {
    const neutral = killDeathFactorMessage(PLAYER, 10, 25, 2, 20, KD_PARAMS.killParams, KD_PARAMS);
    if (neutral.deltaPrecision !== 0 || neutral.deltaPrecisionMean !== 0) {
      throw new Error('zero weights must produce a no-op message');
    }
    const noTime = killDeathFactorMessage(PLAYER, 10, 25, 2, 0, KILL_W, KD_PARAMS);
    if (noTime !== EMPTY_MESSAGE) throw new Error('tp<=0 must return EMPTY_MESSAGE');
    const badCount = killDeathFactorMessage(PLAYER, NaN, 25, 2, 20, KILL_W, KD_PARAMS);
    if (badCount !== EMPTY_MESSAGE) throw new Error('non-finite count must return EMPTY_MESSAGE');
  });
}
