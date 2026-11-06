import { fileURLToPath } from 'url';
import { register } from 'node:module';
import fs from 'fs';

// Redirect SquadJS-core imports (base-plugin.js, core/logger.js) to testing/stubs/
// when the real files are absent — lets the tracker/database suites run from this
// repo instead of only inside a SquadJS deployment. See testing/dev-loader.mjs.
register('./dev-loader.mjs', import.meta.url);

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
    { name: 'EloClanGrouping', file: './test-clan-grouping.js' },
    { name: 'EloSessionManager', file: './test-elo-session-manager.js' },
    { name: 'EloDatabase', file: './test-elo-database.js' },
    { name: 'EloLookup', file: './test-elo-lookup.js' },
    { name: 'EloTracker', file: './test-elo-tracker.js' },
    { name: 'EloSimulation', file: './test-elo-simulation.js', iterations: 20 }
  ];

  const results = {};
  let totalPassed = 0;
  let totalFailed = 0;
  let suiteErrors = 0; // load failures / missing default export — these must also fail CI

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
        // Dynamic import allows the runner to work even if files are missing during dev
        const modulePath = new URL(suite.file, import.meta.url).href;
        const module = await import(modulePath);
        
        // Expecting default export to be a function accepting runTest
        if (module.default && typeof module.default === 'function') {
          await module.default(capturingRunTest);
        } else {
          suiteErrors++;
          console.log(`${COLORS.RED}  FAILED: No default export function found in ${suite.file}${COLORS.RESET}`);
        }
      } catch (err) {
        suiteErrors++;
        if (err.code === 'ERR_MODULE_NOT_FOUND') {
          console.log(`${COLORS.RED}  FAILED: Module missing (${suite.file}): ${err.message}${COLORS.RESET}`);
        } else {
          console.error(`${COLORS.RED}  Error loading suite:${COLORS.RESET}`, err);
        }
      }
      results[suite.name].push(suiteRunData);
      console.log('');
    }
  }

  console.log(`${COLORS.CYAN}=== All Tests Completed ===${COLORS.RESET}`);

  try {
    fs.writeFileSync('test-results.json', JSON.stringify(results, null, 2));
    console.log(`${COLORS.GREEN}Results saved to test-results.json${COLORS.RESET}`);
  } catch (err) {
    console.error(`${COLORS.RED}Failed to save results:${COLORS.RESET}`, err);
  }

  const color = totalFailed || suiteErrors ? COLORS.RED : COLORS.GREEN;
  console.log(
    `${color}Summary: ${totalPassed} passed, ${totalFailed} failed, ${suiteErrors} suite error(s)${COLORS.RESET}`
  );
  if (totalFailed || suiteErrors) {
    process.exitCode = 1; // fail the process so CI can gate on it
  }
}

// Execute if run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runAll();
}