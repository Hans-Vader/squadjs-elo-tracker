import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { rebuildFromLog } from '../tools/elo-rebuild.js';
import EloCalculator from '../utils/elo-calculator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(__dirname, 'fixtures/rebuild-sample.jsonl');
const BACKUP = path.join(__dirname, 'fixtures/rebuild-backup.json');
const CLI = path.join(__dirname, '../tools/elo-rebuild.js');

export default async function runRebuildTests(runTest) {
  await runTest('Rebuild: replays the fixture and produces sane, ordered ratings', async () => {
    const { players, processed, skipped } = await rebuildFromLog(LOG, BACKUP);
    if (processed !== 10) throw new Error(`expected 10 processed matches, got ${processed}`);
    if (skipped !== 0) throw new Error(`expected 0 skipped, got ${skipped}`);
    const w1 = players.get('w1');
    const l1 = players.get('l1');
    if (!w1 || !l1) throw new Error('players missing from rebuild state');
    if (!(w1.mu > 25)) throw new Error(`serial winner must climb: ${w1.mu}`);
    if (!(l1.mu < 25)) throw new Error(`serial loser must fall: ${l1.mu}`);
    if (!(w1.sigma < 8.333) || !(w1.sigma >= 0.5)) throw new Error(`sigma out of range: ${w1.sigma}`);
    if (w1.wins !== 9 || w1.losses !== 0) throw new Error(`w1 W/L wrong: ${w1.wins}/${w1.losses} (one draw)`);
    if (w1.roundsPlayed !== 10) throw new Error(`w1 roundsPlayed wrong: ${w1.roundsPlayed}`);
  });

  await runTest('Rebuild: restore-compatible player fields incl. backup steamID/discordID', async () => {
    const { players } = await rebuildFromLog(LOG, BACKUP);
    const w1 = players.get('w1');
    for (const field of ['eosID', 'steamID', 'discordID', 'name', 'mu', 'sigma', 'wins', 'losses', 'roundsPlayed', 'lastSeen']) {
      if (!(field in w1)) throw new Error(`restore-compat field missing: ${field}`);
    }
    if (w1.steamID !== 'steam_w1') throw new Error('steamID not preserved from backup');
    if (w1.discordID !== 'disc_w1') throw new Error('discordID not preserved from backup');
    const w2 = players.get('w2');
    if (w2.steamID !== null) throw new Error('players absent from backup default to null steamID');
  });

  await runTest('Rebuild: neutral params reproduce a legacy computeTeamUpdate replay exactly', async () => {
    const { players } = await rebuildFromLog(LOG, BACKUP);

    // Manual legacy replay of the same fixture
    const fs = await import('fs');
    const matches = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
    matches.sort((a, b) => a.endedAt - b.endedAt);
    const state = new Map();
    const get = (id) => {
      if (!state.has(id)) state.set(id, { mu: EloCalculator.MU_DEFAULT, sigma: EloCalculator.SIGMA_DEFAULT });
      return state.get(id);
    };
    for (const match of matches) {
      const t1 = match.players.filter((p) => p.teamID === 1);
      const t2 = match.players.filter((p) => p.teamID === 2);
      const toRating = (p) => ({ eosID: p.eosID, mu: get(p.eosID).mu, sigma: get(p.eosID).sigma, participationRatio: p.participationRatio });
      const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(t1.map(toRating), t2.map(toRating), match.outcome);
      const apply = (ps, ups) => ps.forEach((p, i) => {
        const s = get(p.eosID);
        s.mu += ups[i].deltaMu * p.participationRatio;
        s.sigma = Math.max(s.sigma - ups[i].deltaSigma * p.participationRatio, 0.5);
      });
      apply(t1, team1Updates);
      apply(t2, team2Updates);
    }

    for (const [id, legacy] of state) {
      const rebuilt = players.get(id);
      if (Math.abs(rebuilt.mu - legacy.mu) > 1e-9 || Math.abs(rebuilt.sigma - legacy.sigma) > 1e-9) {
        throw new Error(`${id}: rebuild ${rebuilt.mu}/${rebuilt.sigma} != legacy ${legacy.mu}/${legacy.sigma}`);
      }
    }
  });

  await runTest('Rebuild: applyQuitPenalty option punishes logged quits', async () => {
    const withoutPenalty = await rebuildFromLog(LOG, BACKUP);
    const withPenalty = await rebuildFromLog(LOG, BACKUP, {}, { applyQuitPenalty: true });
    const before = withoutPenalty.players.get('l4').mu;
    const after = withPenalty.players.get('l4').mu;
    if (!(after < before)) {
      throw new Error(`quit-flagged l4 must end lower with the penalty applied: ${after} vs ${before}`);
    }
    // Players without quit flags are unaffected
    const w1a = withoutPenalty.players.get('w1').mu;
    const w1b = withPenalty.players.get('w1').mu;
    if (Math.abs(w1a - w1b) > 1e-9) throw new Error('non-quitters must be unaffected by the quit option');
  });

  await runTest('Rebuild: works without a backup file (null)', async () => {
    const { players } = await rebuildFromLog(LOG, null);
    if (!players.get('w1') || players.get('w1').steamID !== null) {
      throw new Error('backup-less rebuild must still work with null steamIDs');
    }
  });

  await runTest('Rebuild: replay prefers logged partySize/clanTag over name-based recompute', async () => {
    const fs = await import('fs');
    const os = await import('os');

    // Non-zero size-2 party boost so the effect is observable in mu; size-1
    // stays pinned to 0 by loadParameters (identifiability).
    const partyOverrides = { partyOffsets: [0, 3.0] };

    // Record 1 simulates a POST-feature log entry: the live plugin logged
    // p1's exact partySize/clanTag (2/'ACE') because p1 was eligible, even
    // though p1's other party member was sub-threshold/ineligible and so
    // never appears in the log at all. Recomputing from names alone would
    // see only ONE '[ACE]'-tagged name on team1 — below extractClanGroups'
    // minSize:2 — and collapse to a solo (partySize 1). `record1NoField` is
    // the same match with the fields stripped (pre-feature shape), which
    // MUST recompute to the same solo partySize 1 for p1.
    const record1WithField = {
      matchId: 'm1', endedAt: 1700000000000, outcome: 'team1win', roundDuration: 1500000,
      players: [
        { eosID: 'p1', name: '[ACE] Alpha', teamID: 1, participationRatio: 1, partySize: 2, clanTag: 'ACE' },
        { eosID: 'p2', name: 'Solo2', teamID: 2, participationRatio: 1 }
      ]
    };
    const record1NoField = {
      matchId: 'm1', endedAt: 1700000000000, outcome: 'team1win', roundDuration: 1500000,
      players: [
        { eosID: 'p1', name: '[ACE] Alpha', teamID: 1, participationRatio: 1 },
        { eosID: 'p2', name: 'Solo2', teamID: 2, participationRatio: 1 }
      ]
    };
    // Record 2 is identical in both files: a pre-feature record (no
    // partySize/clanTag at all) with plain, tag-less names — must fall back
    // to the name-based recompute (partySize 1) regardless of record 1.
    const record2 = {
      matchId: 'm2', endedAt: 1700003600000, outcome: 'team1win', roundDuration: 1500000,
      players: [
        { eosID: 'p3', name: 'Charlie', teamID: 1, participationRatio: 1 },
        { eosID: 'p4', name: 'Delta', teamID: 2, participationRatio: 1 }
      ]
    };

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-rebuild-party-'));
    const pathWithField = path.join(tmpDir, 'with-field.jsonl');
    const pathNoField   = path.join(tmpDir, 'no-field.jsonl');
    fs.writeFileSync(pathWithField, `${JSON.stringify(record1WithField)}\n${JSON.stringify(record2)}\n`, 'utf8');
    fs.writeFileSync(pathNoField,   `${JSON.stringify(record1NoField)}\n${JSON.stringify(record2)}\n`, 'utf8');

    try {
      const withField = await rebuildFromLog(pathWithField, null, partyOverrides);
      const noField    = await rebuildFromLog(pathNoField,   null, partyOverrides);

      const muWithField = withField.players.get('p1').mu;
      const muNoField   = noField.players.get('p1').mu;

      if (Math.abs(muWithField - muNoField) < 0.05) {
        throw new Error(
          `logged partySize:2 must diverge from the recomputed-from-names singleton (partySize 1): ` +
          `withField.mu=${muWithField}, noField.mu=${muNoField}`
        );
      }

      // p3/p4 (record 2) never carry the field in either file — both runs
      // must recompute identically, proving the divergence above is caused
      // by the resolution logic honouring record 1's logged field, not by
      // some unrelated difference between the two replay runs.
      for (const id of ['p3', 'p4']) {
        const a = withField.players.get(id).mu;
        const b = noField.players.get(id).mu;
        if (Math.abs(a - b) > 1e-9) {
          throw new Error(`pre-feature record (${id}) must replay identically regardless of record 1: ${a} vs ${b}`);
        }
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await runTest('Rebuild CLI: --params file drives the engine parameters', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-rebuild-params-'));
    try {
      const paramsFile = path.join(tmpDir, 'params.json');
      // Accepts the plugin-options shape ({ trueskill2: {...} }) as pasted
      // from the calibrator output.
      fs.writeFileSync(paramsFile, JSON.stringify({ trueskill2: { beta: 12 } }));
      const outFile = path.join(tmpDir, 'out.json');
      execFileSync(process.execPath, [CLI, LOG, BACKUP, outFile, `--params=${paramsFile}`], { stdio: 'pipe' });
      const out = JSON.parse(fs.readFileSync(outFile, 'utf8'));
      if (out.params.BETA !== 12) {
        throw new Error(`output must echo the loaded beta 12, got ${out.params.BETA} — --params ignored`);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await runTest('Rebuild CLI: invalid --params fails fast with the validation error', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'elo-rebuild-badparams-'));
    try {
      const paramsFile = path.join(tmpDir, 'params.json');
      fs.writeFileSync(paramsFile, JSON.stringify({ trueskill2: { drawProbability: 1 } }));
      let failed = false;
      try {
        execFileSync(process.execPath, [CLI, LOG, BACKUP, path.join(tmpDir, 'out.json'), `--params=${paramsFile}`], { stdio: 'pipe' });
      } catch (err) {
        failed = true;
        const stderr = err.stderr?.toString() ?? '';
        if (!stderr.includes('Invalid trueskill2 config')) {
          throw new Error(`expected the validation message on stderr, got: ${stderr.slice(0, 200)}`);
        }
      }
      if (!failed) throw new Error('invalid --params must exit non-zero, not silently replay with defaults');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
}
