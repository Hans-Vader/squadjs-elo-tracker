# Tools

Standalone Node.js scripts for data analysis and manipulation.

These are **not part of the plugin** and are **not maintained** alongside it. They were written for one-off use during development — calibrating parameters, rebuilding ratings from match logs, merging log files, and analysing rating spread. They may be out of date, make assumptions about file paths or data shapes, and are provided as-is.

No support is provided. Use at your own risk.

---

## Scripts

**`analyze-spread.js`**
Cross-references a DB backup with a JSONL match log. Bins games by team average mu spread and reports favoured-team win rate per bucket. Useful for checking whether mu differences actually predict outcomes.
```
node analyze-spread.js <backup.json> <matchlog.jsonl>
```

**`elo-calibrate.js`**
Two-pass grid search over TrueSkill BETA and TAU against historical match data, minimising weighted log-loss plus a calibration-error penalty (`lambda × calibMSE × games`). The penalty measures how far the mean predicted win probability in each of 10 probability bands is from the observed win rate there — i.e. it punishes overconfidence, not just wrong predictions. Without it the search drifts to a high-TAU region that fits raw log-loss marginally better but never lets ratings converge.

Pass 1 sweeps BETA 0.1–50 / TAU 0.01–2.0 coarsely, pass 2 refines around the top 3. Outputs the top 10 parameter sets, prediction curves, and the same metrics for the values currently set in `EloCalculator` as a baseline — scored under the same lambda, so the comparison is apples to apples.

```
node elo-calibrate.js <matchlog.jsonl> <db-backup.json> [--lambda=50,100,200]
```
`--lambda` takes a comma-separated list and runs the whole search once per value (default: `50`). Higher = calibration weighted more heavily against raw fit; `--lambda=0` gives the unpenalised log-loss optimum.

Draws and matches missing a team are skipped — a log with no decided matches exits with an error. The DB backup is only used to look up `roundsPlayed` per `eosID`, for weighting matches that had ≥3 rated players per team.

**These parameters do not transfer between servers.** Re-run this against your own match log rather than adopting numbers calibrated elsewhere.

**`elo-clans-audit.js`**
Utility script that loads a database JSON and outputs a comprehensive text report mapping all players to their detected clan group. Used to manually verify the extraction and normalization rules.
```
node elo-clans-audit.js [path/to/db.json]
```

**`elo-inspect.js`**
Interactive CLI tool to query players, view local leaderboards, analyse spread distribution, and simulate Discord round-end embeds using data from a match log. Can accept a secondary backup file to automatically calculate and display rating changes.
```
node elo-inspect.js <rebuilt.json> [old-backup.json] [matchlog.jsonl]
```

**`elo-rebuild.js`**
Replays all recorded matches from scratch using the current TrueSkill formula. Outputs a restore-compatible JSON backup. Useful after formula corrections.
```
node elo-rebuild.js <matchlog.jsonl> <backup.json> [output.json]
```

**`merge-match-logs.js`**
Merges any number of JSONL match logs, deduplicates by `matchId` (earlier input wins on conflict), and sorts chronologically. Inputs may be `.jsonl` files or directories (all `.jsonl` inside are picked up, sorted by name). The output path is an explicit flag, never guessed from position; writing over an input file is refused.
```
node merge-match-logs.js <file.jsonl|dir> [...more] [--out=merged-match-log.jsonl]
```
