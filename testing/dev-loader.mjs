/**
 * ESM resolve hook for the dev test harness.
 *
 * The production modules import SquadJS core files by relative path
 * ('./base-plugin.js', '../../core/logger.js') that only exist inside a
 * SquadJS deployment. When running the test suite from this repo those
 * imports fail to resolve; this hook falls back to the stubs in
 * testing/stubs/ — ONLY on resolution failure, so inside a real deployment
 * the genuine SquadJS modules always win.
 */
const STUBS = [
  { suffix: 'base-plugin.js', stub: new URL('./stubs/base-plugin.js', import.meta.url).href },
  { suffix: 'core/logger.js', stub: new URL('./stubs/logger.js', import.meta.url).href }
];

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err && err.code === 'ERR_MODULE_NOT_FOUND') {
      for (const { suffix, stub } of STUBS) {
        if (specifier.endsWith(suffix) && !specifier.includes('/stubs/')) {
          return nextResolve(stub, context);
        }
      }
    }
    throw err;
  }
}
