const { composePlugins, withNx } = require('@nx/webpack');

module.exports = composePlugins(withNx(), (config) => {
  // Fix for circular dependency issues in NestJS with TypeORM entities
  // These optimizations can cause "Cannot access 'x' before initialization" errors
  // when there are complex module interdependencies
  if (config.optimization) {
    config.optimization.concatenateModules = false;
    config.optimization.moduleIds = 'named';
    config.optimization.chunkIds = 'named';
    // Disable minimize to avoid variable renaming issues
    config.optimization.minimize = false;
  }

  return config;
});
