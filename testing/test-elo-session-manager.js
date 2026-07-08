import EloSessionManager from '../utils/elo-session-manager.js';

// Mock Date.now() to control time
let mockNow;
const originalDateNow = Date.now;
Date.now = () => mockNow;

const MINUTE = 60 * 1000;

export default async function runSessionTests(runTest) {
  const cleanup = () => {
    Date.now = originalDateNow;
  };

  try {
    await runTest('Simple Participation: Full round', async () => {
      const session = new EloSessionManager();
      const roundStart = 1000;
      mockNow = roundStart;

      session.startRound(mockNow);

      const player1 = { eosID: 'p1', name: 'PlayerOne', steamID: 's1', teamID: 1 };

      mockNow += 1; // small increment for join time
      session.updatePlayers([player1]);

      const roundEnd = roundStart + 60 * MINUTE;
      const participants = session.endRound(roundEnd);

      if (participants.length !== 1) throw new Error(`Expected 1 participant, got ${participants.length}`);

      const p1Data = participants[0];
      if (p1Data.eosID !== 'p1') throw new Error('Wrong participant data');
      if (Math.abs(p1Data.participationRatio - 1.0) > 0.0001) {
        throw new Error(`Expected participationRatio near 1.0, got ${p1Data.participationRatio}`);
      }
      if (p1Data.assignedTeamID !== 1) throw new Error(`Expected assignedTeamID 1, got ${p1Data.assignedTeamID}`);
    });

    await runTest('Mid-Round Join: Half round', async () => {
      const session = new EloSessionManager();
      const roundStart = 2000;
      mockNow = roundStart;

      session.startRound(mockNow);

      const player1 = { eosID: 'p1', name: 'PlayerOne', steamID: 's1', teamID: 1 };

      mockNow = roundStart + 30 * MINUTE;
      session.updatePlayers([player1]);

      const roundEnd = roundStart + 60 * MINUTE;
      const participants = session.endRound(roundEnd);

      if (participants.length !== 1) throw new Error(`Expected 1 participant, got ${participants.length}`);

      const p1Data = participants[0];
      const expectedRatio = 0.5;
      if (Math.abs(p1Data.participationRatio - expectedRatio) > 0.001) {
        throw new Error(`Expected participationRatio near ${expectedRatio}, got ${p1Data.participationRatio}`);
      }
    });

    await runTest('Team Switcher: 75% on Team 1', async () => {
      const session = new EloSessionManager();
      const roundStart = 3000;
      mockNow = roundStart;

      session.startRound(mockNow);

      const player1 = { eosID: 'p1', name: 'PlayerOne', steamID: 's1', teamID: 1 };

      mockNow += 1; // Joined at start
      session.updatePlayers([player1]);

      mockNow = roundStart + 45 * MINUTE; // Switch teams at 45 mins
      const player1Switched = { ...player1, teamID: 2 };
      session.updatePlayers([player1Switched]);

      const roundEnd = roundStart + 60 * MINUTE;
      const participants = session.endRound(roundEnd);

      if (participants.length !== 1) throw new Error(`Expected 1 participant, got ${participants.length}`);

      const p1Data = participants[0];
      const expectedRatio = 0.75;
      if (p1Data.assignedTeamID !== 1) throw new Error(`Expected assignedTeamID 1, got ${p1Data.assignedTeamID}`);
      if (Math.abs(p1Data.participationRatio - expectedRatio) > 0.001) {
        throw new Error(`Expected participationRatio near ${expectedRatio}, got ${p1Data.participationRatio}`);
      }
      if (p1Data.segments.length !== 2) throw new Error(`Expected 2 segments for team switcher, got ${p1Data.segments.length}`);
    });

    await runTest('Ghosting/Disconnects: Segment closes correctly', async () => {
      const session = new EloSessionManager();
      const roundStart = 4000;
      mockNow = roundStart;

      session.startRound(mockNow);

      const player1 = { eosID: 'p1', name: 'PlayerOne', steamID: 's1', teamID: 1 };
      const player2 = { eosID: 'p2', name: 'PlayerTwo', steamID: 's2', teamID: 2 };

      mockNow += 1; // Both join at start
      session.updatePlayers([player1, player2]);

      mockNow = roundStart + 30 * MINUTE; // p1 disconnects at 30 mins
      session.updatePlayers([player2]); // p1 is not in the list

      const p1Session = session.getPlayerSession('p1');
      if (!p1Session) throw new Error('Player 1 session disappeared after disconnect');
      if (p1Session.activeSegment !== null) {
        throw new Error('Player 1 activeSegment was not set to null after disconnect');
      }

      const roundEnd = roundStart + 60 * MINUTE;
      const participants = session.endRound(roundEnd);

      const p1Data = participants.find((p) => p.eosID === 'p1');
      if (!p1Data) throw new Error('Player 1 data not found in participants');

      if (Math.abs(p1Data.participationRatio - 0.5) > 0.0001) {
        throw new Error(`Expected participationRatio near 0.5 for disconnected player, got ${p1Data.participationRatio}`);
      }
    });

    await runTest('SquadID: tracked per segment, squad change rolls segment', async () => {
      const session = new EloSessionManager();
      mockNow = 1000;
      session.startRound(mockNow);

      session.updatePlayers([{ eosID: 'p1', name: 'P1', steamID: 's1', teamID: 1, squadID: 3 }], 1000);
      session.updatePlayers([{ eosID: 'p1', name: 'P1', steamID: 's1', teamID: 1, squadID: 5 }], 61000);

      const participants = session.endRound(121000);
      const p1 = participants.find((x) => x.eosID === 'p1');
      if (!p1.segments || p1.segments.length < 2) {
        throw new Error(`Expected >=2 segments after squad change, got ${p1.segments?.length}`);
      }
      if (p1.segments[0].squadID !== 3) throw new Error(`First segment must record squadID 3, got ${p1.segments[0].squadID}`);
      if (p1.segments[1].squadID !== 5) throw new Error(`Second segment must record squadID 5, got ${p1.segments[1].squadID}`);
      if (p1.dominantSquadID !== 3 && p1.dominantSquadID !== 5) {
        throw new Error(`dominantSquadID must be 3 or 5, got ${p1.dominantSquadID}`);
      }
    });

    await runTest('SquadID: dominantSquadID picks squad with most time', async () => {
      const session = new EloSessionManager();
      mockNow = 10000;
      session.startRound(10000);

      session.updatePlayers([{ eosID: 'p1', name: 'P1', steamID: 's1', teamID: 1, squadID: 3 }], 10000);
      session.updatePlayers([{ eosID: 'p1', name: 'P1', steamID: 's1', teamID: 1, squadID: 5 }], 40000);

      // Total round 100s: 30s in squad 3, 70s in squad 5
      const participants = session.endRound(110000);
      const p1 = participants.find((x) => x.eosID === 'p1');
      if (p1.dominantSquadID !== 5) {
        throw new Error(`dominantSquadID should be the squad with more time (5), got ${p1.dominantSquadID}`);
      }
    });

    await runTest('SquadID: null squadID normalizes to 0, no spurious segments', async () => {
      const session = new EloSessionManager();
      mockNow = 10000;
      session.startRound(10000);

      session.updatePlayers([{ eosID: 'p1', name: 'P1', steamID: 's1', teamID: 1, squadID: null }], 10000);
      // Same state again (squadID undefined this time) must NOT roll a new segment
      session.updatePlayers([{ eosID: 'p1', name: 'P1', steamID: 's1', teamID: 1 }], 30000);
      session.updatePlayers([{ eosID: 'p1', name: 'P1', steamID: 's1', teamID: 1, squadID: null }], 50000);

      const participants = session.endRound(70000);
      const p1 = participants.find((x) => x.eosID === 'p1');
      if (p1.dominantSquadID !== 0) {
        throw new Error(`null squadID should become 0 (unassigned), got ${p1.dominantSquadID}`);
      }
      if (p1.segments.length !== 1) {
        throw new Error(`Unchanged null/undefined squadID must not roll segments, got ${p1.segments.length}`);
      }
    });

    await runTest('SquadID: null-teamID transient resolves without losing squad tracking', async () => {
      const session = new EloSessionManager();
      mockNow = 10000;
      session.startRound(10000);

      // NEW_GAME transient: teamID null at first, resolves to team 2 / squad 4 at 30s
      session.updatePlayers([{ eosID: 'p1', name: 'P1', steamID: 's1', teamID: null, squadID: null }], 10000);
      session.updatePlayers([{ eosID: 'p1', name: 'P1', steamID: 's1', teamID: 2, squadID: 4 }], 40000);

      const participants = session.endRound(130000);
      const p1 = participants.find((x) => x.eosID === 'p1');
      if (!p1) throw new Error('Participant missing after null-teamID resolution');
      if (p1.assignedTeamID !== 2) throw new Error(`Expected assignedTeamID 2, got ${p1.assignedTeamID}`);
      if (p1.dominantSquadID !== 4) throw new Error(`Expected dominantSquadID 4, got ${p1.dominantSquadID}`);
      if (Math.abs(p1.participationRatio - 0.75) > 0.001) {
        throw new Error(`Expected ratio 0.75 (90s of 120s), got ${p1.participationRatio}`);
      }
    });

    await runTest('snapshotParticipants: non-destructive read mid-round', async () => {
      const session = new EloSessionManager();
      mockNow = 10000;
      session.startRound(10000);

      session.updatePlayers([
        { eosID: 'p1', name: 'P1', steamID: 's1', teamID: 1, squadID: 2 },
        { eosID: 'p2', name: 'P2', steamID: 's2', teamID: 2, squadID: 1 }
      ], 10000);
      // p2 disconnects at 30s
      session.updatePlayers([{ eosID: 'p1', name: 'P1', steamID: 's1', teamID: 1, squadID: 2 }], 40000);

      const snap = session.snapshotParticipants(70000);
      const s1 = snap.find((x) => x.eosID === 'p1');
      const s2 = snap.find((x) => x.eosID === 'p2');
      if (!s1 || !s2) throw new Error('snapshot must include both players');
      if (Math.abs(s1.participationRatio - 1.0) > 0.001) throw new Error(`p1 snapshot ratio should be ~1.0, got ${s1.participationRatio}`);
      if (Math.abs(s2.participationRatio - 0.5) > 0.001) throw new Error(`p2 snapshot ratio should be ~0.5, got ${s2.participationRatio}`);
      if (s1.assignedTeamID !== 1 || s1.dominantSquadID !== 2) throw new Error('snapshot must carry assignedTeamID/dominantSquadID');

      // The snapshot must NOT have closed p1's live segment...
      const live = session.getPlayerSession('p1');
      if (!live.activeSegment || live.activeSegment.leaveTime !== null) {
        throw new Error('snapshotParticipants mutated the active segment');
      }

      // ...so a later endRound still counts the full duration.
      const participants = session.endRound(130000);
      const p1 = participants.find((x) => x.eosID === 'p1');
      if (Math.abs(p1.participationRatio - 1.0) > 0.001) {
        throw new Error(`endRound after snapshot must still yield ~1.0, got ${p1.participationRatio}`);
      }
    });
  } finally {
    cleanup();
  }
}