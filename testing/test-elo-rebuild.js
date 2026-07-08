import path from 'path';
import { fileURLToPath } from 'url';
import { rebuildFromLog } from '../tools/elo-rebuild.js';
import EloCalculator from '../utils/elo-calculator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = path.join(__dirname, 'fixtures/rebuild-sample.jsonl');
const BACKUP = path.join(__dirname, 'fixtures/rebuild-backup.json');

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
}
