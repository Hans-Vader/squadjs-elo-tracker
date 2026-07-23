#!/usr/bin/env node
/**
 * elo-rebuild.js
 *
 * Replays all recorded matches from scratch through the TrueSkill2 engine
 * (utils/elo-trueskill2-engine.js). Outputs a restore-compatible JSON backup.
 *
 * Usage:
 *   node elo-rebuild.js <matchlog.jsonl> <backup.json> [output.json] [--apply-quit-penalty] [--party-case-sensitive] [--party-max-edit-distance=N]
 *
 * - matchlog.jsonl  Source of truth for all match outcomes + participants
 * - backup.json     Existing backup — used only to preserve steamID/discordID
 * - output.json     Output path (default: elo-rebuilt-<timestamp>.json)
 * - --apply-quit-penalty  Apply the TrueSkill2 quit factor to quit-flagged
 *                   log entries (default off, mirroring the plugin's
 *                   enableQuitPenalty default)
 * - --party-case-sensitive          Clan-tag matching is case-sensitive
 *                   (default off). Must mirror the live plugin's
 *                   partyCaseSensitive config so replay parity holds.
 * - --party-max-edit-distance=N     Levenshtein merge distance for
 *                   near-duplicate clan tags (default 1, 0 = exact match
 *                   only). Must mirror the live plugin's
 *                   partyMaxEditDistance config so replay parity holds.
 *
 * The output is drop-in compatible with !elo restore.
 *
 * Notes on TrueSkill2 replay:
 * - With neutral default parameters this reproduces the legacy replay
 *   bit-for-bit (regression-tested in testing/test-elo-rebuild.js).
 * - Party size/clan tag are RECOMPUTED per round from the logged player
 *   names (not read from any logged squadID/squadSize), so replays group
 *   consistently with the live plugin even for old logs.
 * - Records written before the TrueSkill2 upgrade carry no
 *   kills/deaths/quit fields — those factors are simply inert for such
 *   rounds. New records replay with full observations.
 * - `experience` is taken from the replay state (roundsPlayed so far), not
 *   from the logged experienceBefore, so partial logs stay self-consistent.
 */

import fs from 'fs';
import * as readline from 'readline';
import { fileURLToPath } from 'url';
import { computeRoundUpdate } from '../utils/elo-trueskill2-engine.js';
import { loadParameters } from '../utils/elo-parameters.js';
import { computePartySizes } from '../utils/elo-clan-grouping.js';

// ─── Replay core ─────────────────────────────────────────────────────────────

async function loadMatches(jsonlPath) {
  return new Promise((resolve, reject) => {
    const matches = [];
    const stream  = fs.createReadStream(jsonlPath, 'utf8');
    const reader  = readline.createInterface({ input: stream, crlfDelay: Infinity });
    reader.on('line', line => { if (line.trim()) matches.push(JSON.parse(line)); });
    reader.on('close', () => resolve(matches));
    reader.on('error', reject);
  });
}

/**
 * Replay a JSONL match log through the TrueSkill2 engine.
 *
 * @param {string} matchlogPath   path to the production elo-match-log.jsonl
 * @param {string|null} backupPath  optional backup JSON for steamID/discordID
 * @param {Object} paramOverrides   loadParameters() overrides (neutral default)
 * @param {Object} options          { applyQuitPenalty?: boolean, quiet?: boolean,
 *                                    partyOptions?: {caseSensitive, maxEditDistance, ignoredTags} }
 * @returns {{ players: Map, parameters: Object, processed: number, skipped: number }}
 */
export async function rebuildFromLog(matchlogPath, backupPath = null, paramOverrides = {}, options = {}) {
  const parameters = loadParameters(paramOverrides);
  const applyQuitPenalty = options.applyQuitPenalty ?? false;
  const quiet = options.quiet ?? true;
  const partyOptions = options.partyOptions ?? {};

  const matches = await loadMatches(matchlogPath);

  // Build steamID/discordID lookup from an existing backup (if given)
  const metaLookup = new Map(); // eosID → { steamID, discordID }
  if (backupPath) {
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    const backupPlayers = Array.isArray(backup) ? backup : backup.players ?? Object.values(backup);
    for (const p of backupPlayers) {
      metaLookup.set(p.eosID ?? p.eos_id, { steamID: p.steamID ?? null, discordID: p.discordID ?? null });
    }
  }

  // Sort matches chronologically
  matches.sort((a, b) => a.endedAt - b.endedAt);

  // Player state — Map<eosID, { mu, sigma, wins, losses, roundsPlayed, lastSeen, name, steamID, discordID }>
  const players = new Map();
  const defaultSigma = Math.sqrt(parameters.v0);

  const getOrInit = (eosID, name, endedAt) => {
    if (!players.has(eosID)) {
      const meta = metaLookup.get(eosID) ?? { steamID: null, discordID: null };
      players.set(eosID, {
        eosID,
        steamID:      meta.steamID,
        discordID:    meta.discordID,
        name,
        mu:           parameters.mu0,
        sigma:        defaultSigma,
        wins:         0,
        losses:       0,
        roundsPlayed: 0,
        lastSeen:     endedAt
      });
    }
    return players.get(eosID);
  };

  let processed = 0;
  let skipped   = 0;

  for (const match of matches) {
    const team1Players = match.players.filter(p => p.teamID === 1);
    const team2Players = match.players.filter(p => p.teamID === 2);

    if (team1Players.length === 0 || team2Players.length === 0) {
      skipped++;
      continue;
    }

    // Ensure all players exist in state map
    for (const p of match.players) getOrInit(p.eosID, p.name, match.endedAt);

    // Build rating arrays for the engine
    const toRating = p => ({
      eosID: p.eosID,
      mu: players.get(p.eosID).mu,
      sigma: players.get(p.eosID).sigma,
      participationRatio: p.participationRatio
    });

    const t1Ratings = team1Players.map(toRating);
    const t2Ratings = team2Players.map(toRating);

    // Per-player TrueSkill2 observations from the log. Old records lack these
    // fields entirely — the corresponding factors stay inert for those rounds.
    const roundDurationMin = (match.roundDuration ?? 0) / 60000;
    const partyByEos = computePartySizes(
      match.players.map(pl => ({ eosID: pl.eosID, name: pl.name, teamID: pl.teamID })),
      partyOptions
    );
    const perPlayerMeta = {};
    for (const p of match.players) {
      perPlayerMeta[p.eosID] = {
        clanTag: (partyByEos.get(p.eosID) ?? {}).clanTag ?? null,
        partySize: (partyByEos.get(p.eosID) ?? {}).partySize ?? 1,
        experience: players.get(p.eosID).roundsPlayed,
        kills: p.kills,
        deaths: p.deaths,
        timePlayedMin: roundDurationMin * (p.participationRatio ?? 1),
        quit: applyQuitPenalty ? (p.quit ?? false) : false
      };
    }

    const { team1Updates, team2Updates } = computeRoundUpdate(
      t1Ratings, t2Ratings, match.outcome, perPlayerMeta, parameters
    );

    const isTeam1Winner = match.outcome === 'team1win';
    const isTeam2Winner = match.outcome === 'team2win';

    // Apply scaled updates
    const applyUpdates = (matchPlayers, updates, isWinner, isLoser) => {
      matchPlayers.forEach((mp, i) => {
        const state = players.get(mp.eosID);
        const { deltaMu, deltaSigma } = updates[i];
        const scaled_dMu    = deltaMu    * mp.participationRatio;
        const scaled_dSigma = deltaSigma * mp.participationRatio;

        state.mu           = state.mu + scaled_dMu;
        state.sigma        = Math.max(state.sigma - scaled_dSigma, 0.5);
        state.roundsPlayed += 1;
        state.wins         += isWinner ? 1 : 0;
        state.losses       += isLoser  ? 1 : 0;
        state.lastSeen     = match.endedAt;
        state.name         = mp.name; // keep most recent name
      });
    };

    applyUpdates(team1Players, team1Updates, isTeam1Winner, isTeam2Winner);
    applyUpdates(team2Players, team2Updates, isTeam2Winner, isTeam1Winner);

    processed++;
    if (!quiet) process.stdout.write(`\rReplaying match ${processed} / ${matches.length}...`);
  }

  return { players, parameters, processed, skipped };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const applyQuitPenalty = process.argv.includes('--apply-quit-penalty');
  const partyCaseSensitive = process.argv.includes('--party-case-sensitive');
  const edArg = process.argv.find(a => a.startsWith('--party-max-edit-distance='));
  const partyMaxEditDistance = edArg ? Number(edArg.split('=')[1]) : 1;
  const args = process.argv.slice(2).filter(a =>
    a !== '--apply-quit-penalty' &&
    a !== '--party-case-sensitive' &&
    !a.startsWith('--party-max-edit-distance='));
  const matchlogPath = args[0];
  const backupPath = args[1];
  const outputArg = args[2];

  if (!matchlogPath || !backupPath) {
    console.error('Usage: node elo-rebuild.js <matchlog.jsonl> <backup.json> [output.json] [--apply-quit-penalty] [--party-case-sensitive] [--party-max-edit-distance=N]');
    process.exit(1);
  }

  const outputPath = outputArg ?? `elo-rebuilt-${Date.now()}.json`;

  const { players, parameters, processed, skipped } = await rebuildFromLog(
    matchlogPath, backupPath, {}, {
      applyQuitPenalty,
      quiet: false,
      partyOptions: { caseSensitive: partyCaseSensitive, maxEditDistance: partyMaxEditDistance }
    }
  );

  console.log(`\nDone. Processed: ${processed}, Skipped: ${skipped}`);

  // Build output in backup schema (drop-in compatible with !elo restore)
  const output = {
    exportedAt:  Date.now(),
    playerCount: players.size,
    params: {
      MU_DEFAULT: parameters.mu0,
      SIGMA_DEFAULT: Math.sqrt(parameters.v0),
      BETA: parameters.beta,
      TAU: parameters.tau,
      DRAW_PROBABILITY: parameters.drawProbability,
      applyQuitPenalty,
      note: 'Rebuilt from match log using the TrueSkill2 engine.'
    },
    players: Array.from(players.values())
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');
  console.log(`Written to: ${outputPath}`);
  console.log(`Total players: ${players.size}`);

  // Quick sanity summary
  const muValues = Array.from(players.values()).map(p => p.mu);
  const mean = muValues.reduce((s, v) => s + v, 0) / muValues.length;
  const diverged = muValues.filter(m => Math.abs(m - parameters.mu0) > 0.5).length;
  console.log(`Avg mu: ${mean.toFixed(3)}  |  Players with |mu-${parameters.mu0}| > 0.5: ${diverged} / ${players.size} (${(diverged / players.size * 100).toFixed(1)}%)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err); process.exit(1); });
}
