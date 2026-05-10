# Testing

Standalone scripts for testing the EloTracker plugin's core modules.

The suites cover the TrueSkill math (`elo-calculator.js`), in-memory session tracking (`elo-session-manager.js`), the multi-DB persistence layer (`elo-database.js` against in-memory SQLite), the plugin event wiring (`elo-tracker.js` against mocks), and a long-run statistical simulation. They use mocks/in-memory stores only — no live SquadJS server or fixture data is required.

---

## Running tests via docker (recommended)

From the project root, copy `.env.dist` to `.env` and set `SQUADJS_PATH` to your local SquadJS install. Then:

```bash
docker compose run --rm test all            # all suites
docker compose run --rm test calculator     # EloCalculator only
docker compose run --rm test session        # EloSessionManager only
docker compose run --rm test database       # EloDatabase only (in-memory SQLite)
docker compose run --rm test tracker        # EloTracker plugin event wiring
docker compose run --rm test simulation     # 20-iteration statistical simulation
docker compose run --rm test clangrouping   # Clan-tag detection + grouping (utils/elo-clan-grouping.js)
```

The `test` service mounts your SquadJS install and the project source into a container, then runs `testing/entrypoint.sh` which overlays `plugins/`, `utils/`, and `testing/` onto a copy of the SquadJS `squad-server/` tree. This is required because plugin imports use `../../core/logger.js` and `./base-plugin.js`, which only resolve in the SquadJS layout.

A `test-results.json` file is written inside the container after each run (gitignored on the host via `*.json`).

---

## Running locally

If you want to run a suite directly with a local Node install, you must do it from a SquadJS-style layout (this repo's `plugins/` and `utils/` placed under `squadjs/squad-server/` so `../../core/logger.js` resolves). The docker harness builds that layout for you.

```bash
node testing/run-all-tests.js   # all suites
```

Per-suite dispatch is implemented in `testing/entrypoint.sh` (via inline `node --input-type=module -e ...` that reuses the exported `runTest` from `run-all-tests.js`), so the docker shortcuts above are the easiest way to run a single suite.

---

## Suites

### `test-elo-calculator.js`
Sanity checks on the TrueSkill math: default constants, basic 1v1 win/loss direction, upset gain bias, and sigma decay direction.

### `test-elo-session-manager.js`
Participation-ratio tracking: full-round players, mid-round joiners, team switchers (split credit), and disconnect/ghost segment closing.

### `test-elo-database.js`
Runs against an in-memory SQLite instance. Covers model creation, upsert/search by EOSID/SteamID/partial name, and the `SQLITE_BUSY` retry loop.

### `test-elo-tracker.js`
Mounts the plugin against a mock server and mock DB. Asserts listener registration, cache population on `UPDATED_PLAYER_INFORMATION`, the min-players guard, and stat persistence on `ROUND_ENDED`.

### `test-elo-simulation.js`
Statistical simulation across a 500-player weighted pool (regulars/semi-regulars/randoms). Validates: no NaN/Infinity; bounded ratings; faster sigma convergence for active players; winners rise / losers fall; veteran < rookie per-round delta; sigma floors at 0.5; symmetric 50/50 records stay near default; participation scaling proportional; rank order across winrate archetypes. Defaults to 20 iterations.

### `test-clan-grouping.js`
Unit tests for `utils/elo-clan-grouping.js` — the unified clan-tag module shared by `elo-discord.js`, `tools/elo-inspect.js`, and `tools/elo-clans-audit.js`. Pinned cases include the homoglyph collapse (`[♣ΛCE]` and `[♣ΛC€]` → one `ACE` group), all five extraction strategies (bracket / explicit-separator / 2+ space / short-allcaps / bare-prefix fallback), Levenshtein merging, `caseSensitive` toggling, and min/max-size filters. Not registered in `run-all-tests.js`; the `all` shortcut in `entrypoint.sh` runs it after the registered suites.

---

> **Note:** All scripts assume a SquadJS-style directory layout (`squad-server/plugins/...` so `../../core/logger.js` resolves). The docker harness builds that layout for you by overlaying the project's `plugins/`, `utils/`, and `testing/` onto a copy of the SquadJS `squad-server/` tree.
