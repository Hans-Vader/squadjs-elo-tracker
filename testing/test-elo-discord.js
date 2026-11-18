import assert from 'node:assert/strict';
import { EloDiscord } from '../utils/elo-discord.js';
import { formatLiveStatus, aggregatePredictions } from '../utils/elo-ticket-timeline.js';

// Shape of EloTracker._getMatchMetrics
const m = (mu) => ({
  count: 50, tierStats: { vCount: 5, pCount: 5, rCount: 40 }, tierString: '5 Visitors | 5 Prov. | 40 Regs',
  avgMu: mu, avgRegMu: mu, top15Mu: mu + 2, veterancy: 0.8
});

export default async function runDiscordTests(runTest) {
  await runTest('formatLiveStatus', async () => {
    assert.deepEqual(formatLiveStatus({ avgMu1: 26.2, avgMu2: 25, tickets: { current: [412, 351], start: [500, 500], lead: 61 } }),
      ['Favourite: Team 1 (+1.20μ)', 'Tickets: T1 412 (-88) | T2 351 (-149) -> Team 1 +61']);
    assert.deepEqual(formatLiveStatus({ avgMu1: 25, avgMu2: 25, tickets: null }), ['Favourite: even (0.00μ)', 'Tickets: n/a']);
    const t2 = formatLiveStatus({ avgMu1: 24, avgMu2: 25, tickets: { current: [300, 270], start: [300, 300], lead: -30 } });
    assert.equal(t2[1].endsWith('-> Team 2 +30'), true);
  });

  await runTest('buildRoundStartEmbed: showTickets option', async () => {
    const data = { layerName: 'L', t1: m(26.2), t2: m(25), muDelta: 1.2, top15Delta: 0, regDelta: 0, veteranLead: 'Tie',
      matchVeterancy: 0.5, roundStartTime: null, totalPlayerCount: 100, tickets: null };
    assert.ok(!EloDiscord.buildRoundStartEmbed(data, 'manual').fields.some(f => f.name === 'Favourite & Tickets'));
    assert.ok(EloDiscord.buildRoundStartEmbed(data, 'manual', { showTickets: true }).fields.some(f => f.name === 'Favourite & Tickets'));
  });

  await runTest('buildTimelineField', async () => {
    const sum = { pStartSec: 180, favorite: 1, muDeltaStart: 0.4, favoriteWon: false, maxLeadT1: 95, maxLeadT1Min: 18, maxLeadT2: 120,
      maxLeadT2Min: 52, leadChanges: 2, decidedAtMin: 41, partial: true, firstSampleMin: 24, scrambledAtMin: 22 };
    const field = EloDiscord.buildTimelineField({ ...sum, winningTeamID: 2 }, '▅▆▁');
    assert.equal(field.name, 'Round Timeline');
    for (const line of ['Favourite (min 3): Team 1 (+0.40μ) → Team 2 won ⚠️', '▅▆▁  (up = Team 1 ahead)',
      'Max lead: T1 +95 (min 18) · T2 +120 (min 52)', 'Lead changes: 2 · decided from min 41',
      '(partial – data from min 24)', 'Scrambled at min 22']) assert.ok(field.value.includes(line), line);
    assert.ok(EloDiscord.buildTimelineField({ ...sum, maxLeadT1: 0, maxLeadT1Min: null, winningTeamID: 2 }, '').value.includes('T1 —'));
  });

  await runTest('buildPredictionsEmbed', async () => {
    assert.equal(EloDiscord.buildPredictionsEmbed(aggregatePredictions([]), 100).description, 'No timeline data yet.');
  });
}
