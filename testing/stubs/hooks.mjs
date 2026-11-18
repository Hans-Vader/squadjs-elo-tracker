// Node resolve hook: swaps SquadJS-only modules for local test stubs.
const STUBS = {
  'core/logger.js': new URL('./logger.mjs', import.meta.url).href,
  'base-plugin.js': new URL('./base-plugin.mjs', import.meta.url).href
};

export async function resolve(specifier, context, next) {
  for (const [suffix, url] of Object.entries(STUBS)) {
    if (specifier.endsWith(suffix)) return { url, shortCircuit: true };
  }
  return next(specifier, context);
}
