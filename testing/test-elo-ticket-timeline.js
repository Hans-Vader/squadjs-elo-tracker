import assert from 'node:assert/strict';
import { isValidTickets, summarizeTimeline, sparkline, aggregatePredictions, parseLimit } from '../utils/elo-ticket-timeline.js';

// Sample tuple: [sec, t1, t2, n1, n2, p1, muDelta]
const s = (sec, t1, t2, mu = 0.5, p = 0.6, n1 = 50, n2 = 50) => [sec, t1, t2, n1, n2, p, mu];
// Sample with a given lead against start [300, 300]
const L = (sec, lead) => s(sec, 300 + lead, 300);

// Aggregation row with sensible defaults
const r = (o = {}) => ({ gameMode: 'RAAS', winningTeamID: 1, pStart: 0.8, muDeltaStart: 1.0, leadEnd: 100,
  leadAt10: 10, leadAt20: 20, leadAt30: 30, partial: false, scrambledAtMin: null, ...o });

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

  await runTest('aggregate: exclusions, first reason wins', async () => {
    const ex = aggregatePredictions([r({ partial: true, scrambledAtMin: 20 }), r({ scrambledAtMin: 20 }), r({ muDeltaStart: 0 }),
      r({ muDeltaStart: null }), r({ winningTeamID: null }), r()]);
    assert.deepEqual([ex.total, ex.usable, ex.excluded], [6, 1, { partial: 1, scrambled: 1, noFavorite: 2, draw: 1 }]);
  });

  await runTest('aggregate: favourite win rate and μ buckets', async () => {
    const mu = aggregatePredictions([r({ muDeltaStart: 1.49 }), r({ muDeltaStart: -1.5 }), r({ muDeltaStart: 3.0 }),
      r({ muDeltaStart: 2.9, winningTeamID: 2 })]);
    assert.equal(mu.favoriteWinRate, 0.5);
    assert.deepEqual(mu.byMuDelta, [{ label: '<1.5', n: 1, favoriteWinRate: 1 }, { label: '1.5–3', n: 2, favoriteWinRate: 0 },
      { label: '≥3', n: 1, favoriteWinRate: 1 }]);
  });

  await runTest('aggregate: ticket stats only for symmetric modes', async () => {
    const tk = aggregatePredictions([r({ gameMode: 'Invasion', leadEnd: 400, leadAt10: -50 }), r({ gameMode: 'AAS', leadEnd: 200, leadAt10: 5 }),
      r({ gameMode: 'TC', muDeltaStart: -1, winningTeamID: 2, leadEnd: -100, leadAt10: 10 })]);
    assert.equal(tk.favoriteLeading[10], 0.5);
    assert.deepEqual(tk.marginByMuDelta[0], { label: '<1.5', n: 2, avgMargin: 150, dominantRate: 0.5 });
  });

  await runTest('aggregate: engine table', async () => {
    const en = aggregatePredictions([r({ pStart: 0.65 }), r({ pStart: 0.2 }), r({ pStart: 0.95 }), r({ pStart: null })]);
    assert.deepEqual(en.engine.map(b => [b.label, b.n, b.actualRate]), [['50–70%', 1, 1], ['70–90%', 1, 0], ['90%+', 1, 1]]);
    assert.ok(Math.abs(en.engine[1].avgP - 0.8) < 1e-9);
    assert.equal(en.usable, 4);
  });

  await runTest('aggregate: empty input', async () => {
    const em = aggregatePredictions([]);
    assert.deepEqual([em.usable, em.favoriteWinRate, em.byMuDelta[0].favoriteWinRate, em.favoriteLeading[30]], [0, null, null, null]);
  });

  await runTest('parseLimit', async () => {
    assert.deepEqual([undefined, 'abc', '0', '-5', '50', '99999', '2.5'].map(v => parseLimit(v)), [100, 100, 100, 100, 50, 1000, 100]);
  });
}
