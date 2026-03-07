const { composePlugins, withNx } = require('@nx/webpack');
const path = require('path');

module.exports = composePlugins(withNx(), (config) => {
  // Add st-worker.ts as a separate entry point so piscina can load it at runtime.
  // Without this, webpack bundles everything into main.js and st-worker.js is missing.
  config.entry['st-worker'] = path.resolve(__dirname, 'src/automation/compiler/worker/st-worker.ts');
  return config;
});
