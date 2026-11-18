// Usage: node --import ./testing/stubs/register.mjs testing/run-all-tests.js [SuiteName]
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
