/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                     ELO TICKET TIMELINE                       ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * ─── PURPOSE ─────────────────────────────────────────────────────
 *
 * Pure functions over the live ticket samples recorded during a
 * round: per-round summary, a Unicode sparkline of the lead, and
 * prediction statistics across many rounds. No external dependencies.
 *
 * ─── EXPORTS ─────────────────────────────────────────────────────
 *
 *   SYMMETRIC_MODES                 — Modes whose tickets are comparable.
 *   isValidTickets(tickets)         — [t1, t2] usable as live tickets?
 *   computeLead(sample, start)      — Lead of team 1 (ticket loss based).
 *   summarizeTimeline(...)          — Per-round summary or null.
 *   sparkline(samples, start, w)    — Lead curve as ▁▂▃▄▅▆▇█ string.
 *   aggregatePredictions(rows, t)   — Prediction stats across many rounds.
 *   parseLimit(arg)                 — Safe row limit for !elo predictions.
 *   formatLiveStatus({...})         — Favourite + live ticket lines for admins.
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Sample tuple: [sec, t1, t2, n1, n2, p1, muDelta].
 * - lead = (t1 − s1) − (t2 − s2); positive = team 1 ahead. Normalised
 *   on ticket loss so asymmetric start tickets compare fairly.
 * - Minutes are Math.floor(sec / 60).
 * - partial = the first sample is more than one tick (35 s) after pStartSec,
 *   i.e. the start of the round is missing (e.g. restart mid-round).
 *
 * ═══════════════════════════════════════════════════════════════
 */

export const SYMMETRIC_MODES = ['AAS', 'RAAS', 'TC'];

const LEAD_HYSTERESIS = 10;
// Samples arrive on a ~30 s tick; the first one may land up to one tick (+ RCON jitter) after pStartSec.
const SAMPLE_TOLERANCE_SEC = 35;
const SPARK_CHARS = '▁▂▃▄▅▆▇█';

const toMin = (sec) => Math.floor(sec / 60);

export function isValidTickets(tickets) {
  return Array.isArray(tickets) && tickets.length === 2
    && tickets.every(t => typeof t === 'number' && Number.isFinite(t))
    && !(tickets[0] === 0 && tickets[1] === 0);
}

export function computeLead(sample, [s1, s2]) {
  return (sample[1] - s1) - (sample[2] - s2);
}

const resolveStart = (samples, startTickets) => startTickets ?? [samples[0][1], samples[0][2]];

/**
 * @param {Array} samples - [sec, t1, t2, n1, n2, p1, muDelta][]
 * @param {[number, number] | null} startTickets - falls back to the first sample
 * @param {number | null} winningTeamID - 1, 2, or anything else for a draw
 * @param {{ pStartSec: number, scrambledAtSec?: number | null }} opts
 */
export function summarizeTimeline(samples, startTickets, winningTeamID, { pStartSec, scrambledAtSec = null }) {
  if (!samples.length) return null;

  const start = resolveStart(samples, startTickets);
  const leads = samples.map(x => computeLead(x, start));
  const last = samples.length - 1;
  const winner = [1, 2].includes(winningTeamID) ? winningTeamID : null;

  const pSample = samples.find(x => x[0] >= pStartSec);
  const muDeltaStart = pSample ? pSample[6] : null;
  const favorite = muDeltaStart > 0 ? 1 : muDeltaStart < 0 ? 2 : null;

  let maxLeadT1 = 0, maxLeadT1Min = null, maxLeadT2 = 0, maxLeadT2Min = null;
  let side = null, leadChanges = 0;
  leads.forEach((lead, i) => {
    if (lead > maxLeadT1) { maxLeadT1 = lead; maxLeadT1Min = toMin(samples[i][0]); }
    if (-lead > maxLeadT2) { maxLeadT2 = -lead; maxLeadT2Min = toMin(samples[i][0]); }
    const now = lead >= LEAD_HYSTERESIS ? 1 : lead <= -LEAD_HYSTERESIS ? 2 : null;
    if (now && side && now !== side) leadChanges++;
    if (now) side = now;
  });

  let decidedAtMin = null;
  if (winner) {
    const w = winner === 1 ? 1 : -1;
    let i = last;
    while (i >= 0 && leads[i] * w > 0) i--;
    if (i < last) decidedAtMin = toMin(samples[i + 1][0]);
  }

  const leadAt = (min) => {
    if (samples[last][0] < min * 60) return null;
    let found = null;
    samples.forEach((x, i) => { if (x[0] <= min * 60) found = leads[i]; });
    return found;
  };

  return {
    pStart: pSample ? pSample[5] : null,
    pStartSec: pSample ? pSample[0] : null,
    muDeltaStart,
    favorite,
    favoriteWon: favorite && winner ? favorite === winner : null,
    leadEnd: leads[last],
    maxLeadT1, maxLeadT1Min, maxLeadT2, maxLeadT2Min,
    leadChanges,
    decidedAtMin,
    leadAt10: leadAt(10),
    leadAt20: leadAt(20),
    leadAt30: leadAt(30),
    partial: samples[0][0] > pStartSec + SAMPLE_TOLERANCE_SEC,
    firstSampleMin: toMin(samples[0][0]),
    scrambledAtMin: scrambledAtSec != null && scrambledAtSec > pStartSec ? toMin(scrambledAtSec) : null
  };
}

/**
 * Lead curve, symmetric around 0 (up = team 1 ahead), averaged into `width` buckets.
 */
export function sparkline(samples, startTickets, width = 24) {
  if (!samples.length) return '';
  const start = resolveStart(samples, startTickets);
  const n = samples.length;
  const cols = Math.min(width, n);
  const means = Array.from({ length: cols }, (_, c) => {
    const bucket = samples.slice(Math.floor(c * n / cols), Math.floor((c + 1) * n / cols));
    return bucket.reduce((sum, x) => sum + computeLead(x, start), 0) / bucket.length;
  });
  const M = Math.max(...means.map(Math.abs));
  return means
    .map(lead => SPARK_CHARS[M === 0 ? 4 : Math.min(7, Math.floor((lead + M) / (2 * M) * 8))])
    .join('');
}

const rate = (hits, n) => (n ? hits / n : null);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Prediction statistics over per-round summary rows (DB rows or match-log summaries).
 * Row: { gameMode, winningTeamID, pStart, muDeltaStart, leadEnd, leadAt10/20/30, partial, scrambledAtMin }
 * Each round is excluded at most once: partial → scrambled → noFavorite → draw.
 */
export function aggregatePredictions(rows, { troublingDelta = 1.5, criticalDelta = 3.0, dominantMargin = 150 } = {}) {
  const excluded = { partial: 0, scrambled: 0, noFavorite: 0, draw: 0 };
  const usable = [];
  for (const row of rows) {
    if (row.partial) excluded.partial++;
    else if (row.scrambledAtMin != null) excluded.scrambled++;
    else if (!row.muDeltaStart) excluded.noFavorite++;
    else if (![1, 2].includes(row.winningTeamID)) excluded.draw++;
    else {
      const favorite = row.muDeltaStart > 0 ? 1 : 2;
      usable.push({ ...row, favorite, won: favorite === row.winningTeamID, sign: favorite === 1 ? 1 : -1 });
    }
  }

  const muBuckets = [
    { label: `<${troublingDelta}`, test: d => d < troublingDelta },
    { label: `${troublingDelta}–${criticalDelta}`, test: d => d >= troublingDelta && d < criticalDelta },
    { label: `≥${criticalDelta}`, test: d => d >= criticalDelta }
  ];
  const inMu = (b) => (x) => b.test(Math.abs(x.muDeltaStart));
  const symmetric = usable.filter(x => SYMMETRIC_MODES.includes(x.gameMode));

  const favoriteLeading = {};
  for (const min of [10, 20, 30]) {
    const withLead = symmetric.filter(x => x[`leadAt${min}`] != null);
    favoriteLeading[min] = rate(withLead.filter(x => x[`leadAt${min}`] * x.sign > 0).length, withLead.length);
  }

  const engineRows = usable
    .filter(x => x.pStart != null)
    .map(x => ({ c: Math.max(x.pStart, 1 - x.pStart), won: (x.pStart >= 0.5 ? 1 : 2) === x.winningTeamID }));
  const engineBuckets = [
    { label: '50–70%', test: c => c < 0.7 },
    { label: '70–90%', test: c => c >= 0.7 && c < 0.9 },
    { label: '90%+', test: c => c >= 0.9 }
  ];

  return {
    total: rows.length,
    usable: usable.length,
    excluded,
    favoriteWinRate: rate(usable.filter(x => x.won).length, usable.length),
    byMuDelta: muBuckets.map(b => {
      const xs = usable.filter(inMu(b));
      return { label: b.label, n: xs.length, favoriteWinRate: rate(xs.filter(x => x.won).length, xs.length) };
    }),
    favoriteLeading,
    marginByMuDelta: muBuckets.map(b => {
      const margins = symmetric.filter(inMu(b)).map(x => Math.abs(x.leadEnd));
      return {
        label: b.label,
        n: margins.length,
        avgMargin: mean(margins),
        dominantRate: rate(margins.filter(m => m >= dominantMargin).length, margins.length)
      };
    }),
    engine: engineBuckets.map(b => {
      const xs = engineRows.filter(x => b.test(x.c));
      return { label: b.label, n: xs.length, avgP: mean(xs.map(x => x.c)), actualRate: rate(xs.filter(x => x.won).length, xs.length) };
    })
  };
}

/** Positive integer limit from a chat argument; falls back to `def`, capped at `max`. */
export function parseLimit(arg, { def = 100, max = 1000 } = {}) {
  const n = Number(arg);
  if (!Number.isInteger(n) || n < 1) return def;
  return Math.min(n, max);
}

const signed = (n) => (n > 0 ? `+${n}` : `${n}`);

/**
 * Two admin-facing lines: favourite by average μ, and live tickets vs. start.
 * Deliberately no win percentage (see design: raw engine probability swings with headcount).
 * @param {{ avgMu1: number, avgMu2: number, tickets: { current: number[], start: number[], lead: number } | null }} p
 */
export function formatLiveStatus({ avgMu1, avgMu2, tickets }) {
  const diff = Math.abs(avgMu1 - avgMu2).toFixed(2);
  const favourite = diff === '0.00'
    ? 'Favourite: even (0.00μ)'
    : `Favourite: Team ${avgMu1 > avgMu2 ? 1 : 2} (+${diff}μ)`;
  if (!tickets) return [favourite, 'Tickets: n/a'];

  const { current: [c1, c2], start: [s1, s2], lead } = tickets;
  const leader = lead > 0 ? `Team 1 +${lead}` : lead < 0 ? `Team 2 +${-lead}` : 'even';
  return [favourite, `Tickets: T1 ${c1} (${signed(c1 - s1)}) | T2 ${c2} (${signed(c2 - s2)}) -> ${leader}`];
}
