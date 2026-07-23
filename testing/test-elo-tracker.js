import EloTracker from '../plugins/elo-tracker.js';

export default async function runTrackerTests(runTest) {
  // Helper to create a fresh mock server for each test
  const createMockServer = () => ({
    players: [],
    listeners: {},
    matchStartTime: new Date(),
    currentLayer: { gamemode: 'AAS', name: 'Test_Layer' },
    on(event, fn) {
      this.listeners[event] = fn;
    },
    removeListener(event, fn) {
      if (this.listeners[event] === fn) {
        delete this.listeners[event];
      }
    },
    async emit(event, data) {
      if (this.listeners[event]) {
        await this.listeners[event](data);
      }
    }
  });

  // Helper to create mock DB
  const createMockDb = () => ({
    initDB: async () => ({ roundStartTime: null }),
    pruneStaleEntries: async () => ({ tier1: 0, tier2: 0 }),
    saveRoundStartTime: async () => {},
    getPlayerStatsBatch: async (ids) => {
      const map = new Map();
      // Return default stats for any requested ID
      ids.forEach(id => map.set(id, { mu: 25.0, sigma: 8.333 }));
      return map;
    },
    bulkIncrementPlayerStats: async () => {},
    insertRoundHistory: async () => {},
    calls: { bulkIncrement: 0, insertHistory: 0 }
  });

  // Helper to create mock Session Manager
  const createMockSession = () => ({
    startRound: () => {},
    updatePlayers: () => {},
    endRound: () => [],
    snapshotParticipants: () => [],
    roundStartTime: Date.now()
  });

  const mockOptions = {
    minParticipationRatio: 0.1,
    defaultMu: 25.0,
    defaultSigma: 8.333,
    minPlayersForElo: 5,
    ignoredGameModes: ['Seed'],
    discordClient: null
  };

  const mockConnectors = {};

  await runTest('Mount: Initialization', async () => {
    const server = createMockServer();
    const tracker = new EloTracker(server, mockOptions, mockConnectors);
    
    // Inject mocks
    tracker.db = createMockDb();
    tracker.session = createMockSession();

    await tracker.mount();

    if (!tracker.ready) throw new Error('Plugin should be ready after mount');
    if (!server.listeners['NEW_GAME']) throw new Error('NEW_GAME listener missing');
    if (!server.listeners['UPDATED_PLAYER_INFORMATION']) throw new Error('UPDATED_PLAYER_INFORMATION listener missing');
    if (!server.listeners['ROUND_ENDED']) throw new Error('ROUND_ENDED listener missing');
  });

  await runTest('Event: UPDATED_PLAYER_INFORMATION (Cache Population)', async () => {
    const server = createMockServer();
    const tracker = new EloTracker(server, mockOptions, mockConnectors);
    tracker.db = createMockDb();
    tracker.session = createMockSession();
    await tracker.mount();

    // Setup player
    const player = { eosID: 'test_eos', name: 'TestPlayer', teamID: 1 };
    server.players = [player];

    // Emit event
    await server.emit('UPDATED_PLAYER_INFORMATION');

    // Verify cache
    if (!tracker.eloCache.has('test_eos')) {
      throw new Error('Player not added to eloCache');
    }
    const cached = tracker.eloCache.get('test_eos');
    if (cached.mu !== 25.0) throw new Error(`Expected mu 25.0, got ${cached.mu}`);
  });

  await runTest('Guard: Min Players Threshold', async () => {
    const server = createMockServer();
    const tracker = new EloTracker(server, mockOptions, mockConnectors);
    const db = createMockDb();
    
    // Spy on DB methods
    let bulkCalled = false;
    db.bulkIncrementPlayerStats = async () => { bulkCalled = true; };
    
    tracker.db = db;
    tracker.session = createMockSession();
    await tracker.mount();

    // 2 players, threshold is 5
    server.players = [
      { eosID: 'p1', teamID: 1 },
      { eosID: 'p2', teamID: 2 }
    ];

    await server.emit('ROUND_ENDED', { winner: 1, tickets: 10 });

    if (bulkCalled) throw new Error('Should not save stats when below player threshold');
  });

  await runTest('Event: ROUND_ENDED (Save Stats)', async () => {
    const server = createMockServer();
    const tracker = new EloTracker(server, mockOptions, mockConnectors);
    const db = createMockDb();
    
    // Spy on DB methods
    let bulkCalled = false;
    let historyCalled = false;
    db.bulkIncrementPlayerStats = async () => { bulkCalled = true; };
    db.insertRoundHistory = async () => { historyCalled = true; };

    tracker.db = db;
    
    // Custom session mock to return participants
    const session = createMockSession();
    session.endRound = () => [
      { eosID: 'p1', name: 'P1', assignedTeamID: 1, participationRatio: 1.0 },
      { eosID: 'p2', name: 'P2', assignedTeamID: 2, participationRatio: 1.0 }
    ];
    tracker.session = session;
    
    await tracker.mount();

    // 6 players, threshold is 5
    server.players = Array(6).fill(0).map((_, i) => ({ eosID: `p${i}`, teamID: i % 2 + 1 }));
    
    // Populate cache for p1 and p2 so calculator works
    tracker.eloCache.set('p1', { mu: 25, sigma: 8.333 });
    tracker.eloCache.set('p2', { mu: 25, sigma: 8.333 });

    await server.emit('ROUND_ENDED', { winner: 1, tickets: 20 });

    if (!bulkCalled) throw new Error('Failed to call bulkIncrementPlayerStats');
    if (!historyCalled) throw new Error('Failed to call insertRoundHistory');
  });

  // --- TrueSkill2 data capture (kills / deaths / quit) ---

  const makeTrackerForTest = async () => {
    const server = createMockServer();
    const tracker = new EloTracker(server, mockOptions, mockConnectors);
    tracker.db = createMockDb();
    tracker.session = createMockSession();
    await tracker.mount();
    return { server, tracker };
  };

  await runTest('TS2 wiring: kill/death listeners registered and removed symmetrically', async () => {
    const { server, tracker } = await makeTrackerForTest();
    if (!server.listeners['PLAYER_WOUNDED']) throw new Error('PLAYER_WOUNDED listener missing after mount');
    if (!server.listeners['PLAYER_DIED']) throw new Error('PLAYER_DIED listener missing after mount');
    await tracker.unmount();
    if (server.listeners['PLAYER_WOUNDED']) throw new Error('PLAYER_WOUNDED listener not removed on unmount');
    if (server.listeners['PLAYER_DIED']) throw new Error('PLAYER_DIED listener not removed on unmount');
  });

  await runTest('TS2 options: quit gate defaults off, params frozen & neutral', async () => {
    const { tracker } = await makeTrackerForTest();
    if (tracker.options.enableQuitPenalty !== false) throw new Error('enableQuitPenalty must default to false');
    if (tracker.options.quitGraceSeconds !== 60) throw new Error('quitGraceSeconds must default to 60');
    if (tracker.options.quitParticipationThreshold !== 0.5) throw new Error('quitParticipationThreshold must default to 0.5');
    if (!tracker.params || !Object.isFrozen(tracker.params)) throw new Error('tracker.params must be a frozen parameter object');
    if (tracker.params.beta !== 25.0 / 6.0) throw new Error('tracker.params must carry engine defaults');
  });

  await runTest('Kills/Deaths: PLAYER_WOUNDED credits kills, PLAYER_DIED counts deaths', async () => {
    const { server, tracker } = await makeTrackerForTest();
    const a = { eosID: 'a', teamID: 1 };
    const b = { eosID: 'b', teamID: 2 };

    // B downs A twice, A downs B once
    await server.emit('PLAYER_WOUNDED', { victim: a, attacker: b, teamkill: false, time: 1000 });
    await server.emit('PLAYER_WOUNDED', { victim: a, attacker: b, teamkill: false, time: 2000 });
    await server.emit('PLAYER_WOUNDED', { victim: b, attacker: a, teamkill: false, time: 3000 });
    // A gives up twice, B bleeds out once
    await server.emit('PLAYER_DIED', { victim: a, attacker: b, time: 1500 });
    await server.emit('PLAYER_DIED', { victim: a, attacker: b, time: 2500 });
    await server.emit('PLAYER_DIED', { victim: b, attacker: a, time: 3500 });

    if (tracker.killsByEosID.get('a') !== 1) throw new Error(`A should have 1 kill, got ${tracker.killsByEosID.get('a')}`);
    if (tracker.killsByEosID.get('b') !== 2) throw new Error(`B should have 2 kills, got ${tracker.killsByEosID.get('b')}`);
    if (tracker.deathsByEosID.get('a') !== 2) throw new Error(`A should have 2 deaths, got ${tracker.deathsByEosID.get('a')}`);
    if (tracker.deathsByEosID.get('b') !== 1) throw new Error(`B should have 1 death, got ${tracker.deathsByEosID.get('b')}`);
  });

  await runTest('Kills/Deaths: teamkill / self-wound give no kill credit; deaths still count', async () => {
    const { server, tracker } = await makeTrackerForTest();
    const a = { eosID: 'a', teamID: 1 };
    const c = { eosID: 'c', teamID: 1 };

    // Self-wound (attacker === victim)
    await server.emit('PLAYER_WOUNDED', { victim: a, attacker: a, teamkill: false, time: 1000 });
    // Teamkill via explicit flag
    await server.emit('PLAYER_WOUNDED', { victim: c, attacker: a, teamkill: true, time: 2000 });
    // Teamkill inferable from equal teamIDs (flag missing)
    await server.emit('PLAYER_WOUNDED', { victim: c, attacker: a, time: 3000 });
    // Null attacker (environment / unclaimed)
    await server.emit('PLAYER_WOUNDED', { victim: c, attacker: null, time: 4000 });
    // Deaths always count for the victim
    await server.emit('PLAYER_DIED', { victim: a, attacker: a, time: 1500 });
    await server.emit('PLAYER_DIED', { victim: c, attacker: null, time: 4500 });

    if (tracker.killsByEosID.size !== 0) throw new Error('No kill credit expected for suicide/teamkill/null attacker');
    if (tracker.deathsByEosID.get('a') !== 1) throw new Error('Suicide death must still count');
    if (tracker.deathsByEosID.get('c') !== 1) throw new Error('Teamkill/environment victim death must still count');
  });

  await runTest('Kills/Deaths: maps cleared on NEW_GAME', async () => {
    const { server, tracker } = await makeTrackerForTest();
    await server.emit('PLAYER_WOUNDED', { victim: { eosID: 'v', teamID: 2 }, attacker: { eosID: 'k', teamID: 1 }, teamkill: false, time: 1000 });
    await server.emit('PLAYER_DIED', { victim: { eosID: 'v', teamID: 2 }, attacker: { eosID: 'k', teamID: 1 }, time: 1500 });
    tracker.lastSeenByEosID.set('v', 1500);

    await server.emit('NEW_GAME', {});

    if (tracker.killsByEosID.size !== 0) throw new Error('killsByEosID must be cleared on NEW_GAME');
    if (tracker.deathsByEosID.size !== 0) throw new Error('deathsByEosID must be cleared on NEW_GAME');
    if (tracker.lastSeenByEosID.size !== 0) throw new Error('lastSeenByEosID must be cleared on NEW_GAME');
  });

  await runTest('Quit detection: early absent leaver flagged, present player not', async () => {
    const { tracker } = await makeTrackerForTest();

    // Real session manager with controlled timestamps
    const EloSessionManager = (await import('../utils/elo-session-manager.js')).default;
    const session = new EloSessionManager();
    tracker.session = session;

    session.startRound(10000);
    session.updatePlayers([
      { eosID: 'q', name: 'Q', steamID: 'sq', teamID: 1, squadID: 1 },
      { eosID: 's', name: 'S', steamID: 'ss', teamID: 1, squadID: 1 }
    ], 10000);
    // Q leaves at 40s of a 100s round — participation 0.3 < 0.5
    session.updatePlayers([
      { eosID: 's', name: 'S', steamID: 'ss', teamID: 1, squadID: 1 }
    ], 40000);

    tracker.lastSeenByEosID.set('q', 40000);
    tracker.lastSeenByEosID.set('s', 110000);

    const quitters = tracker._detectQuittersAt(110000);
    if (!quitters.has('q')) throw new Error('Q (30% participation, absent 70s) should be detected as quitter');
    if (quitters.has('s')) throw new Error('S (full round, present at end) must NOT be a quitter');
  });

  await runTest('PerPlayerMeta: partySize by clan tag per team; no tag ⇒ solo', async () => {
    const { tracker } = await makeTrackerForTest();
    const participants = [
      { eosID: 'a', name: '[ACE] Alpha',  assignedTeamID: 1, participationRatio: 1 },
      { eosID: 'b', name: '[ACE] Bravo',  assignedTeamID: 1, participationRatio: 1 },
      { eosID: 'c', name: '[ACE] Charlie',assignedTeamID: 1, participationRatio: 0.1 }, // ineligible, still counts
      { eosID: 'd', name: '[ACE] Delta',  assignedTeamID: 2, participationRatio: 1 },   // same tag, other team
      { eosID: 'e', name: 'NoClanGuy',    assignedTeamID: 2, participationRatio: 1 }
    ];
    const eligible = participants.filter((p) => p.participationRatio >= 0.15);
    const meta = tracker._buildPerPlayerMeta(participants, eligible);

    if (meta.a.partySize !== 3) throw new Error(`a: party of 3 (incl. ineligible c) expected, got ${meta.a.partySize}`);
    if (meta.a.clanTag !== 'ACE') throw new Error(`a: clanTag ACE expected, got ${meta.a.clanTag}`);
    if (meta.d.partySize !== 1) throw new Error(`d: lone ACE on other team must not merge, got ${meta.d.partySize}`);
    if (meta.e.partySize !== 1 || meta.e.clanTag !== null) throw new Error(`e: no clan ⇒ solo/null`);
    if (meta.c) throw new Error('ineligible players get no meta entry');
  });

  await runTest('PerPlayerMeta: experience = pre-round roundsPlayed (new player ⇒ 0)', async () => {
    const { tracker } = await makeTrackerForTest();
    tracker.eloCache.set('vet', { mu: 30, sigma: 3, roundsPlayed: 42, wins: 25, losses: 17 });
    const participants = [
      { eosID: 'vet', assignedTeamID: 1, dominantSquadID: 0, participationRatio: 1 },
      { eosID: 'newbie', assignedTeamID: 2, dominantSquadID: 0, participationRatio: 1 }
    ];
    const meta = tracker._buildPerPlayerMeta(participants, participants);
    if (meta.vet.experience !== 42) throw new Error(`vet experience should be 42, got ${meta.vet.experience}`);
    if (meta.newbie.experience !== 0) throw new Error(`uncached player experience should be 0, got ${meta.newbie.experience}`);
  });

  await runTest('PerPlayerMeta: quit flag gated by enableQuitPenalty, detection always recorded', async () => {
    const participants = [
      { eosID: 'q', assignedTeamID: 1, dominantSquadID: 0, participationRatio: 0.3 },
      { eosID: 's', assignedTeamID: 1, dominantSquadID: 0, participationRatio: 1 }
    ];
    const quitters = new Set(['q']);

    // Default: gate OFF — engine-facing quit stays false, detection recorded.
    const { tracker } = await makeTrackerForTest();
    const gatedMeta = tracker._buildPerPlayerMeta(participants, participants, quitters);
    if (gatedMeta.q.quit !== false) throw new Error('enableQuitPenalty=false must keep engine-facing quit false');
    if (gatedMeta.q.quitDetected !== true) throw new Error('detected quit must still be recorded');
    if (gatedMeta.s.quitDetected !== false) throw new Error('non-quitter must not be flagged');

    // Gate ON — engine-facing quit follows detection.
    const server2 = createMockServer();
    const tracker2 = new EloTracker(server2, { ...mockOptions, enableQuitPenalty: true }, mockConnectors);
    tracker2.db = createMockDb();
    tracker2.session = createMockSession();
    await tracker2.mount();
    const openMeta = tracker2._buildPerPlayerMeta(participants, participants, quitters);
    if (openMeta.q.quit !== true) throw new Error('enableQuitPenalty=true must pass quit through to the engine');
    if (openMeta.s.quit !== false) throw new Error('non-quitter must stay quit=false');
  });

  await runTest('Persistence: TS2 fields land in match log and Elo_RoundPlayers rows', async () => {
    const server = createMockServer();
    const tracker = new EloTracker(server, { ...mockOptions, enableDatabaseLogging: true }, mockConnectors);
    const db = createMockDb();
    let capturedRows = null;
    db.insertRoundHistory = async () => ({ id: 7 });
    db.insertRoundPlayers = async (roundHistoryId, endedAt, rows) => { capturedRows = rows; };
    tracker.db = db;

    const session = createMockSession();
    session.roundStartTime = 1000;
    session.endRound = () => [
      { eosID: 'p1', name: '[XYZ] P1', steamID: 's1', assignedTeamID: 1, dominantSquadID: 3, participationRatio: 1.0 },
      { eosID: 'p2', name: '[XYZ] P2', steamID: 's2', assignedTeamID: 1, dominantSquadID: 3, participationRatio: 1.0 },
      { eosID: 'p3', name: 'P3', steamID: 's3', assignedTeamID: 2, dominantSquadID: 0, participationRatio: 1.0 }
    ];
    tracker.session = session;
    await tracker.mount();

    let capturedLog = null;
    tracker._appendMatchLog = async (record) => { capturedLog = record; };

    server.players = Array(6).fill(0).map((_, i) => ({ eosID: `x${i}`, teamID: (i % 2) + 1 }));
    tracker.eloCache.set('p1', { mu: 25, sigma: 8.333, roundsPlayed: 12, wins: 6, losses: 6 });
    tracker.eloCache.set('p2', { mu: 25, sigma: 8.333, roundsPlayed: 0, wins: 0, losses: 0 });
    tracker.eloCache.set('p3', { mu: 25, sigma: 8.333, roundsPlayed: 3, wins: 2, losses: 1 });
    tracker.killsByEosID.set('p1', 5);
    tracker.deathsByEosID.set('p1', 2);

    await server.emit('ROUND_ENDED', { winner: { team: '1', tickets: 200 }, loser: { team: '2', tickets: 50 } });

    if (!capturedLog) throw new Error('match log record not written');
    const logP1 = capturedLog.players.find((p) => p.eosID === 'p1');
    if (logP1.kills !== 5) throw new Error(`log kills expected 5, got ${logP1.kills}`);
    if (logP1.deaths !== 2) throw new Error(`log deaths expected 2, got ${logP1.deaths}`);
    if (logP1.clanTag !== 'XYZ') throw new Error(`log clanTag expected XYZ, got ${logP1.clanTag}`);
    if (logP1.partySize !== 2) throw new Error(`log partySize expected 2, got ${logP1.partySize}`);
    if (logP1.quit !== false) throw new Error(`log quit expected false, got ${logP1.quit}`);
    if (logP1.experienceBefore !== 12) throw new Error(`log experienceBefore expected 12, got ${logP1.experienceBefore}`);

    if (!capturedRows) throw new Error('insertRoundPlayers not called');
    const rowP1 = capturedRows.find((r) => r.eosID === 'p1');
    if (rowP1.kills !== 5 || rowP1.deaths !== 2 || rowP1.partySize !== 2 || rowP1.clanTag !== 'XYZ') {
      throw new Error(`DB row TS2 fields wrong: ${JSON.stringify(rowP1)}`);
    }
    if (rowP1.quit !== false || rowP1.experienceBefore !== 12) {
      throw new Error(`DB row quit/experience wrong: ${JSON.stringify(rowP1)}`);
    }
    const rowP3 = capturedRows.find((r) => r.eosID === 'p3');
    if (rowP3.kills !== 0 || rowP3.deaths !== 0) throw new Error('players without events default to 0 kills/deaths');
  });

  await runTest('Quit detection: low participation but recently seen is NOT a quit', async () => {
    const { tracker } = await makeTrackerForTest();
    const EloSessionManager = (await import('../utils/elo-session-manager.js')).default;
    const session = new EloSessionManager();
    tracker.session = session;

    session.startRound(10000);
    // Late joiner: joins at 80s of a 100s round — participation 0.2 < 0.5, but present at end
    session.updatePlayers([{ eosID: 'l', name: 'L', steamID: 'sl', teamID: 1, squadID: 1 }], 90000);
    tracker.lastSeenByEosID.set('l', 110000);

    const quitters = tracker._detectQuittersAt(110000);
    if (quitters.has('l')) throw new Error('Late joiner present at round end must NOT be flagged as quitter');
  });

  await runTest('PerPlayerMeta: partyIgnoredTags treats community tag as public', async () => {
    const server = createMockServer();
    const tracker = new EloTracker(server, { ...mockOptions, partyIgnoredTags: ['ACE'] }, mockConnectors);
    tracker.db = createMockDb();
    tracker.session = createMockSession();
    await tracker.mount();
    const participants = [
      { eosID: 'a', name: '[ACE] Alpha', assignedTeamID: 1, participationRatio: 1 },
      { eosID: 'b', name: '[ACE] Bravo', assignedTeamID: 1, participationRatio: 1 }
    ];
    const meta = tracker._buildPerPlayerMeta(participants, participants);
    if (meta.a.partySize !== 1 || meta.a.clanTag !== null) {
      throw new Error(`ignored tag must make members public, got ${JSON.stringify(meta.a)}`);
    }
  });
}