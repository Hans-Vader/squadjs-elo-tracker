/**
 * test-elo-lookup.js
 *
 * Player lookup, rank and command-surface fixes ported from
 * squadjs-slackers-suite (elo-tracker 2.1.x). Runs against a real
 * in-memory SQLite database; Discord and RCON are faked at the edge.
 */
import Sequelize from 'sequelize';
import EloDatabase from '../utils/elo-database.js';
import EloTracker from '../plugins/elo-tracker.js';
import { EloDiscord } from '../utils/elo-discord.js';

const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

async function freshDb(rows = []) {
  const sequelize = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
  const db = new EloDatabase({}, {}, { sqlite: sequelize });
  await db.initDB();
  if (rows.length) {
    await db.models.PlayerStats.bulkCreate(rows.map((r, i) => ({
      eosID: `eos_${i}`, mu: 25, sigma: 5, wins: 0, losses: 0, roundsPlayed: 20, lastSeen: 1000, ...r
    })));
  }
  return db;
}

async function trackerWith(rows, { serverPlayers = [], minRounds = 10 } = {}) {
  const db = await freshDb(rows);
  const warns = [];
  const server = {
    players: serverPlayers,
    rcon: { warn: async (id, msg) => { warns.push({ id, msg }); } },
    on() {},
    removeListener() {}
  };
  const tracker = new EloTracker(server, { minRoundsForLeaderboard: minRounds }, {});
  tracker.db = db;
  tracker.ready = true;
  return { tracker, db, warns };
}

function discordHarness(tracker) {
  const sent = [];
  const replies = [];
  const channel = { id: 'chan-admin', name: 'elo-admin', send: async (payload) => { sent.push(payload); } };
  tracker.options.discordAdminChannelID = 'chan-admin';
  tracker.discordAdminChannel = channel;
  const say = (content) => tracker.onDiscordMessage({
    author: { bot: false, id: 'discord-user' },
    member: null,
    content,
    channel,
    reply: async (text) => { replies.push(text); },
    delete: async () => {}
  });
  return { sent, replies, say };
}

const asker = { name: 'Asker', steamID: '76561190000000000', eosID: 'eos_asker' };

export default async function runLookupTests(runTest) {
  // ─── A2: LIKE escaping ───────────────────────────────────────────

  await runTest('Search: underscore in a name matches literally, not as a wildcard', async () => {
    const db = await freshDb([
      { name: ' John_Doe', roundsPlayed: 5 },
      { name: ' JohnXDoe', roundsPlayed: 500 }
    ]);
    const hit = await db.searchPlayer('John_Doe');
    assert(hit, 'no match for "John_Doe"');
    assert(hit.name === ' John_Doe', `expected " John_Doe", got "${hit.name}"`);
  });

  await runTest('Search: quote and percent in the term neither break nor widen the query', async () => {
    const db = await freshDb([
      { name: "O'Brien" },
      { name: '100%Sniper', roundsPlayed: 1 },
      { name: '1000Sniper', roundsPlayed: 900 }
    ]);
    const quoted = await db.searchPlayer("O'Brien");
    assert(quoted?.name === "O'Brien", `O'Brien lookup returned ${quoted?.name}`);
    const pct = await db.searchPlayer('100%');
    assert(pct?.name === '100%Sniper', `"100%" lookup returned ${pct?.name}`);
  });

  // ─── B: ranked search ────────────────────────────────────────────

  await runTest('Search: tagged regular beats a prefix drive-by ("cerv")', async () => {
    const db = await freshDb([
      { name: 'Cerveira', roundsPlayed: 2 },
      { name: ' [NL] Cerv', roundsPlayed: 267 }
    ]);
    const results = await db.searchPlayers('cerv');
    assert(results[0]?.name === ' [NL] Cerv', `top hit was ${results[0]?.name}`);
    assert(results[0]._matchTier === 1, `tagged exact should be tier 1, got ${results[0]._matchTier}`);
    assert(results[1]?._matchTier === 2, `Cerveira should be a tier-2 prefix hit, got ${results[1]?._matchTier}`);
  });

  await runTest('Search: literal and tag-stripped exact names share tier 1, rounds decide', async () => {
    const db = await freshDb([
      { name: ' Hunty', roundsPlayed: 12 },
      { name: '[✦NL✦] Hunty', roundsPlayed: 384 }
    ]);
    const results = await db.searchPlayers('hunty');
    assert(results[0]?.name === '[✦NL✦] Hunty', `top hit was ${results[0]?.name}`);
    assert(!EloDatabase.isUnambiguous(results), 'two tier-1 hits must be ambiguous');
    const hint = EloDatabase.formatOtherMatches(results);
    assert(hint && hint.includes('Hunty (12 rds)'), `hint should name the runner-up, got ${hint}`);
  });

  await runTest('Search: unique exact name (stored with leading space) is unambiguous', async () => {
    const db = await freshDb([
      { name: ' Slacker', roundsPlayed: 3 },
      { name: 'SlackerFan', roundsPlayed: 300 }
    ]);
    const results = await db.searchPlayers('SLACKER');
    assert(results[0]?.name === ' Slacker', `top hit was ${results[0]?.name}`);
    assert(EloDatabase.isUnambiguous(results), 'unique exact hit should be unambiguous');
    assert(EloDatabase.formatOtherMatches(results) === null, 'no hint expected for a unique exact hit');
  });

  await runTest('Search: exact ID short-circuits as tier 0', async () => {
    const db = await freshDb([{ eosID: 'abc', steamID: '7656', name: 'Someone' }]);
    const bySteam = await db.searchPlayers('7656');
    assert(bySteam.length === 1 && bySteam[0]._matchTier === 0, 'steamID should be a lone tier-0 hit');
    assert(EloDatabase.isUnambiguous(bySteam), 'ID hit should be unambiguous');
  });

  await runTest('Search: prefix-only hit is never unambiguous', async () => {
    const db = await freshDb([{ name: 'Cerveira' }]);
    const results = await db.searchPlayers('cerv');
    assert(results.length === 1, `expected one hit, got ${results.length}`);
    assert(!EloDatabase.isUnambiguous(results), 'a prefix hit is a guess');
  });

  await runTest('Search: online player wins a tie within a tier', async () => {
    const db = await freshDb([
      { eosID: 'offline', name: 'Cervantes', roundsPlayed: 900 },
      { eosID: 'online', name: 'Cervical', roundsPlayed: 1 }
    ]);
    const results = await db.searchPlayers('cerv', { onlineIDs: new Set(['online']) });
    assert(results[0]?.eosID === 'online', `top hit was ${results[0]?.eosID}`);
  });

  await runTest('stripClanTags: removes bracket/symbol decoration only', async () => {
    const cases = [
      ['[NL] Cerv', 'Cerv'],
      ['Cerv [NL]', 'Cerv'],
      ['=NL= Cerv', 'Cerv'],
      [' John Smith', 'John Smith'],
      ['[NL]', '[NL]']
    ];
    for (const [input, expected] of cases) {
      const got = EloDatabase.stripClanTags(input);
      assert(got === expected, `stripClanTags(${JSON.stringify(input)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`);
    }
  });

  // ─── A3: rank by eosID ───────────────────────────────────────────

  await runTest('Rank: getPlayerRank resolves by eosID; ties share a rank; minRounds filters', async () => {
    const db = await freshDb([
      { eosID: 'top', mu: 40, sigma: 2 },
      { eosID: 'tied', mu: 40, sigma: 2 },
      { eosID: 'third', mu: 30, sigma: 2 },
      { eosID: 'rookie', mu: 60, sigma: 2, roundsPlayed: 1 }
    ]);
    assert(await db.getPlayerRank('top', 10) === 1, 'top should be #1');
    assert(await db.getPlayerRank('tied', 10) === 1, 'equal CSR must not outrank itself or its twin');
    assert(await db.getPlayerRank('third', 10) === 3, 'third should be #3 (rookie below minRounds ignored)');
    assert(await db.getPlayerRank('third', 0) === 4, 'with minRounds 0 the rookie counts');
  });

  // ─── A1 / A3 / B / C: in-game commands ──────────────────────────

  await runTest('In-game !elo <name>: shows stats with the correct rank', async () => {
    const { tracker, warns } = await trackerWith([
      { eosID: 'first', name: ' Slacker', mu: 40, sigma: 2 },
      { eosID: 'second', name: ' Second', mu: 30, sigma: 2 }
    ]);
    await tracker.onEloCommand({ message: '!elo second', player: asker });
    const msg = warns[0]?.msg || '';
    assert(msg.includes('Rank: #2'), `expected "Rank: #2", got: ${msg}`);
  });

  await runTest('In-game !elo leaderboard: lists players', async () => {
    const { tracker, warns } = await trackerWith([{ name: ' Slacker', mu: 40, sigma: 2 }]);
    await tracker.onEloCommand({ message: '!elo leaderboard', player: asker });
    const msg = warns[0]?.msg || '';
    assert(msg.includes('Slacker'), `leaderboard missing player: ${msg}`);
  });

  await runTest('In-game !elo <partial>: names the runners-up', async () => {
    const { tracker, warns } = await trackerWith([
      { name: '[NL] Cerv', roundsPlayed: 267 },
      { name: '[US] Cerv', roundsPlayed: 30 }
    ]);
    await tracker.onEloCommand({ message: '!elo cerv', player: asker });
    const msg = warns[0]?.msg || '';
    assert(msg.includes('Also matched: [US] Cerv'), `missing hint: ${msg}`);
  });

  await runTest('In-game !elo <unknown>: points at !elo help', async () => {
    const { tracker, warns } = await trackerWith([]);
    await tracker.onEloCommand({ message: '!elo nobody', player: asker });
    const msg = warns[0]?.msg || '';
    assert(msg.includes('Type !elo help'), `missing help hint: ${msg}`);
  });

  await runTest('In-game reply reaches a player without a steamID via eosID', async () => {
    const { tracker, warns } = await trackerWith([]);
    await tracker.onEloCommand({ message: '!elo help', player: { name: 'EpicGuy', eosID: 'eos_epic' } });
    assert(warns[0]?.id === 'eos_epic', `warn target was ${warns[0]?.id}`);
  });

  await runTest('In-game !eloadmin reset refuses an ambiguous match', async () => {
    const { tracker, db, warns } = await trackerWith([
      { eosID: 'nl', name: '[NL] Cerv', mu: 40, roundsPlayed: 267 },
      { eosID: 'us', name: '[US] Cerv', mu: 35, roundsPlayed: 30 }
    ]);
    await tracker.onEloAdminCommand({ chat: 'ChatAdmin', message: '!eloadmin reset cerv', player: asker });
    const msg = warns[0]?.msg || '';
    assert(msg.includes('Ambiguous'), `expected refusal, got: ${msg}`);
    const nl = await db.getPlayerStats('nl');
    assert(nl.mu === 40, `[NL] Cerv was reset (mu ${nl.mu})`);
  });

  await runTest('In-game !eloadmin reset resets a unique exact match', async () => {
    const { tracker, db } = await trackerWith([
      { eosID: 'sl', name: ' Slacker', mu: 40, roundsPlayed: 50 },
      { eosID: 'fan', name: 'SlackerFan', mu: 30, roundsPlayed: 50 }
    ]);
    await tracker.onEloAdminCommand({ chat: 'ChatAdmin', message: '!eloadmin reset slacker', player: asker });
    const sl = await db.getPlayerStats('sl');
    const fan = await db.getPlayerStats('fan');
    assert(sl.roundsPlayed === 0, `Slacker not reset (rounds ${sl.roundsPlayed})`);
    assert(fan.roundsPlayed === 50, 'SlackerFan must be untouched');
  });

  // ─── A4 / B / C: Discord commands ───────────────────────────────

  await runTest('Discord: !ELO help gets an answer', async () => {
    const { tracker } = await trackerWith([]);
    const { sent, say } = discordHarness(tracker);
    await say('!ELO help');
    assert(sent.length === 1, `expected one reply embed, got ${sent.length}`);
  });

  await runTest('Discord: !elophant is not treated as a lookup', async () => {
    const { tracker } = await trackerWith([]);
    const { sent, replies, say } = discordHarness(tracker);
    await say('!elophant');
    assert(sent.length === 0 && replies.length === 0, `unexpected answer: ${replies[0] || JSON.stringify(sent[0])}`);
  });

  await runTest('Discord: !elo reset Confirm confirms a pending full reset', async () => {
    const { tracker, db } = await trackerWith([{ name: 'Someone' }]);
    const { say } = discordHarness(tracker);
    tracker._resetConfirmPending = { timestamp: Date.now() };
    await say('!elo reset Confirm');
    const left = await db.models.PlayerStats.count();
    assert(left === 0, `full reset did not run (${left} rows left)`);
  });

  await runTest('Discord: !elo reset <ambiguous> resets nothing', async () => {
    const { tracker, db } = await trackerWith([
      { eosID: 'nl', name: '[NL] Cerv', mu: 40, roundsPlayed: 267 },
      { eosID: 'us', name: '[US] Cerv', mu: 35, roundsPlayed: 30 }
    ]);
    const { replies, say } = discordHarness(tracker);
    await say('!elo reset cerv');
    assert(replies.some((r) => r.includes('Ambiguous')), `expected refusal, got: ${replies.join(' | ')}`);
    const nl = await db.getPlayerStats('nl');
    assert(nl.mu === 40, `[NL] Cerv was reset (mu ${nl.mu})`);
  });

  await runTest('Discord: !elo <name> shows the correct rank and the runner-up footer', async () => {
    const { tracker } = await trackerWith([
      { eosID: 'first', name: ' Slacker', mu: 40, sigma: 2 },
      { eosID: 'nl', name: '[NL] Cerv', mu: 30, sigma: 2, roundsPlayed: 267 },
      { eosID: 'us', name: '[US] Cerv', mu: 20, sigma: 2, roundsPlayed: 30 }
    ]);
    const { sent, say } = discordHarness(tracker);
    await say('!elo cerv');
    const embed = sent[0]?.embeds?.[0];
    assert(embed?.description?.includes('Rank **#2**'), `wrong rank: ${embed?.description}`);
    assert(embed?.footer?.text?.includes('[US] Cerv'), `missing footer: ${JSON.stringify(embed?.footer)}`);
  });

  await runTest('Discord: !elo explain shows the starting σ rounded to 2 decimals', async () => {
    const { tracker } = await trackerWith([]);
    const { sent, say } = discordHarness(tracker);
    await say('!elo explain');
    const text = JSON.stringify(sent[0]?.embeds?.[0]?.fields || []);
    assert(text.includes('starts at 8.33 ') && !text.includes('8.333'), `σ not rounded: ${text}`);
  });

  // ─── C: sendDiscordMessage ───────────────────────────────────────

  await runTest('sendDiscordMessage: failure names the channel', async () => {
    const channel = { id: '42', name: 'reports', send: async () => { throw new Error('boom'); } };
    let message = '';
    try {
      await EloDiscord.sendDiscordMessage(channel, { embeds: [{ title: 'x' }] }, false);
    } catch (err) {
      message = err.message;
    }
    assert(message.includes('#reports (42)'), `channel missing from error: ${message}`);
  });

  await runTest('sendDiscordMessage: 429 honours retry-after from a Headers-like object', async () => {
    let calls = 0;
    const channel = {
      id: '42',
      name: 'reports',
      send: async () => {
        calls++;
        if (calls === 1) {
          const err = new Error('rate limited');
          err.status = 429;
          err.headers = new Map([['retry-after', '0.01']]);
          throw err;
        }
      }
    };
    const started = Date.now();
    const ok = await EloDiscord.sendDiscordMessage(channel, { embeds: [{ title: 'x' }] });
    const elapsed = Date.now() - started;
    assert(ok === true && calls === 2, `expected one retry and success (calls ${calls}, ok ${ok})`);
    assert(elapsed < 500, `waited ${elapsed}ms instead of the 10ms retry-after`);
  });
}
