import assert from 'node:assert/strict';
import { isValidTickets, summarizeTimeline, sparkline } from '../utils/elo-ticket-timeline.js';

// Sample tuple: [sec, t1, t2, n1, n2, p1, muDelta]
const s = (sec, t1, t2, mu = 0.5, p = 0.6, n1 = 50, n2 = 50) => [sec, t1, t2, n1, n2, p, mu];
// Sample with a given lead against start [300, 300]
const L = (sec, lead) => s(sec, 300 + lead, 300);

export default async function runTicketTimelineTests(runTest) {
  await runTest('isValidTickets', async () => {
    assert.equal(isValidTickets([]), false);
    assert.equal(isValidTickets([0, 0]), false);
    assert.equal(isValidTickets([300, 0]), true);
    assert.equal(isValidTickets([NaN, 5]), false);
    assert.equal(isValidTickets(undefined), false);
    assert.equal(isValidTickets(['300', '200']), false);
  });

  await runTest('lead normalisation', async () => {
    const a = summarizeTimeline([s(60, 300, 250), s(180, 290, 230), s(600, 200, 100)], [300, 250], 1, { pStartSec: 180 });
    assert.equal(a.leadEnd, 50);
  });

  await runTest('start fallback', async () => {
    assert.equal(summarizeTimeline([s(60, 300, 300), s(120, 280, 290)], null, 1, { pStartSec: 180 }).leadEnd, -10);
  });

  await runTest('favourite', async () => {
    const f = summarizeTimeline(
      [s(60, 300, 300, 0.9, 0.2), s(180, 300, 300, -0.4, 0.9), s(600, 250, 200, -0.4, 0.9)],
      null, 2, { pStartSec: 180 }
    );
    assert.deepEqual([f.pStart, f.pStartSec, f.muDeltaStart, f.favorite, f.favoriteWon], [0.9, 180, -0.4, 2, true]);
  });

  await runTest('hysteresis', async () => {
    const samples = [12, 5, -8, -12, 3, 15].map((l, i) => L(60 + i * 60, l));
    assert.equal(summarizeTimeline(samples, [300, 300], 1, { pStartSec: 180 }).leadChanges, 2);
  });

  await runTest('decidedAt & maxLead', async () => {
    const d = [L(60, 5), L(300, -20), L(600, 30), L(900, 40), L(1200, 50)];
    const d1 = summarizeTimeline(d, [300, 300], 1, { pStartSec: 180 });
    assert.equal(d1.decidedAtMin, 10);
    assert.deepEqual([d1.maxLeadT1, d1.maxLeadT1Min, d1.maxLeadT2, d1.maxLeadT2Min], [50, 20, 20, 5]);
    // won despite ticket deficit
    assert.equal(summarizeTimeline(d, [300, 300], 2, { pStartSec: 180 }).decidedAtMin, null);
  });

  await runTest('leadAtX', async () => {
    const r = summarizeTimeline([L(60, 1), L(590, 2), L(610, 3), L(1190, 4), L(1500, 5)], [300, 300], 1, { pStartSec: 180 });
    assert.deepEqual([r.leadAt10, r.leadAt20, r.leadAt30], [2, 4, null]);
  });

  await runTest('partial & scrambled', async () => {
    const p = summarizeTimeline([L(1440, 0), L(1500, 5)], [300, 300], 1, { pStartSec: 180, scrambledAtSec: 1320 });
    assert.deepEqual([p.partial, p.firstSampleMin, p.scrambledAtMin], [true, 24, 22]);
    assert.equal(summarizeTimeline([L(60, 0)], [300, 300], 1, { pStartSec: 180, scrambledAtSec: 120 }).scrambledAtMin, null);
  });

  await runTest('draw / empty team / empty input', async () => {
    const d = [L(60, 5), L(300, -20), L(600, 30), L(900, 40), L(1200, 50)];
    const dr = summarizeTimeline(d, [300, 300], null, { pStartSec: 180 });
    assert.deepEqual([dr.favoriteWon, dr.decidedAtMin], [null, null]);
    const empty = [s(60, 300, 300, null, null), s(200, 290, 300, null, null)];
    assert.equal(summarizeTimeline(empty, null, 1, { pStartSec: 180 }).favorite, null);
    assert.equal(summarizeTimeline([], null, 1, { pStartSec: 180 }), null);
  });

  await runTest('sparkline', async () => {
    const three = [L(60, -50), L(120, 0), L(180, 50)];
    assert.equal(sparkline(three, [300, 300]).at(0), '▁');
    assert.equal(sparkline(three, [300, 300]).at(-1), '█');
    assert.equal(new Set(sparkline([L(60, 0), L(120, 0)], [300, 300])).size, 1);
    assert.equal(sparkline(Array.from({ length: 100 }, (_, i) => L(60 + i * 30, i)), [300, 300]).length, 24);
  });
}
