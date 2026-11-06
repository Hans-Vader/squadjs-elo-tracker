import { fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const COLORS = {
  RESET: '\x1b[0m',
  GREEN: '\x1b[32m',
  RED: '\x1b[31m',
  YELLOW: '\x1b[33m',
  CYAN: '\x1b[36m'
};

/**
 * Helper to execute a test case with logging.
 * @param {string} name - The name of the test case.
 * @param {Function} fn - The async test function.
 */
export async function runTest(name, fn) {
  process.stdout.write(`  • ${name}... `);
  try {
    await fn();
    console.log(`${COLORS.GREEN}[PASS]${COLORS.RESET}`);
    return { passed: true, error: null };
  } catch (err) {
    console.log(`${COLORS.RED}[FAIL]${COLORS.RESET}`);
    console.error(err.stack || err);
    return { passed: false, error: err.message || String(err) };
  }
}

/**
 * Main runner that executes all defined test suites.
 */
export async function runAll() {
  console.log(`${COLORS.CYAN}=== EloTracker Test Runner ===${COLORS.RESET}\n`);

  const suites = [
    { name: 'EloCalculator', file: './test-elo-calculator.js' },
    { name: 'EloSessionManager', file: './test-elo-session-manager.js' },
    { name: 'EloClanGrouping', file: './test-clan-grouping.js' },
    { name: 'EloDatabase', file: './test-elo-database.js' },
    { name: 'EloTracker', file: './test-elo-tracker.js' },
    { name: 'EloSimulation', file: './test-elo-simulation.js', iterations: 20 }
  ];

  const results = {};
  let totalPassed = 0;
  let totalFailed = 0;
  const brokenSuites = [];

  for (const suite of suites) {
    results[suite.name] = [];
    const iterations = suite.iterations || 1;

    for (let i = 0; i < iterations; i++) {
      const runLabel = iterations > 1 ? `${suite.name} (Run ${i + 1}/${iterations})` : suite.name;
      console.log(`${COLORS.YELLOW}Running Suite: ${runLabel}${COLORS.RESET}`);

      const suiteRunData = {
        iteration: i + 1,
        timestamp: new Date().toISOString(),
        tests: []
      };

      const capturingRunTest = async (name, fn) => {
        const result = await runTest(name, fn);
        suiteRunData.tests.push({ name, passed: result.passed, error: result.error });
        if (result.passed) totalPassed++;
        else totalFailed++;
        return result.passed;
      };

      try {
        const modulePath = new URL(suite.file, import.meta.url).href;
        const module = await import(modulePath);

        // Expecting default export to be a function accepting runTest
        if (module.default && typeof module.default === 'function') {
          await module.default(capturingRunTest);
        } else {
          throw new Error(`no default export function in ${suite.file}`);
        }
      } catch (err) {
        // A suite that cannot load contributes zero assertions, so counting it
        // as anything but a failure lets coverage silently evaporate. Outside a
        // SquadJS install the suites importing SquadJS core land here.
        const why = err.code === 'ERR_MODULE_NOT_FOUND'
          ? `cannot resolve an import — ${err.message.split('\n')[0]}`
          : (err.stack || err.message || String(err));
        console.error(`${COLORS.RED}  [BROKEN SUITE] ${suite.name}: ${why}${COLORS.RESET}`);
        suiteRunData.tests.push({ name: `${suite.name} (suite load)`, passed: false, error: why });
        brokenSuites.push(suite.name);
        totalFailed++;
      }
      results[suite.name].push(suiteRunData);
      console.log('');
    }
  }

  console.log(`${COLORS.CYAN}=== EloTracker Summary ===${COLORS.RESET}`);
  console.log(`  Passed:  ${totalPassed}`);
  console.log(`  Failed:  ${totalFailed}`);
  if (brokenSuites.length > 0) {
    console.log(`${COLORS.RED}  Suites that failed to load: ${brokenSuites.join(', ')}${COLORS.RESET}`);
  }
  console.log(
    totalFailed === 0
      ? `${COLORS.GREEN}  Status: ALL PASSING${COLORS.RESET}`
      : `${COLORS.RED}  Status: HAS FAILURES${COLORS.RESET}`
  );

  try {
    // Next to this file, not in the CWD — the runner is invoked from the repo
    // root as often as from testing/.
    fs.writeFileSync(path.join(HERE, 'test-results.json'), JSON.stringify(results, null, 2));
  } catch (err) {
    console.error(`${COLORS.RED}Failed to save results:${COLORS.RESET}`, err);
  }

  if (totalFailed > 0) process.exitCode = 1;
  return { passed: totalPassed, failed: totalFailed };
}

// Execute if run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runAll();
}
