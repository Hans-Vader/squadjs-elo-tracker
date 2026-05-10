#!/bin/sh
set -e

SQUADJS_APP="${SQUADJS_APP:-/squadjs}"

# Build merged workspace matching SquadJS directory layout:
#   /app/core/           <- SquadJS core (logger, etc.)
#   /app/squad-server/   <- merged squad-server + project files
#
# This is required because plugin imports use ../../core/logger.js
# which resolves relative to the squad-server subdirectories, and the
# test files live at testing/ alongside plugins/ and utils/.

mkdir -p /app
ln -sf "$SQUADJS_APP/core" /app/core

# Start from SquadJS squad-server base, then overlay project files
cp -a "$SQUADJS_APP/squad-server/." /app/squad-server/
cp -a /project/plugins/. /app/squad-server/plugins/
cp -a /project/utils/. /app/squad-server/utils/
cp -a /project/testing/. /app/squad-server/testing/

# Symlink node_modules so ESM package resolution works
# (NODE_PATH is ignored by ESM imports)
ln -sf "$SQUADJS_APP/node_modules" /app/squad-server/node_modules
ln -sf "$SQUADJS_APP/node_modules" /app/node_modules

cd /app/squad-server

CMD="${1:-all}"
shift 2>/dev/null || true

# Dispatch a single suite by importing it dynamically and reusing the
# exported runTest helper from run-all-tests.js. Avoids modifying any
# of the existing testing/*.js files.
run_single_suite() {
  SUITE_FILE="$1"
  SUITE_LABEL="$2"
  node --input-type=module -e "
    const { runTest } = await import('./testing/run-all-tests.js');
    const mod = await import('./testing/${SUITE_FILE}');
    console.log('\x1b[36m=== EloTracker Test Runner ===\x1b[0m\n');
    console.log('\x1b[33mRunning Suite: ${SUITE_LABEL}\x1b[0m');
    let failed = 0;
    const wrap = async (name, fn) => {
      const r = await runTest(name, fn);
      if (!r.passed) failed++;
      return r.passed;
    };
    if (typeof mod.default !== 'function') {
      console.error('Suite ${SUITE_FILE} has no default export function');
      process.exit(1);
    }
    await mod.default(wrap);
    process.exit(failed > 0 ? 1 : 0);
  "
}

case "$CMD" in
  calculator)
    run_single_suite test-elo-calculator.js EloCalculator
    ;;
  session)
    run_single_suite test-elo-session-manager.js EloSessionManager
    ;;
  database)
    run_single_suite test-elo-database.js EloDatabase
    ;;
  tracker)
    run_single_suite test-elo-tracker.js EloTracker
    ;;
  simulation)
    run_single_suite test-elo-simulation.js EloSimulation
    ;;
  clangrouping|clan)
    run_single_suite test-clan-grouping.js EloClanGrouping
    ;;
  all)
    echo "Running all EloTracker test suites..."
    node testing/run-all-tests.js
    echo ""
    # Clan-grouping suite isn't in run-all-tests.js by design (no JS-file
    # changes there). Run it explicitly so 'all' actually means all.
    run_single_suite test-clan-grouping.js EloClanGrouping
    ;;
  *)
    exec "$CMD" "$@"
    ;;
esac
