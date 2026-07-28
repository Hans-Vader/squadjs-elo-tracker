/**
 * test-elo-calibrate.js
 *
 * Unit tests for the calibrator's match-log parsing (tools/elo-calibrate.js).
 * The CLI body is guarded behind an import.meta check, so importing the
 * module here must NOT execute the sweep or exit the process.
 */

import { parseMatchLine } from '../tools/elo-calibrate.js';

const LINE = (over = {}) => JSON.stringify({
  matchId: 'm1',
  endedAt: 1000,
  outcome: 'team1win',
  roundDuration: 1800000,
  players: [
    { eosID: 'a', name: '[X] A', teamID: 1, partySize: 1, participationRatio: 1 },
    { eosID: 'b', name: '[Y] B', teamID: 2, partySize: 1, participationRatio: 1 }
  ],
  ...over
});

export default async function runCalibrateTests(runTest) {
  await runTest('Calibrate parse: roundDuration survives into the parsed match', async () => {
    const m = parseMatchLine(LINE(), {});
    if (!m) throw new Error('valid line must parse');
    if (m.roundDuration !== 1800000) {
      throw new Error(`roundDuration lost in parsing: got ${m.roundDuration} — kill/death factor would silently see 0 minutes`);
    }
    if (m.team1.length !== 1 || m.team2.length !== 1) throw new Error('team split wrong');
    if (m.partyByEos !== null) throw new Error('logged partySize present ⇒ no name recompute');
  });

  await runTest('Calibrate parse: draws, malformed lines and one-sided teams are skipped', async () => {
    if (parseMatchLine('', {}) !== null) throw new Error('empty line must be skipped');
    if (parseMatchLine('not json', {}) !== null) throw new Error('malformed JSON must be skipped');
    if (parseMatchLine(LINE({ outcome: 'draw' }), {}) !== null) throw new Error('draws must be skipped');
    const oneSided = LINE({
      players: [{ eosID: 'a', name: 'A', teamID: 1, partySize: 1 }]
    });
    if (parseMatchLine(oneSided, {}) !== null) throw new Error('one-sided match must be skipped');
  });

  await runTest('Calibrate parse: pre-feature records recompute parties from names', async () => {
    const preFeature = LINE({
      players: [
        { eosID: 'a', name: '[KM] A', teamID: 1 }, // no partySize field
        { eosID: 'b', name: '[KM] B', teamID: 1 },
        { eosID: 'c', name: 'C', teamID: 2 }
      ]
    });
    const m = parseMatchLine(preFeature, {});
    if (!m.partyByEos) throw new Error('missing partySize must trigger name recompute');
    if (m.partyByEos.get('a').partySize !== 2) throw new Error('recomputed party size wrong');
  });
}
