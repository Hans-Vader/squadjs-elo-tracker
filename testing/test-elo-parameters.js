import { DEFAULT_PARAMETERS, loadParameters } from '../utils/elo-parameters.js';

/**
 * Test suite for the TrueSkill2 parameters module.
 * Registered in run-all-tests.js; each case runs via runTest(name, fn).
 */
export default async function runParameterTests(runTest) {
  await runTest('Defaults: neutral TrueSkill2 parameter set', async () => {
    const p = DEFAULT_PARAMETERS;
    if (p.beta !== 25.0 / 6.0) throw new Error(`beta default mismatch: ${p.beta}`);
    if (p.tau !== 25.0 / 100.0) throw new Error(`tau default mismatch: ${p.tau}`);
    if (p.drawProbability !== 0.01) throw new Error(`drawProbability default mismatch`);
    if (p.mu0 !== 25.0) throw new Error(`mu0 default mismatch: ${p.mu0}`);
    if (Math.abs(p.v0 - (25.0 / 3.0) ** 2) > 1e-12) throw new Error(`v0 default mismatch: ${p.v0}`);
    if (p.squadOffsets.length !== 10) throw new Error(`squadOffsets must have 10 entries`);
    if (p.squadOffsets.some(v => v !== 0)) throw new Error(`squadOffsets must default to all-zero (neutral)`);
    if (p.experienceOffsets.length !== 200) throw new Error(`experienceOffsets must have 200 entries`);
    if (p.experienceOffsets.some(v => v !== 0)) throw new Error(`experienceOffsets must default to all-zero (neutral)`);
    if (p.killParams.wPlayer !== 0 || p.killParams.wOpponent !== 0) throw new Error(`killParams weights must default to 0 (neutral)`);
    if (p.deathParams.wPlayer !== 0 || p.deathParams.wOpponent !== 0) throw new Error(`deathParams weights must default to 0 (neutral)`);
    if (p.reviveParams.wPlayer !== 0 || p.reviveParams.wOpponent !== 0) throw new Error(`reviveParams weights must default to 0 (neutral)`);
    if (!(p.killParams.variance > 0) || !(p.deathParams.variance > 0) || !(p.reviveParams.variance > 0)) throw new Error(`count variances must be positive`);
    if (p.quitParams.mQ > 0) throw new Error(`m_q must be <= 0 (paper constraint)`);
    if (!(p.quitParams.vQ > 0)) throw new Error(`v_q must be > 0`);
    if ('pU' in p.quitParams || 'pR' in p.quitParams) throw new Error(`pU/pR must not exist (unused eq.13 params, amendment A4)`);
    if (!Object.isFrozen(p)) throw new Error(`DEFAULT_PARAMETERS must be frozen`);
    if (!Object.isFrozen(p.squadOffsets) || !Object.isFrozen(p.killParams)) throw new Error(`nested values must be frozen`);
  });

  await runTest('Overrides: merge onto defaults, pad arrays', async () => {
    const p = loadParameters({ beta: 5.0, squadOffsets: [0, 0, 0, 1.0] });
    if (p.beta !== 5.0) throw new Error(`override of beta failed`);
    if (p.squadOffsets.length !== 10) throw new Error(`override must pad squadOffsets to 10`);
    if (p.squadOffsets[3] !== 1.0) throw new Error(`override at index 3 failed`);
    if (p.squadOffsets[4] !== 0) throw new Error(`unspecified array tail must keep default`);
    if (p.tau !== DEFAULT_PARAMETERS.tau) throw new Error(`unspecified field must keep default`);
    const q = loadParameters({ killParams: { wPlayer: 0.1 }, reviveParams: { wPlayer: 0.05 } });
    if (q.killParams.wPlayer !== 0.1) throw new Error(`nested object override failed`);
    if (q.killParams.variance !== DEFAULT_PARAMETERS.killParams.variance) throw new Error(`nested defaults must survive partial override`);
    if (q.reviveParams.wPlayer !== 0.05) throw new Error(`reviveParams override failed`);
    if (q.reviveParams.variance !== DEFAULT_PARAMETERS.reviveParams.variance) throw new Error(`reviveParams defaults must survive partial override`);
  });

  await runTest('Overrides: squadOffsets[0] forced to 0 (identifiability)', async () => {
    const p = loadParameters({ squadOffsets: [2.5, 0, 0, 1.0] });
    if (p.squadOffsets[0] !== 0) throw new Error(`squadOffsets[0] must be forced to 0, got ${p.squadOffsets[0]}`);
    if (p.squadOffsets[3] !== 1.0) throw new Error(`other overrides must still apply`);
  });

  await runTest('Overrides: result deep-frozen; null/undefined ignored', async () => {
    const p = loadParameters({ beta: 5.0, tau: undefined, drawProbability: null });
    if (!Object.isFrozen(p)) throw new Error(`loadParameters result must be frozen`);
    if (!Object.isFrozen(p.squadOffsets)) throw new Error(`nested arrays must be frozen`);
    if (!Object.isFrozen(p.quitParams)) throw new Error(`nested objects must be frozen`);
    if (p.tau !== DEFAULT_PARAMETERS.tau) throw new Error(`undefined override must be ignored`);
    if (p.drawProbability !== DEFAULT_PARAMETERS.drawProbability) throw new Error(`null override must be ignored`);
  });
}
