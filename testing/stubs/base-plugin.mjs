// Test stub for SquadJS squad-server/plugins/base-plugin.js (option resolution only).
export default class BasePlugin {
  constructor(server, options, connectors) {
    this.server = server;
    this.options = {};
    this.rawOptions = options;

    for (const [name, option] of Object.entries(this.constructor.optionsSpecification)) {
      this.options[name] = option.connector
        ? connectors[this.rawOptions[name]]
        : (typeof this.rawOptions[name] !== 'undefined' ? this.rawOptions[name] : option.default);
    }
  }

  async prepareToMount() {}

  async mount() {}

  async unmount() {}
}
