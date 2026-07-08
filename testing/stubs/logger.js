/**
 * Dev-harness stub for SquadJS core/logger.js.
 * Used ONLY when the real SquadJS logger cannot be resolved (i.e. running the
 * test suite from this repo instead of inside a SquadJS deployment).
 * Silent by default; set ELO_TEST_VERBOSE=1 to see log lines.
 */
class Logger {
  constructor() {
    this.verboseness = {};
  }

  verbose(module, verboseness, message, ...extras) {
    if (process.env.ELO_TEST_VERBOSE) {
      console.log(`[${module}][${verboseness}] ${message}`, ...extras);
    }
  }

  setVerboseness(module, verboseness) {
    this.verboseness[module] = verboseness;
  }

  setColor() {}

  setTimeStamps() {}
}

export default new Logger();
