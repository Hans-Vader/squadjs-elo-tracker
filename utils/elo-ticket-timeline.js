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
 *
 * ─── NOTES ───────────────────────────────────────────────────────
 *
 * - Sample tuple: [sec, t1, t2, n1, n2, p1, muDelta].
 * - lead = (t1 − s1) − (t2 − s2); positive = team 1 ahead. Normalised
 *   on ticket loss so asymmetric start tickets compare fairly.
 * - Minutes are Math.floor(sec / 60).
 *
 * ═══════════════════════════════════════════════════════════════
 */

export const SYMMETRIC_MODES = ['AAS', 'RAAS', 'TC'];

const LEAD_HYSTERESIS = 10;
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
    partial: samples[0][0] > pStartSec,
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
