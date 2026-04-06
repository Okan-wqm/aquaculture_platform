const path = require('path');
const { withNestJS } = require('../../tools/webpack/nestjs-base.config');

module.exports = withNestJS((config) => {
  // IMPORTANT: st-worker.ts must be a separate entry point so piscina
  // can load it at runtime for Structured Text compilation.
  config.entry['st-worker'] = path.resolve(__dirname, 'src/automation/compiler/worker/st-worker.ts');
  return config;
});
