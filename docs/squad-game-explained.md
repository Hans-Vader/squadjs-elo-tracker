# The game *Squad* — a primer for judging the TrueSkill2 implementation

> **Why this file exists.** The other docs explain the *math* (`trueskill2-explained.md`)
> and the *plugin* (`rating-engine-guide.md`). Neither explains the *game*. TrueSkill2 was
> fitted on **Halo 5** — 4–8 players a side, ~5-minute rounds, kills are the whole point.
> **Squad is almost the opposite game.** Before trusting (or calibrating) any factor you need
> to know how far each of the paper's assumptions is stretched by Squad's reality. This
> document is that reality check. Every claim about how the engine reads the game is grounded
> in `plugins/elo-tracker.js` and `SQUADJS_PLUGIN_DEV_REFERENCE.md`.
>
> Read section [9](#9-squad-reality--trueskill2-factor--caveat) first if you only read one thing.

## Table of contents

1. [What Squad is, in one paragraph](#1-what-squad-is-in-one-paragraph)
2. [A match: layers, tickets, win conditions](#2-a-match-layers-tickets-win-conditions)
3. [Teams, squads, commander, roles](#3-teams-squads-commander-roles)
4. [Why the team result is a team property](#4-why-the-team-result-is-a-team-property)
5. [How players move through a round](#5-how-players-move-through-a-round)
6. [Kills and deaths in Squad ≠ kills and deaths in Halo](#6-kills-and-deaths-in-squad--kills-and-deaths-in-halo)
7. [Clans and clan tags (a community convention, not a game feature)](#7-clans-and-clan-tags-a-community-convention-not-a-game-feature)
8. [What SquadJS can and cannot observe](#8-what-squadjs-can-and-cannot-observe)
9. [Squad reality → TrueSkill2 factor → caveat](#9-squad-reality--trueskill2-factor--caveat)
10. [Glossary](#10-glossary)

---

## 1. What Squad is, in one paragraph

**Squad** (Offworld Industries, full release 2020) is a large-scale, combined-arms,
milsim-*lite* first-person shooter. A match is **two teams of up to 50 players each — up to
100 on a full server** — fighting over territory with infantry, ground vehicles, armour and
helicopters. It rewards coordination, logistics and communication far more than individual
aim: a well-run team of average shooters routinely beats a disorganised team of good ones.
There is **no skill-based matchmaking**; players join public servers and pick their own team.
Rounds are long (commonly **30–60+ minutes**) and almost always produce a clear winner.

Keep three numbers in mind, because they are what break the Halo-fitted assumptions:
**up to 50 per team**, **30–60 min per round**, **kills are optional to winning**.

---

## 2. A match: layers, tickets, win conditions

**Layer.** A single playable round is a *layer* = **map + game mode + faction matchup**
(e.g. `Gorodok RAAS v1`, `Narva Invasion v2`). The plugin resolves the layer on `NEW_GAME`
and refuses to score a round whose layer it can't identify (see `resolveLayerInfo` /
`inferGameMode`).

**Game modes.** These matter because the plugin filters on them (`ignoredGameModes`) and
because the *shape* of a win differs by mode:

| Mode | What it is | Relevance to rating |
|---|---|---|
| **RAAS** (Random Advance & Secure) | The dominant competitive mode. Capture-point chain, but the point locations are randomised. | The normal case. Real win/loss. |
| **AAS** | Like RAAS but fixed points. | Same. |
| **Invasion** | Asymmetric: one team attacks a sequence of objectives, the other defends. | Win is meaningful but the sides are *not* symmetric — attacker/defender roles differ. |
| **Insurgency / Destruction / Territory Control / Skirmish** | Other objective variants (caches, weapon destruction, tug-of-war, small infantry). | Real rounds, less common. Skirmish is small-scale and often below `minPlayersForElo`. |
| **Seed** | Low-population "seeding" rounds to fill a server; not real competition. | **Ignored by default** (`ignoredGameModes: ["Seed", ...]`). |
| **Jensen's Range / Training / Tutorial** | Shooting range, no enemy, no outcome. | **Ignored by default** (`"Jensen"`). |

**Tickets.** Each team starts with a pool of *tickets*. A team loses tickets when:
its players **die** (a death that is **not** revived costs ~1 ticket), it **loses vehicles**,
it **loses capture points**, and it suffers **ticket bleed** while it holds fewer objectives
than the enemy. A team **wins** by driving the enemy ticket pool to **0**, or by capturing the
final objective (RAAS/AAS/Invasion). The plugin reads the outcome as `team1win` / `team2win` /
`draw` plus a **ticket difference**.

**Blowouts are common and legitimate.** A final ticket margin can be anything from a nail-biting
`+15` to a `+700` steamroll. A steamroll is a *real* signal that one team was much stronger —
but it is also frequently the result of one team collapsing (mass quit, no commander, lost
armour early), not a smooth reflection of per-player skill. Treat the ticket margin as a noisy
strength signal, not a linear one.

**Draws are rare.** Squad almost always resolves to a winner; draws happen mostly on admin
round-ends or server issues. This is why `drawProbability` defaults to a tiny `0.01`.

---

## 3. Teams, squads, commander, roles

This is the section most likely to be misread, because the word "squad" means **three different
things** across this codebase — see the [glossary](#10-glossary). In the *game*:

- **Team** — one of the two sides, up to 50 players, playing a specific **faction** (US Army,
  Russian Ground Forces, British, PLA, MEA, Militia, Insurgents, …). Faction changes the
  equipment, not the rating.
- **Squad (in-game)** — a sub-group of **up to 9 players** inside a team, created and led by a
  **Squad Leader (SL)**. This is the game's real teamwork unit: SLs place spawn points (rally
  points), coordinate with the commander, and drive the meta. **But in-game squads are volatile:**
  players hop between squads, squads are created and disbanded mid-round, names are reused, and
  SquadJS's view of them (`PLAYER_SQUAD_CHANGE`) is an RCON poll that lags reality. **This is
  precisely why the party factor does *not* use in-game squads** — see §7 and §9.
- **Commander** — one player per team commands the whole side, calling in assets (artillery,
  UAV, strafing runs). High impact on the outcome, usually low personal kill count.
- **Kits / roles** — every player picks a kit: Rifleman, Medic, Squad Leader, Automatic
  Rifleman, Machine Gunner, Grenadier, Marksman, Light/Heavy Anti-Tank, Combat Engineer,
  **Crewman** (armour), **Pilot** (helicopters). Kill output is wildly uneven across kits: a
  marksman or MG farms kills; a medic, logi driver, SL or engineer can decide the round while
  barely appearing on the kill feed. The engine sees only the kill/death counts, not the kit.

---

## 4. Why the team result is a team property

The single most important thing to internalise before reading kills into skill: **in Squad,
winning is overwhelmingly a team-level phenomenon.** The levers that decide rounds are:

- **Logistics** — trucks hauling build/ammo points to construct **FOBs** (forward bases with
  spawn points). No logi → no forward spawns → the team loses regardless of aim.
- **Spawn management** — SLs placing rallies and HABs in good positions.
- **Armour and air** — a single well-crewed tank or attack heli can swing a round; a lost one
  can lose it.
- **Command coordination** — focusing force on the right objective at the right time.

An individual's shooting skill is real but *second-order*. This is the whole justification for
TrueSkill's design — **skill is inferred from winning first, and individual stats are only a
secondary correction** (see `trueskill2-explained.md` §3.3). On Squad that ordering matters even
more than on Halo, because the correlation between "most kills" and "won the round" is weaker.

---

## 5. How players move through a round

Squad rounds are long and porous, which is why **participation weighting** exists:

- **Mid-round joins / early leaves.** People join a 45-minute round at minute 30 and leave at
  minute 10. The plugin tracks time-on-team in segments and scales each player's rating delta by
  their **participation ratio**; players below `minParticipationRatio` (0.15) are dropped from
  scoring entirely.
- **Team switching.** Players can switch sides mid-round (subject to team-balance limits). The
  session tracker assigns a player to the team they spent the **majority** of the round on.
- **Seeding → live transition.** A server fills during low-pop "seeding" (ignored mode) and
  flips to real modes once populated. `minPlayersForElo` (default **80**) gates scoring to
  reasonably full servers — Squad's balance assumptions only hold near full population.
- **No matchmaking, admin-driven balance.** Teams are self-selected. Clans stack one side;
  admins and balance plugins (e.g. TeamBalancer) **scramble** teams to compensate. So at round
  start the two teams are *not* skill-balanced by any system TrueSkill controls — the rating
  must survive being fed lopsided, human-arranged teams.

---

## 6. Kills and deaths in Squad ≠ kills and deaths in Halo

The kill/death factor (eq. 9) is the one most likely to mislead if you carry Halo intuitions.
In Squad:

- **A "kill" is an incapacitation, not a body.** When a player's health hits 0 they go
  **wounded/downed** and `PLAYER_WOUNDED` fires with the attacker credited — **this is what the
  plugin counts as a kill.** The downed player can be **revived** by a medic (or any kit with a
  bandage) before they bleed out or give up.
- **A "death" is a give-up / bleed-out.** `PLAYER_DIED` fires only when the player actually dies.
  **A revive negates a death** (the plugin's death counter reflects `PLAYER_DIED`, and a revived
  down never reaches that event). So a player can be downed five times, revived each time, and
  have five "kills" credited against them but zero deaths — and cost their team zero tickets.
- **Friendly fire is on.** Teamkills are routine (misidentification, explosives, vehicles). The
  plugin skips team-kills and self-wounds when crediting kills, but teamkills still muddy any
  naive read of the kill feed.
- **Kills are role- and asset-dependent.** A tank crewman or MG farms kills; a logi driver,
  medic, or commander wins rounds with almost none. Per-minute K/D is therefore a **noisy,
  role-biased** skill signal in Squad — much noisier than in an arena shooter.

**Consequence for the model:** the kill/death factor is legitimate but weak and easily
misinterpreted. That is exactly why the calibrator **deliberately does not sweep**
`killParams`/`deathParams`, and why they ship at `wPlayer = 0` (identically-zero message). Enable
them only with strong, Squad-specific evidence.

---

## 7. Clans and clan tags (a community convention, not a game feature)

Squad has **no built-in clan system.** "Clans" are communities that agree to prefix their
in-game names with a tag — `[TAG]Name`, `=TAG= Name`, `TAG | Name`, etc. The game neither
enforces nor knows about this; it is pure text in the player name.

This is why the **party factor (eq. 7) groups by clan tag, not by in-game squad.** The reasoning:

- **In-game squads are unobservable-in-practice and unstable** (§3): reshuffled, renamed,
  poll-lagged. You cannot reliably reconstruct "who actually coordinated" from them.
- **Clan tags are stable and observable**: a clan that queues together to stomp pubs is exactly
  the "party that performs better than the sum of its members" the paper's eq. 7 corrects for,
  and their shared tag is right there in the name.

Because tags are free-text, detection is **heuristic and tunable**: `partyCaseSensitive`,
`partyMaxEditDistance` (Levenshtein merge of near-identical tags; default 0 = exact-only,
since homoglyph/case variants already merge via normalization — raising it risks fusing
genuinely different clans into one phantom party), and `partyIgnoredTags` (community/meme
tags that aren't real coordinated clans). Bare prefixes without a visible boundary (`KM Lookout`) only count when a
teammate carries the same tag explicitly (`[KM] Warlord`) — so ordinary two-word names
(`The Rock` + `The Bull`) never form a party. **Audit with
`tools/elo-clans-audit.js` before trusting the grouping** — a mis-grouped party feeds the wrong
offset into every round it appears in.

---

## 8. What SquadJS can and cannot observe

The engine can only be as good as its inputs. From `SQUADJS_PLUGIN_DEV_REFERENCE.md`:

| Signal | Source | Reliability |
|---|---|---|
| Who is on the server / which team | `UPDATED_PLAYER_INFORMATION`, ~30 s RCON poll | **Authoritative** — the one signal to trust |
| Round outcome + ticket difference | `ROUND_ENDED` | Reliable |
| Layer / game mode | `NEW_GAME` + resolver | Reliable (unknown layer → round skipped) |
| Kills | `PLAYER_WOUNDED` (downs) | Reliable, but see §6 |
| Deaths | `PLAYER_DIED` | Reliable, revives already netted out |
| **Player disconnect** | `PLAYER_DISCONNECTED` | **Broken — never fires.** |

That last row is the load-bearing caveat for the **quit factor**. Because there is no disconnect
event, "quit" is *inferred*: a player who is absent from the ~30 s poll past `quitGraceSeconds`
(60 s) **and** below `quitParticipationThreshold` (0.5) is flagged. **A crash, an internet drop,
an alt-tab, or a normal early leave is indistinguishable from a rage-quit** at this resolution.
That is why the quit penalty is **off by default and double-gated**, and why its default margin
(~−4.7 μ per quit) is described as *larger than a typical round swing* — a false positive is
expensive. Seeding→live transitions and layer changes also churn the player list in ways that
can look like mass quits.

---

## 9. Squad reality → TrueSkill2 factor → caveat

The payoff table. For each factor, what Squad's reality does to the paper's assumption, and how
to weight it when assessing or calibrating.

| Paper assumption (Halo) | Squad reality | Factor / setting | How to read it |
|---|---|---|---|
| 2 symmetric teams | Almost always 2 teams; **Invasion is asymmetric** (attack vs defend) | core win/loss | The closed-form 2-team update fits. Just know Invasion sides aren't symmetric. |
| 4–8 players/side | **Up to 50/side**, ~5–10× larger | `beta`, whole scale | Team-mean noise, per-player influence and the right `beta` are all different from Halo. **Paper numbers do not transfer — calibrate.** |
| Short (~5 min) rounds, everyone present start-to-end | **30–60+ min**, porous join/leave/switch | participation ratio, `minParticipationRatio` | Participation weighting is essential, not cosmetic. A "win" credits people who were there for it. |
| "Party" = friends who queued together (known) | No party system; **in-game squads are volatile/unobservable** | **party offset (eq. 7)** grouped by **clan tag** | Grouping is a name-parsing heuristic. Audit it. A wrong group poisons every round it's in. |
| New players ramp fast | Same effect, plus Squad's steep logistics/role learning curve | **experience offset (eq. 8)** | Plausible for Squad; a gentle positive drift for newcomers. Off until calibrated. |
| Kills ≈ individual performance | **Kills are role-/asset-biased, downs≠deaths, revives net out, TKs exist** | **kill/death (eq. 9)** | Weak, noisy signal here. Calibrator **won't sweep it**; ships neutral. Enable only with strong local evidence. |
| Quit = deliberate early leave, detectable | **No disconnect event**; quit is inferred at ~30 s granularity; crash looks identical | **quit penalty (§9)** + `enableQuitPenalty`, grace/threshold | Off + double-gated by design. Large penalty, high false-positive risk. Calibrate `mQ` before enabling. |
| Separate game modes with correlated skill | Squad modes barely differ mechanically | **mode correlation** | **Deliberately not implemented.** Correct call for Squad. |
| Teams balanced by matchmaking | **No SBMM**; self-selected teams; admin/plugin **scrambles** | (context) | The rating must digest deliberately lopsided teams and post-scramble reshuffles. Explains blowouts and the TeamBalancer integration. |
| Every match is competitive | Seeding, training, low-pop rounds are not | `ignoredGameModes`, `minPlayersForElo` | These gates keep non-competitive rounds out of the ratings. Don't loosen them casually. |

**Bottom line for assessment.** The core win/loss engine and participation weighting map cleanly
onto Squad. The party factor's *design* (clan tags over in-game squads) is the right adaptation,
but its *inputs* are heuristic — audit them. The kill/death and quit factors sit on the shakiest
Squad-specific ground (noisy kills, un-observable quits), which is exactly why the codebase ships
them neutral, off, and (for kill/death) excluded from the sweep. When calibrating, trust the
data over the Halo paper every time.

---

## 10. Glossary

**"Squad" — disambiguation.** Three meanings collide in this repo:
1. **The game** *Squad* (this document).
2. **An in-game squad** — up to 9 players under a Squad Leader. **Not** used by the rating engine.
3. **A TrueSkill "party"** — the paper's group-of-friends effect, which this repo implements via
   **clan tags** (§7). Older docs/code sometimes still say "squad offset"; the current key is
   `partyOffsets` and the concept is clan-tag co-membership.

| Term | Meaning |
|---|---|
| **Layer** | One playable round = map + game mode + faction matchup. |
| **Faction** | The army a team plays (US, RGF, British, PLA, MEA, Militia, Insurgents, …). Cosmetic to rating. |
| **RAAS / AAS** | The main capture-the-points modes (RAAS = randomised point chain). |
| **Invasion** | Asymmetric attack/defend mode. |
| **Ticket** | A team's respawn/score pool; hitting 0 loses the round. Lost via un-revived deaths, vehicle losses, lost points, bleed. |
| **Ticket bleed** | Passive ticket loss while holding fewer objectives than the enemy. |
| **Squad Leader (SL)** | Leads an in-game squad, places rally points, coordinates. High impact, often low kills. |
| **Commander** | One per team; calls in team-wide assets. |
| **FOB / HAB** | Forward Operating Base / its spawn structure — built from logistics points. |
| **Rally point** | Temporary squad spawn placed by the SL. |
| **Kit** | The role/loadout a player selects (Medic, Crewman, LAT, …). Determines kill exposure. |
| **Wounded / down** | Incapacitated at 0 HP; revivable. Fires `PLAYER_WOUNDED` (counted as a kill for the attacker). |
| **Revive** | A medic/bandage restoring a downed player before death — negates the death and the ticket loss. |
| **Seeding** | Low-population play to fill a server; a non-competitive mode, ignored by the plugin. |
| **Clan tag** | A community-chosen text prefix in a player's name; the basis for party detection. Not a game feature. |
| **Scramble** | Admin/plugin reshuffle of teams to rebalance; TrueSkill must digest the result. |
| **RCON poll** | The ~30 s server query behind `UPDATED_PLAYER_INFORMATION`, the only authoritative state signal. |

---

*Companion docs: `docs/trueskill2-explained.md` (the math), `docs/rating-engine-guide.md`
(the plugin & calibration), `SQUADJS_PLUGIN_DEV_REFERENCE.md` (event reliability).*
