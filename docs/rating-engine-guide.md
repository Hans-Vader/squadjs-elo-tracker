# Rating engine — how it works & how to calibrate it

> Operator + calibration guide for the **EloTracker** SquadJS plugin (`plugins/elo-tracker.js`, v1.3.0). Everything below is grounded in the actual code — every option name, default, file path, and CLI flag is exact. Do not invent options that are not listed here.

## Table of contents

1. [Overview](#1-overview)
2. [How a rating update happens](#2-how-a-rating-update-happens)
3. [The rating number & uncertainty](#3-the-rating-number--uncertainty)
4. [The four TrueSkill2 factors](#4-the-four-trueskill2-factors)
5. [Configuration reference](#5-configuration-reference)
6. [Calibration](#6-calibration)
7. [Rebuild / replay](#7-rebuild--replay)
8. [Recommended end-to-end workflow](#8-recommended-end-to-end-workflow)
9. [Troubleshooting / gotchas](#9-troubleshooting--gotchas)

---

## 1. Overview

The rating engine is a **Bayesian skill-rating system** based on **TrueSkill / TrueSkill2** (Microsoft Research). Instead of a single Elo number, every player's skill is modelled as a **Gaussian (normal) distribution** with two parameters:

- **`mu` (μ)** — the engine's best estimate of the player's true skill (the mean).
- **`sigma` (σ)** — how *uncertain* the engine is about that estimate (the standard deviation). High σ = "we don't know this player yet"; low σ = "we've seen enough rounds to be confident".

Both live on the `Elo_PlayerStats` table as the columns `mu` and `sigma` — **those two numbers are the entire persisted skill state.** Everything else (kills, squad size, quit flags) is a per-round *observation* used to update them, not stored skill.

Players never see μ and σ directly. The single displayed number is the **CSR (Competitive Skill Rank)**, a *conservative* estimate:

```
CSR = mu - 3.0 * sigma
```

The `3.0` multiplier (`SIGMA_MULTIPLIER`) means a player is shown a rating the engine is ~99.7% sure they are *at least* that good. As a player plays more rounds, σ shrinks and their CSR rises toward their true μ even if μ itself doesn't change — this is why new players climb quickly at first ("calibration").

**Everything is neutral out of the box.** All TrueSkill2 extensions (squad, experience, kill/death, quit) are disabled by default, so the engine is numerically identical to classic TrueSkill until *you* calibrate and opt in.

**Deep theory** (the actual math — factor graphs, EP, the paper's equations) lives in:
- `docs/trueskill2-explained.md` (English)
- `docs/trueskill2-erklaerung.md` (German)

**Paper citation:** Tom Minka, Ryan Cleven, Yordan Zaykov, *"TrueSkill 2: An improved Bayesian skill rating system"*, Microsoft Research Technical Report MSR-TR-2018-8, March 2018. <https://www.microsoft.com/en-us/research/publication/trueskill-2-improved-bayesian-skill-rating-system/>

This guide does **not** reproduce the theory — read the docs above for the math.

---

## 2. How a rating update happens

Ratings are computed **once per round, at round end.** Here is the actual per-round flow in this repo, in plain language.

**During the round — collect data:**

1. **`NEW_GAME`** → the plugin resolves the layer, starts a new session/round, saves the round-start timestamp, and clears its in-memory caches (rating cache, kill/death counters, last-seen tracking).
2. **`UPDATED_PLAYER_INFORMATION`** (every ~30s RCON poll) → updates the participation tracker for every connected player, records a "last seen" timestamp per player (used for quit detection), and lazily warms an **in-memory rating cache** (`eloCache`) by batch-loading μ/σ from the DB for connected players. Uncached players fall back to defaults (μ = 25.0, σ ≈ 8.333).
3. **`PLAYER_WOUNDED`** → increments a kill counter for the attacker (team-kills, self-wounds, and same-team fallbacks are skipped).
4. **`PLAYER_DIED`** → increments a death counter for the victim (suicides, team-kills, and environment deaths all count).

> **Note:** A "party" in the party offset factor is not an in-game squad, but a group of players sharing a **clan tag on the same team** (detected from their names). Squad size is now the clan-tag party size.

**At round end — compute and persist:**

5. **`ROUND_ENDED`** → the plugin runs a series of **eligibility gates**. The round is *silently skipped* (ratings untouched, a skip embed posted) if any fail:
   - plugin not ready;
   - `server.players.length < minPlayersForElo`;
   - the gamemode/layer matches `ignoredGameModes`, or the layer is unknown;
   - no eligible participants, or one team has zero eligible participants.
6. **Team assembly** — the winner/loser and ticket difference are read from the round-end data (outcome = `team1win` / `team2win` / `draw`). Participants are filtered to those whose `participationRatio >= minParticipationRatio`, then split into team 1 and team 2 by their assigned team ID.
7. **Meta build** — quitters are detected (see [§4](#4-the-four-trueskill2-factors) and [§5](#5-configuration-reference)); per-player metadata (squad size/ID, kills, deaths, quit flag, experience, time played) is assembled.
8. **Engine call** — `computeRoundUpdate(team1, team2, outcome, perPlayerMeta, params)` runs the TrueSkill2 update inside a **try/catch**. The engine computes each factor's message from the player's prior, combines them in one Expectation-Propagation pass, applies the `tau` drift, and applies the experience mean-shift. If the engine throws (the factor library throws by design on unstable messages), the **entire round is skipped** and ratings are left untouched.
9. **Apply updates** — for each player the raw deltas are scaled by their `participationRatio`:
   ```
   newMu    = rating.mu    + deltaMu    * participationRatio
   newSigma = max(rating.sigma - deltaSigma * participationRatio, 0.5)
   ```
   (Note σ is *reduced* by a subtraction, and hard-floored at 0.5.)
10. **Persist** — player stats are written (μ/σ overwritten; wins/losses/roundsPlayed **incremented** by 1), a round-history row is inserted, and a full per-round record is appended to the JSONL match log (`eloLogPath`). The rating cache is snapshotted and cleared.

---

## 3. The rating number & uncertainty

### Displayed rating (CSR)

```
CSR = mu - 3.0 * sigma
```

- `SIGMA_MULTIPLIER = 3.0` is defined **once** in `utils/elo-calculator.js` (a static class constant) and referenced everywhere else via `EloCalculator.SIGMA_MULTIPLIER` — the in-game/Discord command helpers, the embed builders, and the leaderboard/rank SQL in `utils/elo-database.js`, which *interpolates* the constant into `(mu - (3 * sigma))` rather than hardcoding a literal. It is **not** a config option; changing it means editing that one source constant (only the standalone `tools/elo-inspect.js` keeps its own separate `3` literal).
- Leaderboard order and player rank are both computed from this CSR formula in SQL.

### Sigma (uncertainty) behaviour

- **Starting uncertainty:** new/uncached players start at `SIGMA_DEFAULT = 25/3 ≈ 8.333` (with μ = 25.0).
- **Sigma shrinks** as rounds are played (the plugin's update subtracts from σ each round).
- **Hard floor:** σ can never drop below **0.5** — `max(sigma - scaledDeltaSigma, 0.5)` is applied at every write, independent of the engine.
- **Drift back up:** the engine's `tau` (default 0.25) adds a small amount of uncertainty back once per round (`newSigma = sqrt(sigma² + tau²)`), so long-inactive-then-returning players don't get stuck at absolute certainty.

### Calibration tiers

Two independent things gate visibility:

**(a) Ranked vs. provisional** — controlled by the `minRoundsForLeaderboard` option (default **10**). A player with `roundsPlayed < 10` is *provisional*: their rank is hidden and the embed shows `(Calibrating | μ - 3σ)` with a "Provisional — N rounds played. Rank visible after 10 rounds" note. Clan averages also only count members past this threshold.

**(b) Hard-coded tier labels** — used for balance embeds/metrics. These are **not** config options (they live in code):

| Tier | Games played |
|------|--------------|
| Visitor | 0–3 |
| Provisional | 4–9 |
| Regular | 10+ |

> The README's "**σ > 6.5 = Initial Calibration**" note is a *human-readable* description of a freshly-seeded player: someone who has played almost nothing still has σ near the 8.333 starting value (well above 6.5), so they are unmistakably uncalibrated. The code does not branch on σ = 6.5; visibility is gated by **round count** (`minRoundsForLeaderboard`), and σ simply reflects how far calibration has progressed. Treat "high σ" and "few rounds played" as two views of the same thing.

---

## 4. The four TrueSkill2 factors

All four are **off by default** (weights/offsets zero). Each adds an extra "message" to the per-player update when enabled. See `docs/trueskill2-explained.md` for the equations (referenced by number below).

**Party factor (eq. 7) — `partyOffsets`.** A per-party-size performance offset,
where a "party" is players sharing a **clan tag on the same team** (detected from
their names, not in-game squads). It shifts the *team mean* used in the win/loss
comparison, ratio-weighted and slot-scaled the same way the team mean is. Index =
party size − 1 (solo/no-tag/single-tag pinned to 0). Detection is tunable via the
plugin options `partyCaseSensitive`, `partyMaxEditDistance` and `partyIgnoredTags`.
Neutral default = no effect.

**Experience factor (eq. 8) — `experienceOffsets`.** A pure additive drift to μ applied **every match, win or lose**, indexed by matches played (capped at 199). It models the "new players improve just by playing" effect as a biased random walk — a small positive offset for low experience that decays to 0 as players rack up games. Affects μ only, never σ. Turning it on gently lifts newcomers' μ during their first games regardless of results.

**Kill/death factor (eq. 9) — `killParams`, `deathParams`.** Feeds individual performance (kills and deaths, each as an independent message) into the skill update, so a player who consistently out-fights their opponents gains rating faster than the team result alone would justify. Each has `wPlayer` (own-skill weight), `wOpponent` (opponent-strength weight), and `variance`. **If `wPlayer` is 0 the whole message is identically zero** — so with default weights this factor does nothing regardless of the variance. Also requires `timePlayedMin > 0` in the meta. Zero-kill/zero-death rounds use a special *censored* update. **The calibration tool deliberately does not sweep these** — enable them manually only if you know what you're doing.

**Quit factor (eq. 12/13) — `quitParams`.** Applies a rating penalty to players who leave mid-round. It is modelled as a deterministic "loss" against the mini-game opponent, so μ always decreases. `mQ` is the quit margin (must be ≤ 0); `vQ` is the observation variance (must be > 0). The default `mQ = -2.083` produces roughly **−4.7 μ per quit** at default σ — *larger than a typical round swing*. This factor is **double-gated**: it only affects ratings when `enableQuitPenalty: true` AND the player was detected as a quitter. **Calibrate `quitParams` before enabling it.**

---

## 5. Configuration reference

All options live in the EloTracker plugin block. Values shown are the exact defaults.

### (a) General / plugin options

| Option | Default | Effect |
|--------|---------|--------|
| `database` | `"sqlite"` | Sequelize connector name (SQLite / MySQL / PostgreSQL). Selects the SQL backend. |
| `eloLogPath` | `"./elo-match-log.jsonl"` | Path to the JSONL match log; one full per-round record appended every scored round. **This is the file the calibrate/rebuild tools consume.** |
| `minParticipationRatio` | `0.15` | Minimum fraction of the round a player must play to be eligible. Also **scales** each player's rating delta (`delta * participationRatio`). |
| `minPlayersForElo` | `80` | Minimum `server.players.length` at round end for the round to be scored. Below this the round is skipped. Also gates the round-start embed. |
| `minRoundsForLeaderboard` | `10` | Rounds needed before a player is ranked (below = provisional, rank hidden). Also used for mount-time stale-entry pruning and clan-average membership. |
| `roundStartEmbedDelayMs` | `180000` | Delay (ms, ~3 min) after `NEW_GAME` before the round-start balance embed posts; retried each poll for a further 10-minute window. |
| `ignoredGameModes` | `["Seed", "Jensen"]` | Substrings matched case-insensitively against **both** gamemode and layer name; a match skips ELO for that round. Unknown layer also skips. |
| `enablePublicIngameCommands` | `true` | Enables/disables the public in-game `!elo` chat commands. |
| `discordClient` | `"discord"` | Discord connector name used for channels and the message listener. |
| `discordAdminChannelID` | `""` | Channel ID for Discord admin commands; also the final report fallback target. |
| `discordPublicChannelID` | `""` | Channel ID for public-facing Discord commands; also a report fallback for the round-start and post-scramble embeds only. |
| `discordReportChannelID` | `""` | Channel ID for automated reports. Round summaries and skip notices fall back to the **admin** channel when unset; the round-start and post-scramble balance embeds fall back to **public → admin**. |
| `discordAdminRoleIDs` | `[]` | Role IDs required for Discord admin commands; empty = any user in the admin channel. |
| `discordAdminRoleID` | `""` | Back-compat single-role fallback; wrapped into `discordAdminRoleIDs` if that array is empty. |
| `enableDatabaseLogging` | `false` | If true, mirrors per-round per-player rows into DB tables (`Elo_RoundPlayers`) for querying. |
| `quitGraceSeconds` | `60` | A player unseen in `server.players` for longer than this at round end counts as departed. Keep ≥ ~2 RCON poll cycles (~60s). |
| `quitParticipationThreshold` | `0.5` | Players with `participationRatio` below this **and** absent past the grace window are flagged as quitters. |
| `enableQuitPenalty` | `false` | If true, detected quitters feed the quit factor into the engine. **Quit flags are recorded to DB/log regardless.** Calibrate `quitParams` first. |
| `partyCaseSensitive` | `false` | Clan-tag matching for the party factor is case-sensitive (no normalization). Default `false` = normalized (case/homoglyph-insensitive). |
| `partyMaxEditDistance` | `1` | Levenshtein distance for merging near-identical clan tags. **Caution:** distance 1 can also merge similar-but-*different* tags, and bare two-word names can false-positive as tags — audit with `tools/elo-clans-audit.js` and set `0` for exact-only matching. |
| `partyIgnoredTags` | `[]` | Clan tags treated as public (community tags, not real clans); matched normalized. |

> **Not configurable (hard-coded in code, listed for reference):** tier cutoffs `visitorMaxGames:3`, `provisionalMaxGames:9`, `regularMinGames:10`; balance flags `troublingDelta:1.5`, `criticalDelta:3.0`, `imbalanceRatio:1.5`; the `SIGMA_MULTIPLIER = 3.0`; DB prune windows (30 days provisional / 90 days calibrated).

### (b) The `trueskill2` parameter block

`trueskill2: {}` (empty) → all neutral defaults below → **engine is identical to classic TrueSkill.** Overrides are merged element-wise onto these defaults (arrays keep their canonical length; unknown keys and null/undefined are ignored; `partyOffsets[0]` is always forced to 0).

> **Placement matters:** the party *detection* options (`partyCaseSensitive`, `partyMaxEditDistance`, `partyIgnoredTags`) are **top-level plugin options** (§5(a)), NOT part of this block — placed here they are silently ignored. Likewise, the pre-rename key `squadOffsets` is no longer recognized: it is silently dropped, so a previously calibrated config must rename it to `partyOffsets`.

| Parameter | Default | Effect |
|-----------|---------|--------|
| `mu0` | `25.0` | Prior skill mean for a new player (midpoint of the 0–50 scale). |
| `v0` | `(25/3)² ≈ 69.44` | Prior skill *variance* (σ ≈ 8.333). |
| `beta` | `25/6 ≈ 4.167` | Per-player performance noise. Broadens comparison variance; added as `beta²` per player. |
| `tau` | `0.25` | Per-match dynamics drift, applied **once per round** as `sqrt(σ² + tau²)`. |
| `tauPerMinute` | `0` | Time-based drift. **Defined but NOT consumed by the engine** — setting it has no effect. |
| `drawProbability` | `0.01` | Assumed draw margin; feeds the draw threshold `epsilon`. |
| `partyOffsets` | `[0.0 × 10]` | Party-size mean offset (eq. 7). Index = party size − 1; index 0 (solo) pinned to 0. |
| `experienceOffsets` | `[0.0 × 200]` | Additive μ drift by matches played (eq. 8); index = matches capped at 199. Applied every match. |
| `killParams.wPlayer` | `0.0` | Own-skill weight for kills (eq. 9). **0 disables the kill message entirely.** |
| `killParams.wOpponent` | `0.0` | Opponent-strength weight for kills. |
| `killParams.variance` | `1.0` | Kill observation variance per minute (ignored while weights are 0). |
| `deathParams.wPlayer` | `0.0` | Own-skill weight for deaths. **0 disables the death message entirely.** |
| `deathParams.wOpponent` | `0.0` | Opponent-strength weight for deaths. |
| `deathParams.variance` | `1.0` | Death observation variance per minute. |
| `quitParams.mQ` | `-2.083` (= `-beta*0.5`) | Quit margin (must be ≤ 0). ≈ −4.7 μ per quit at default σ. Only active when `enableQuitPenalty: true`. |
| `quitParams.vQ` | `1.0` | Quit observation variance (must be > 0, else the factor is skipped). |

---

## 6. Calibration

### Why the defaults are neutral

Out of the box, every TrueSkill2 feature is zero/off, so the engine behaves exactly like classic TrueSkill (golden-tested). This is intentional: the extra factors only help if their weights are tuned to *your* server's data. Wrong values make ratings worse, not better.

### Why the paper's (Halo) values don't transfer

TrueSkill2's published parameters were fit on **Halo 5** matchmaking data. Squad is a different game (team sizes, round length, kill economy, what "quitting" means). The internal scale here is 0–50 (midpoint 25, `beta ≈ 4.167`) versus the paper's `beta = 1`. **You must calibrate against your own match log — do not copy numbers from the paper.**

### Prerequisites

1. A recorded **JSONL match log** at `eloLogPath` (default `./elo-match-log.jsonl`), accumulated over many rounds of live play. Pre-TrueSkill2 log records lack the squad/kill/quit fields, so collect fresh data after upgrading.
2. A **DB backup JSON** with a top-level `players[]` array (obtain via `!elo backup` / export). This is used *only* to mark which players count as "rated" (≥ 5 rounds) for match weighting — it does **not** seed ratings.

### Run the calibrator

```bash
node tools/elo-calibrate.js <matchlog.jsonl> <db-backup.json> [--party-case-sensitive] [--party-max-edit-distance=N] [--ignore-tags=A,B]
```

Both positional arguments are **required**. The three party flags (`--party-case-sensitive`, `--party-max-edit-distance=N`, `--ignore-tags=A,B`) must mirror the live plugin's `partyCaseSensitive` / `partyMaxEditDistance` / `partyIgnoredTags` — otherwise calibration groups parties differently than production scores them. **The tool writes nothing to disk** — all output (progress, tables, and a ready-to-paste config block) goes to stdout.

If your log is split into fragments, merge them first (dedupes by matchId, first file wins, sorts chronologically):

```bash
node tools/merge-match-logs.js <fileA.jsonl> <fileB.jsonl> [output.jsonl]
```

### What it estimates

The calibrator replays your entire log from scratch for each candidate parameter set and ranks by **adjusted log-loss** (prediction error + a variance penalty `LAMBDA=200` that stops high `beta` from winning by flattening every prediction to 50/50).

- **Stage 1 — BETA × TAU grid.** Sweeps `beta` 0.5→30.0 (step 0.5) and `tau` 0.01→0.50 (step 0.02). Prints a smoke test, a TOP-10 table, calibration buckets, and prediction-spread curves. The Stage-1 winner's beta/tau feed Stage 2.
- **Stage 2 — TrueSkill2 sweep** at the Stage-1 winner. Sweeps exactly three dimensions:
  - `quitParams.mQ` over `[0, -1.0, -2.083, -3.0]` (0 = quit off);
  - `experienceOffsets[0]` (new-player drift) over `[0, 0.1, 0.2, 0.4]`, expanded to a 50-game linear decay;
  - the 4-stack party boost over `[0, 0.5, 0.83, 1.2]`, expanded to a linear `partyOffsets` curve.
  - **Kill/death weights are deliberately NOT swept.**
  - A dimension collapses to `[0]` if the log lacks that observation (no quit flags → mQ off; no clan parties in log → party off). If your recommended config omits `quitParams`/`partyOffsets`, check whether your log actually contains those fields.

### Copy the result into config

After the Stage-2 TOP-10 table, the tool prints:

```
Recommended plugin config (paste into the EloTracker options):
{
  "trueskill2": {
    "beta": ...,
    "tau": ...,
    "experienceOffsets": [ ... ],   // omitted if it calibrated to 0
    "partyOffsets": [ ... ],        // omitted if it calibrated to 0
    "quitParams": { "mQ": ..., "vQ": 1.0 }  // omitted if mQ calibrated to 0
  },
  "enableQuitPenalty": true          // added ONLY when mQ != 0
}
```

Paste the `trueskill2` block (and `enableQuitPenalty` if present) into your EloTracker plugin options. If the tool instead prints **"All TrueSkill2 factors calibrate to OFF on this log — keep neutral defaults"**, do exactly that: keep the neutral defaults, do not invent values.

---

## 7. Rebuild / replay

Calibrating and pasting new parameters only changes how **future** rounds are scored. To recompute **all existing ratings** from the authoritative match log under the new parameters (e.g. after a formula fix or parameter change), use the rebuild tool.

> **⚠️ Back up your database first.** Copy the whole SQLite DB file *including its `-wal` and `-shm` sidecar files* (or dump all tables for MySQL/Postgres). Note that `!elo backup` / `exportPlayerStats` only covers `Elo_PlayerStats` — it does **not** capture the round history the tools rely on.

```bash
node tools/elo-rebuild.js <matchlog.jsonl> <backup.json> [output.json] [--apply-quit-penalty] [--party-case-sensitive] [--party-max-edit-distance=N] [--ignore-tags=A,B]
```

- **arg 1** `matchlog.jsonl` (required) — the authoritative source of outcomes + participants.
- **arg 2** `backup.json` (required) — an existing backup, used **only** to carry `steamID`/`discordID` across by `eosID`.
- **arg 3** `output.json` (optional) — where the rebuilt, restore-compatible backup is written. Default: `elo-rebuilt-<timestamp>.json` in the current directory (run from a known directory or pass an explicit path).
- **`--apply-quit-penalty`** — apply the quit factor during replay. Use this **only if** your live plugin has `enableQuitPenalty: true`, so the offline rebuild matches live behaviour. Default (off) mirrors the plugin default.

The tool replays every match chronologically through the engine, starting every player from the μ₀/√v₀ prior, then prints a Done/Processed/Skipped summary. Load the produced `output.json` into the live DB with:

> **Party size caveat:** replaying a **post-feature** log (records carrying `partySize`/`clanTag` per player) uses that exact logged value, matching live scoring bit-for-bit. Replaying a **pre-feature** log (no `partySize` field) instead recomputes party size from the logged player names — since the log only contains eligible players, this recomputation necessarily excludes any sub-threshold/ineligible member of a live party, which can undercount a party that had a live boost.

```
!elo restore
```

> **Important limitation:** the CLI always replays with **neutral** parameters — it cannot take a calibrated `beta`/`tau` from the command line. To rebuild with your calibrated parameters you must import the exported `rebuildFromLog(matchlogPath, backupPath, paramOverrides, options)` function from `utils/elo-rebuild.js` in your own script and pass the overrides in code.

---

## 8. Recommended end-to-end workflow

1. **Start neutral.** Deploy with `trueskill2: {}` (or no block). The engine runs as classic TrueSkill. Confirm `eloLogPath` is set and writable.
2. **Collect a match log.** Let the server run over **N matches** (the more the better — aim for at least dozens of scored rounds so per-team rated-player weighting kicks in). Make sure the rounds are actually being scored (player count ≥ `minPlayersForElo`, not an ignored gamemode).
3. **Grab a DB backup** via `!elo backup` / export — the second calibrate argument.
4. **Calibrate:** `node tools/elo-calibrate.js <matchlog.jsonl> <db-backup.json>`.
5. **Review** the Stage-1 and Stage-2 tables. Sanity-check that the winner isn't a degenerate flat-prediction. If the tool says "keep neutral defaults", stop here.
6. **Apply to config** — paste the printed `trueskill2` block (and `enableQuitPenalty` if present) into the plugin options.
7. **Back up the DB** (whole SQLite file + `-wal`/`-shm`), then **rebuild** so existing ratings match the new parameters. Use the programmatic `rebuildFromLog` with your calibrated overrides if you changed beta/tau; add `--apply-quit-penalty` iff you enabled `enableQuitPenalty`.
8. **Verify** — load the rebuilt backup via `!elo restore`, spot-check a few known players' CSR and the leaderboard order, and confirm live rounds continue to score.
9. **Iterate** — keep logging, and recalibrate periodically as your population and meta shift.

---

## 9. Troubleshooting / gotchas

- **"Nothing changed after I set party/kill/experience values."** Every TrueSkill2 feature is off by default. Party/experience/kill/death effects require calibrating and pasting values into the `trueskill2` block. `killParams.wPlayer`/`deathParams.wPlayer` of 0 makes those factors *identically zero* regardless of variance.
- **Quit penalty isn't applying.** It's double-gated: `quitParams.mQ` has no effect unless `enableQuitPenalty: true`. Detection (recorded to DB/log) happens regardless; only the engine-facing quit flag is gated. And calibrate `quitParams` first — the default `mQ = -2.083` is a *large* penalty (~−4.7 μ per quit).
- **False quitter flags.** SquadJS has **no reliable disconnect event** (`PLAYER_DISCONNECTED` never fires); departure is inferred from ~30s polling, so a crash is indistinguishable from a rage-quit. Keep `quitGraceSeconds` ≥ ~60s (≥ 2 poll cycles).
- **`tauPerMinute` does nothing.** It exists in the defaults but the engine never reads it. Use `tau` for drift.
- **Rounds are silently skipped.** A round mutates no ratings (and posts a skip embed) if: the plugin isn't ready, player count < `minPlayersForElo`, the gamemode/layer is ignored or unknown, there are zero eligible participants, or one team has no eligible participants.
- **Engine throws → whole round skipped.** The factor library throws by design on unstable messages (posterior precision ≤ 0, σ ≤ 0); the round is skipped and ratings untouched. Note: NaN inputs (e.g. `drawProbability >= 1`) do **not** throw and are not guarded — don't set nonsense parameters.
- **σ never goes below 0.5.** A hard floor is applied at every write, independent of the engine. New/uncached players start at σ ≈ 8.333.
- **CSR multiplier is hard-coded.** `mu - 3*sigma` lives in code as the single `EloCalculator.SIGMA_MULTIPLIER` constant (in `utils/elo-calculator.js`), *referenced* — not re-literaled — by the leaderboard/rank SQL (which interpolates it) and the command/embed helpers. It is a source constant, not a config option.
- **The DB counters are incremented, not overwritten.** wins/losses/roundsPlayed are added to (per-round 0 or 1); μ/σ are overwritten with absolute values. Rebuild/calibration writes must respect this contract or totals double-count.
- **calibrate writes nothing to disk.** You copy its printed JSON by hand. Its second (backup) arg does **not** seed ratings — replays always start from defaults.
- **Stage-2 dimensions collapse to `[0]`** when the log lacks quit flags or clan parties > 1. Pre-TrueSkill2 log records lack those fields entirely.
- **rebuild CLI uses neutral params only.** To rebuild with calibrated beta/tau, call `rebuildFromLog` from code. Run with `--apply-quit-penalty` **only** if the live plugin has `enableQuitPenalty` on, or the rebuilt DB diverges from live scoring.
- **Backups are partial.** `exportPlayerStats`/`!elo backup` covers only `Elo_PlayerStats`. Losing `Elo_RoundPlayers` (the per-round observations) breaks TrueSkill2 replay even if player stats survive. For a full, restorable backup, copy the whole DB file (SQLite: include `-wal`/`-shm`).
- **Missing TrueSkill2 columns after upgrade.** `sync()` runs without `alter`, so it never adds columns to existing tables — the six TrueSkill2 observation columns on `Elo_RoundPlayers` are added only by the additive migration, which no-ops if the table doesn't yet exist.
- **Embeds silently do nothing** if none of the report/public/admin Discord channels resolve. And raising `minRoundsForLeaderboard` also changes stale-entry pruning and clan-membership behaviour.
- **Feed a single chronologically-consistent log.** Both tools sort by `endedAt` internally but do **not** dedupe — merge fragments first with `merge-match-logs.js`.
