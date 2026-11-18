// Test stub for SquadJS core/logger.js. Records messages so tests can assert on them.
export default {
  messages: [],
  verbose(module, level, message) {
    this.messages.push(String(message));
  }
};
