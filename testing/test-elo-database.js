import Sequelize from 'sequelize';
import EloDatabase from '../utils/elo-database.js';

export default async function runDatabaseTests(runTest) {
  // Setup: In-memory SQLite instance
  const sequelize = new Sequelize({
    dialect: 'sqlite',
    storage: ':memory:',
    logging: false
  });

  // Mock connectors and server/options
  const connectors = { sqlite: sequelize };
  const server = {};
  const options = {};

  // Instantiate the database class
  const db = new EloDatabase(server, options, connectors);

  await runTest('Initialization: Create Tables', async () => {
    // Initialize DB (syncs models)
    await db.initDB();

    // Verify models are defined
    if (!db.models.PlayerStats) throw new Error('PlayerStats model missing');
    if (!db.models.RoundHistory) throw new Error('RoundHistory model missing');
    if (!db.models.PluginState) throw new Error('PluginState model missing');

    // Verify PluginState initialized with default row
    const state = await db.models.PluginState.findOne({ where: { id: 1 } });
    if (!state) throw new Error('PluginState not initialized');
    if (state.roundStartTime !== null) throw new Error('roundStartTime should be null initially');
  });

  await runTest('CRUD: Save and Search', async () => {
    const player = {
      eosID: 'eos_123',
      steamID: 'steam_456',
      name: 'Test Player',
      mu: 28.0,
      sigma: 7.5
    };

    // 1. Upsert Player
    await db.upsertPlayerStats(player.eosID, player);

    // 2. Search by EOSID (Exact match)
    const byEos = await db.searchPlayer('eos_123');
    if (!byEos || byEos.name !== player.name) throw new Error('Failed to find by EOSID');

    // 3. Search by SteamID (Exact match via OR condition)
    const bySteam = await db.searchPlayer('steam_456');
    if (!bySteam || bySteam.eosID !== player.eosID) throw new Error('Failed to find by SteamID');

    // 4. Search by Name (Partial match)
    const byName = await db.searchPlayer('Test Play');
    if (!byName || byName.eosID !== player.eosID) throw new Error('Failed to find by partial name');
  });

  await runTest('Retry Logic: SQLITE_BUSY', async () => {
    let attempts = 0;

    // Mock function that throws SQLITE_BUSY once, then succeeds
    const flakyFunc = async () => {
      attempts++;
      if (attempts === 1) {
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return 'success';
    };

    const result = await db._executeWithRetry(flakyFunc);
    if (result !== 'success') throw new Error('Retry logic failed to return result');
    if (attempts !== 2) throw new Error(`Expected 2 attempts (1 fail + 1 retry), got ${attempts}`);
  });

  await runTest('RoundPlayers: TrueSkill2 columns persist', async () => {
    const row = {
      matchId: 'm1',
      roundStartTime: 1000,
      roundHistoryId: 1,
      eosID: 'ts2_p1',
      steamID: 's1',
      name: 'P1',
      teamID: 1,
      participationRatio: 0.9,
      partySize: 6,
      clanTag: 'ACE',
      kills: 12,
      deaths: 3,
      quit: false,
      experienceBefore: 27,
      muBefore: 25,
      sigmaBefore: 8.33,
      rawDeltaMu: 0.5,
      rawDeltaSigma: 0.1,
      scaledDeltaMu: 0.45,
      scaledDeltaSigma: 0.09,
      muAfter: 25.45,
      sigmaAfter: 8.24
    };
    await db.insertRoundPlayers(1, Date.now(), [row]);

    const read = await db.models.RoundPlayers.findOne({ where: { eosID: 'ts2_p1' } });
    if (!read) throw new Error('row not inserted');
    if (read.partySize !== 6) throw new Error(`partySize column missing or wrong: ${read.partySize}`);
    if (read.clanTag !== 'ACE') throw new Error(`clanTag column missing or wrong: ${read.clanTag}`);
    if (read.kills !== 12) throw new Error(`kills column missing: ${read.kills}`);
    if (read.deaths !== 3) throw new Error(`deaths column missing: ${read.deaths}`);
    if (read.quit !== false && read.quit !== 0) throw new Error(`quit column missing: ${read.quit}`);
    if (read.experienceBefore !== 27) throw new Error(`experienceBefore column missing: ${read.experienceBefore}`);
  });

  await runTest('Schema check: fresh DB reports RoundPlayers schema OK', async () => {
    const seq = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
    const freshDb = new EloDatabase({}, {}, { sqlite: seq });
    const result = await freshDb.initDB();
    if (result.roundPlayersSchemaOk !== true) {
      throw new Error(`fresh DB must report roundPlayersSchemaOk=true, got ${result.roundPlayersSchemaOk}`);
    }
    await seq.close();
  });

  await runTest('Schema check: pre-existing RoundPlayers missing TS2 columns is detected', async () => {
    // Simulate an OLD install: a RoundPlayers table created before the TS2
    // columns existed. sync() without alter never adds them, so every
    // insertRoundPlayers would fail silently forever — initDB must flag it.
    const seq = new Sequelize({ dialect: 'sqlite', storage: ':memory:', logging: false });
    await seq.getQueryInterface().createTable('Elo_RoundPlayers', {
      id: { type: Sequelize.INTEGER, primaryKey: true, autoIncrement: true },
      eosID: { type: Sequelize.STRING, allowNull: false },
      teamID: { type: Sequelize.INTEGER, allowNull: false },
      participationRatio: { type: Sequelize.FLOAT, allowNull: false },
      muBefore: { type: Sequelize.FLOAT, allowNull: false },
      sigmaBefore: { type: Sequelize.FLOAT, allowNull: false },
      rawDeltaMu: { type: Sequelize.FLOAT, allowNull: false },
      rawDeltaSigma: { type: Sequelize.FLOAT, allowNull: false },
      scaledDeltaMu: { type: Sequelize.FLOAT, allowNull: false },
      scaledDeltaSigma: { type: Sequelize.FLOAT, allowNull: false },
      muAfter: { type: Sequelize.FLOAT, allowNull: false },
      sigmaAfter: { type: Sequelize.FLOAT, allowNull: false }
      // no partySize/clanTag/kills/deaths/quit/experienceBefore
    });
    const oldDb = new EloDatabase({}, {}, { sqlite: seq });
    const result = await oldDb.initDB();
    if (result.roundPlayersSchemaOk !== false) {
      throw new Error('missing TS2 columns must set roundPlayersSchemaOk=false');
    }
    await seq.close();
  });

}