import EloCalculator from '../utils/elo-calculator.js';

export default async function runCalculatorTests(runTest) {
  await runTest('Baseline Math: Constants', async () => {
    if (EloCalculator.MU_DEFAULT !== 25.0) {
      throw new Error(`MU_DEFAULT is ${EloCalculator.MU_DEFAULT}, expected 25.0`);
    }
    // 25/3 is approx 8.33333...
    if (Math.abs(EloCalculator.SIGMA_DEFAULT - (25.0 / 3.0)) > 0.0001) {
      throw new Error(`SIGMA_DEFAULT is ${EloCalculator.SIGMA_DEFAULT}, expected ~8.333`);
    }
  });

  await runTest('Win Scenario: 1v1 Default', async () => {
    const team1 = [EloCalculator.getDefaultRating()];
    const team2 = [EloCalculator.getDefaultRating()];

    const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(team1, team2, 'team1win');

    const t1Delta = team1Updates[0].deltaMu;
    const t2Delta = team2Updates[0].deltaMu;

    if (t1Delta <= 0) throw new Error(`Winner (Team 1) should gain rating. Delta: ${t1Delta}`);
    if (t2Delta >= 0) throw new Error(`Loser (Team 2) should lose rating. Delta: ${t2Delta}`);
  });

  await runTest('Upset Logic: High vs Low', async () => {
    // Standard match (25 vs 25)
    const stdT1 = [EloCalculator.getDefaultRating()];
    const stdT2 = [EloCalculator.getDefaultRating()];
    const stdRes = EloCalculator.computeTeamUpdate(stdT1, stdT2, 'team1win');
    const stdGain = stdRes.team1Updates[0].deltaMu;

    // Upset match (15 vs 35) - Team 1 (Low) wins
    const lowPlayer = { mu: 15.0, sigma: EloCalculator.SIGMA_DEFAULT };
    const highPlayer = { mu: 35.0, sigma: EloCalculator.SIGMA_DEFAULT };
    
    const upsetRes = EloCalculator.computeTeamUpdate([lowPlayer], [highPlayer], 'team1win');
    const upsetGain = upsetRes.team1Updates[0].deltaMu;

    if (upsetGain <= stdGain) {
      throw new Error(`Upset win gain (${upsetGain}) should be greater than standard win gain (${stdGain})`);
    }
  });

  await runTest('Uncertainty Decay: Sigma decreases', async () => {
    const team1 = [EloCalculator.getDefaultRating()];
    const team2 = [EloCalculator.getDefaultRating()];

    const { team1Updates, team2Updates } = EloCalculator.computeTeamUpdate(team1, team2, 'team1win');

    // deltaSigma = old - new. Positive means decrease (more confidence).
    const t1DeltaSig = team1Updates[0].deltaSigma;
    const t2DeltaSig = team2Updates[0].deltaSigma;

    if (t1DeltaSig <= 0) throw new Error(`Winner sigma did not decrease. Delta: ${t1DeltaSig}`);
    if (t2DeltaSig <= 0) throw new Error(`Loser sigma did not decrease. Delta: ${t2DeltaSig}`);
  });

  // --- Margin of victory ---
  const evenTeams = () => Array.from({ length: 10 }, () => EloCalculator.getDefaultRating());
  const NEUTRAL = EloCalculator.MARGIN_NEUTRAL_TICKETS;

  await runTest('Margin of Victory: squeaker < typical < blowout', async () => {
    const gain = (ticketDiff) =>
      EloCalculator.computeTeamUpdate(evenTeams(), evenTeams(), 'team1win', ticketDiff).team1Updates[0].deltaMu;

    const squeaker = gain(0);
    const typical  = gain(NEUTRAL);
    const blowout  = gain(NEUTRAL * 2);

    if (!(squeaker < typical && typical < blowout)) {
      throw new Error(`Expected strictly increasing deltaMu, got squeaker=${squeaker}, typical=${typical}, blowout=${blowout}`);
    }
  });

  await runTest('Margin of Victory: neutral ticketDiff reproduces the pre-margin result', async () => {
    const withMargin = EloCalculator.computeTeamUpdate(evenTeams(), evenTeams(), 'team1win', NEUTRAL).team1Updates[0].deltaMu;
    const legacy     = EloCalculator.computeTeamUpdate(evenTeams(), evenTeams(), 'team1win').team1Updates[0].deltaMu;

    if (Math.abs(withMargin - legacy) > 1e-12) {
      throw new Error(`A neutral margin must not change anything. With: ${withMargin}, without: ${legacy}`);
    }
  });

  await runTest('Margin of Victory: scales both teams by the same factor', async () => {
    // NOT a zero-sum test — deltaMu is (sigma_i^2 / c) * v, so the team sums only match
    // when total variance does. What must hold is that the margin rescales winner and
    // loser identically, i.e. it shifts no rating from one side to the other.
    const ratios = (ticketDiff) => {
      const base = EloCalculator.computeTeamUpdate(evenTeams(), evenTeams(), 'team1win', NEUTRAL);
      const shifted = EloCalculator.computeTeamUpdate(evenTeams(), evenTeams(), 'team1win', ticketDiff);
      return [
        shifted.team1Updates[0].deltaMu / base.team1Updates[0].deltaMu,
        shifted.team2Updates[0].deltaMu / base.team2Updates[0].deltaMu
      ];
    };

    for (const ticketDiff of [0, NEUTRAL * 2]) {
      const [winner, loser] = ratios(ticketDiff);
      if (Math.abs(winner - loser) > 1e-12) {
        throw new Error(`ticketDiff=${ticketDiff}: winner scaled by ${winner} but loser by ${loser}`);
      }
    }
  });

  await runTest('Margin of Victory: draws ignore ticketDiff', async () => {
    const a = EloCalculator.computeTeamUpdate(evenTeams(), evenTeams(), 'draw', 0).team1Updates[0];
    const b = EloCalculator.computeTeamUpdate(evenTeams(), evenTeams(), 'draw', NEUTRAL * 2).team1Updates[0];

    if (Math.abs(a.deltaMu - b.deltaMu) > 1e-12 || Math.abs(a.deltaSigma - b.deltaSigma) > 1e-12) {
      throw new Error(`Draw updates must not depend on ticketDiff. Got ${a.deltaMu}/${a.deltaSigma} vs ${b.deltaMu}/${b.deltaSigma}`);
    }
  });

  await runTest('Margin of Victory: MARGIN_WEIGHT = 0 disables the feature', async () => {
    const original = EloCalculator.MARGIN_WEIGHT;
    try {
      EloCalculator.MARGIN_WEIGHT = 0;
      const squeaker = EloCalculator.computeTeamUpdate(evenTeams(), evenTeams(), 'team1win', 0).team1Updates[0].deltaMu;
      const blowout  = EloCalculator.computeTeamUpdate(evenTeams(), evenTeams(), 'team1win', NEUTRAL * 2).team1Updates[0].deltaMu;

      if (Math.abs(squeaker - blowout) > 1e-12) {
        throw new Error(`MARGIN_WEIGHT=0 must be a full opt-out. Got ${squeaker} vs ${blowout}`);
      }
    } finally {
      EloCalculator.MARGIN_WEIGHT = original;
    }
  });
}