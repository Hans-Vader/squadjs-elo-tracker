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
    if (p.partyOffsets.length !== 10) throw new Error(`partyOffsets must have 10 entries`);
    if (p.partyOffsets.some(v => v !== 0)) throw new Error(`partyOffsets must default to all-zero (neutral)`);
    if (p.experienceOffsets.length !== 200) throw new Error(`experienceOffsets must have 200 entries`);
    if (p.experienceOffsets.some(v => v !== 0)) throw new Error(`experienceOffsets must default to all-zero (neutral)`);
    if (p.killParams.wPlayer !== 0 || p.killParams.wOpponent !== 0) throw new Error(`killParams weights must default to 0 (neutral)`);
    if (p.deathParams.wPlayer !== 0 || p.deathParams.wOpponent !== 0) throw new Error(`deathParams weights must default to 0 (neutral)`);
    if (!(p.killParams.variance > 0) || !(p.deathParams.variance > 0)) throw new Error(`count variances must be positive`);
    if (p.quitParams.mQ > 0) throw new Error(`m_q must be <= 0 (paper constraint)`);
    if (!(p.quitParams.vQ > 0)) throw new Error(`v_q must be > 0`);
    if ('pU' in p.quitParams || 'pR' in p.quitParams) throw new Error(`pU/pR must not exist (unused eq.13 params, amendment A4)`);
    if (!Object.isFrozen(p)) throw new Error(`DEFAULT_PARAMETERS must be frozen`);
    if (!Object.isFrozen(p.partyOffsets) || !Object.isFrozen(p.killParams)) throw new Error(`nested values must be frozen`);
  });

  await runTest('Overrides: merge onto defaults, pad arrays', async () => {
    const p = loadParameters({ beta: 5.0, partyOffsets: [0, 0, 0, 1.0] });
    if (p.beta !== 5.0) throw new Error(`override of beta failed`);
    if (p.partyOffsets.length !== 10) throw new Error(`override must pad partyOffsets to 10`);
    if (p.partyOffsets[3] !== 1.0) throw new Error(`override at index 3 failed`);
    if (p.partyOffsets[4] !== 0) throw new Error(`unspecified array tail must keep default`);
    if (p.tau !== DEFAULT_PARAMETERS.tau) throw new Error(`unspecified field must keep default`);
    const q = loadParameters({ killParams: { wPlayer: 0.1 } });
    if (q.killParams.wPlayer !== 0.1) throw new Error(`nested object override failed`);
    if (q.killParams.variance !== DEFAULT_PARAMETERS.killParams.variance) throw new Error(`nested defaults must survive partial override`);
  });

  await runTest('Overrides: partyOffsets[0] forced to 0 (identifiability)', async () => {
    const p = loadParameters({ partyOffsets: [2.5, 0, 0, 1.0] });
    if (p.partyOffsets[0] !== 0) throw new Error(`partyOffsets[0] must be forced to 0, got ${p.partyOffsets[0]}`);
    if (p.partyOffsets[3] !== 1.0) throw new Error(`other overrides must still apply`);
  });

  await runTest('Overrides: result deep-frozen; null/undefined ignored', async () => {
    const p = loadParameters({ beta: 5.0, tau: undefined, drawProbability: null });
    if (!Object.isFrozen(p)) throw new Error(`loadParameters result must be frozen`);
    if (!Object.isFrozen(p.partyOffsets)) throw new Error(`nested arrays must be frozen`);
    if (!Object.isFrozen(p.quitParams)) throw new Error(`nested objects must be frozen`);
    if (p.tau !== DEFAULT_PARAMETERS.tau) throw new Error(`undefined override must be ignored`);
    if (p.drawProbability !== DEFAULT_PARAMETERS.drawProbability) throw new Error(`null override must be ignored`);
  });

  await runTest('Clean rename: squadOffsets is not an alias — key absent and ignored as override', async () => {
    const p = loadParameters({ squadOffsets: [0, 0, 0, 9.0] });
    if ('squadOffsets' in p) throw new Error('params must not expose a squadOffsets key');
    if (p.partyOffsets[3] !== 0) throw new Error('legacy squadOffsets override must be ignored, not mapped');
  });

  // ─── Validation: config typos must throw at load, not corrupt ratings ──

  const mustThrow = (overrides, label) => {
    try {
      loadParameters(overrides);
    } catch {
      return;
    }
    throw new Error(`loadParameters must reject ${label}`);
  };

  await runTest('Validation: drawProbability must be a number in [0, 1)', async () => {
    mustThrow({ drawProbability: 1 }, 'drawProbability = 1 (erfInv(1) = Infinity)');
    mustThrow({ drawProbability: 1.5 }, 'drawProbability > 1');
    mustThrow({ drawProbability: -0.1 }, 'negative drawProbability');
    mustThrow({ drawProbability: '0,01' }, 'German decimal-comma string');
    if (loadParameters({ drawProbability: 0.05 }).drawProbability !== 0.05) throw new Error('valid value must pass');
  });

  await runTest('Validation: beta must be finite > 0; tau/tauPerMinute finite >= 0', async () => {
    mustThrow({ beta: 0 }, 'beta = 0');
    mustThrow({ beta: -1 }, 'negative beta');
    mustThrow({ beta: '7,5' }, 'beta as decimal-comma string');
    mustThrow({ beta: Infinity }, 'infinite beta');
    mustThrow({ beta: NaN }, 'NaN beta');
    mustThrow({ tau: -0.1 }, 'negative tau');
    mustThrow({ tauPerMinute: -1 }, 'negative tauPerMinute');
    const p = loadParameters({ beta: 7.5, tau: 0 });
    if (p.beta !== 7.5 || p.tau !== 0) throw new Error('valid beta/tau must pass');
  });

  await runTest('Validation: mu0 finite, v0 finite > 0', async () => {
    mustThrow({ mu0: NaN }, 'NaN mu0');
    mustThrow({ mu0: '25' }, 'mu0 as string');
    mustThrow({ v0: 0 }, 'v0 = 0 (sigma 0 is unrepresentable)');
    mustThrow({ v0: -4 }, 'negative v0');
  });

  await runTest('Validation: quitParams constraints (mQ <= 0, vQ > 0, finite)', async () => {
    mustThrow({ quitParams: { mQ: 2 } }, 'positive mQ (sign flipped — would reward quitting)');
    mustThrow({ quitParams: { mQ: '-2' } }, 'mQ as string');
    mustThrow({ quitParams: { vQ: 0 } }, 'vQ = 0');
    mustThrow({ quitParams: { vQ: -1 } }, 'negative vQ');
    const p = loadParameters({ quitParams: { mQ: -3, vQ: 2 } });
    if (p.quitParams.mQ !== -3 || p.quitParams.vQ !== 2) throw new Error('valid quitParams must pass');
    if (loadParameters({ quitParams: { mQ: 0 } }).quitParams.mQ !== 0) throw new Error('mQ = 0 is allowed (paper: <= 0)');
  });

  await runTest('Validation: kill/death params finite; variance >= 0', async () => {
    mustThrow({ killParams: { wPlayer: '0,3' } }, 'wPlayer as decimal-comma string');
    mustThrow({ killParams: { variance: -1 } }, 'negative kill variance');
    mustThrow({ deathParams: { wOpponent: NaN } }, 'NaN wOpponent');
    const p = loadParameters({ killParams: { wPlayer: 0.3, wOpponent: -0.1 } });
    if (p.killParams.wPlayer !== 0.3) throw new Error('valid killParams must pass');
  });

  await runTest('Validation: offset-table entries must be finite numbers', async () => {
    mustThrow({ partyOffsets: [0, NaN] }, 'NaN partyOffset entry');
    mustThrow({ partyOffsets: [0, '1,5'] }, 'string partyOffset entry');
    mustThrow({ experienceOffsets: [Infinity] }, 'infinite experienceOffset entry');
    const p = loadParameters({ partyOffsets: [0, 0, 0, 1.5] });
    if (p.partyOffsets[3] !== 1.5) throw new Error('valid offsets must pass');
  });
}
