const { composePlugins, withNx } = require('@nx/webpack');
const path = require('path');
const TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin');

module.exports = composePlugins(withNx(), (config) => {
  // Fix for circular dependency issues in NestJS with TypeORM entities
  if (config.optimization) {
    config.optimization.concatenateModules = false;
    config.optimization.moduleIds = 'named';
    config.optimization.chunkIds = 'named';
    config.optimization.minimize = false;
  }

  // Ensure tsconfig paths are resolved (backend-common, event-contracts)
  if (!config.resolve) config.resolve = {};
  if (!config.resolve.plugins) config.resolve.plugins = [];

  // Only add if not already present
  const hasTsconfigPaths = config.resolve.plugins.some(
    (p) => p && p.constructor && p.constructor.name === 'TsconfigPathsPlugin'
  );
  if (!hasTsconfigPaths) {
    config.resolve.plugins.push(
      new TsconfigPathsPlugin({
        configFile: path.resolve(__dirname, 'tsconfig.json'),
      })
    );
  }

  return config;
});
