import {
  fromMuSigma,
  toMuSigma,
  combineMessages,
  EMPTY_MESSAGE
} from '../utils/elo-trueskill2-factors.js';

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
}
