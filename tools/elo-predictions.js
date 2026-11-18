/**
 * ╔═══════════════════════════════════════════════════════════════╗
 * ║                      ELO PREDICTIONS                          ║
 * ╚═══════════════════════════════════════════════════════════════╝
 *
 * Evaluates how well team strength predicted rounds, from the ticket
 * timelines in the match log (rounds recorded with EloTracker ≥ 1.4.0
 * on a SquadJS with live tickets). Prints the same statistics as
 * `!elo predictions`, overall and per game mode, plus the raw engine
 * table (TrueSkill pStart confidence vs. actual win rate).
 *
 * Usage: node elo-predictions.js <matchlog.jsonl>
 */

import readline from 'readline';
import fs from 'fs';
import { aggregatePredictions, SYMMETRIC_MODES } from '../utils/elo-ticket-timeline.js';

const jsonlPath = process.argv[2];

if (!jsonlPath) {
  console.error('Usage: node elo-predictions.js <matchlog.jsonl>');
  process.exit(1);
}

const rows = [];
let unparsable = 0;
let withoutTimeline = 0;

const rl = readline.createInterface({ input: fs.createReadStream(jsonlPath), crlfDelay: Infinity });

rl.on('line', (line) => {
  let rec;
  try { rec = JSON.parse(line); } catch { unparsable++; return; }
  if (!rec?.timeline?.summary) { withoutTimeline++; return; }
  rows.push({
    ...rec.timeline.summary,
    gameMode: rec.gameMode,
    winningTeamID: rec.outcome === 'team1win' ? 1 : rec.outcome === 'team2win' ? 2 : null
  });
});

const pct = (x) => (x == null ? 'n/a' : `${Math.round(x * 100)}%`);
const num = (x) => (x == null ? 'n/a' : Math.round(x).toString());
const modes = SYMMETRIC_MODES.join('/');

function printBlock(name, blockRows) {
  const s = aggregatePredictions(blockRows);
  const e = s.excluded;
  console.log(`\n=== ${name} ===`);
  console.log(`total: ${s.total}  usable: ${s.usable}  excluded: ${e.partial} partial, ${e.scrambled} scrambled, ${e.noFavorite} no favourite, ${e.draw} draw`);
  console.log(`Favourite (higher avg μ) won: ${pct(s.favoriteWinRate)}`);
  console.log('By μ diff:');
  for (const b of s.byMuDelta) console.log(`  ${b.label.padEnd(8)} n=${String(b.n).padEnd(5)} favourite won ${pct(b.favoriteWinRate)}`);
  console.log(`Favourite leading (${modes}): ${[10, 20, 30].map(m => `min ${m}: ${pct(s.favoriteLeading[m])}`).join('  ')}`);
  console.log(`Margin by μ diff (${modes}):`);
  for (const b of s.marginByMuDelta) console.log(`  ${b.label.padEnd(8)} n=${String(b.n).padEnd(5)} avg |lead| ${num(b.avgMargin).padEnd(6)} dominant ${pct(b.dominantRate)}`);
  console.log('Engine (raw TrueSkill pStart confidence):');
  console.log(`  ${'bucket'.padEnd(8)} ${'n'.padEnd(6)} ${'avgP'.padEnd(6)} actual`);
  for (const b of s.engine) console.log(`  ${b.label.padEnd(8)} ${String(b.n).padEnd(6)} ${pct(b.avgP).padEnd(6)} ${pct(b.actualRate)}`);
}

rl.on('close', () => {
  console.log(`Rounds with timeline: ${rows.length} (skipped: ${withoutTimeline} without timeline, ${unparsable} unparsable lines)`);
  printBlock('ALL', rows);
  const modeOf = (r) => r.gameMode ?? 'Unknown';
  for (const mode of [...new Set(rows.map(modeOf))].sort()) printBlock(mode, rows.filter(r => modeOf(r) === mode));
});
