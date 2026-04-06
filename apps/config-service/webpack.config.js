const path = require('path');
const TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin');
const { withNestJS } = require('../../tools/webpack/nestjs-base.config');

module.exports = withNestJS((config) => {
  if (!config.resolve) config.resolve = {};
  if (!config.resolve.plugins) config.resolve.plugins = [];

  const hasTsconfigPaths = config.resolve.plugins.some(
    (p) => p && p.constructor && p.constructor.name === 'TsconfigPathsPlugin',
  );
  if (!hasTsconfigPaths) {
    config.resolve.plugins.push(
      new TsconfigPathsPlugin({ configFile: path.resolve(__dirname, 'tsconfig.json') }),
    );
  }

  return config;
});
