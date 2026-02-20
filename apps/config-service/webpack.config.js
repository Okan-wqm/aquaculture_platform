const { composePlugins, withNx } = require('@nx/webpack');

module.exports = composePlugins(withNx(), (config) => {
  // Fix for circular dependency issues in NestJS with TypeORM entities
  if (config.optimization) {
    config.optimization.concatenateModules = false;
    config.optimization.moduleIds = 'named';
    config.optimization.chunkIds = 'named';
    config.optimization.minimize = false;
  }

  return config;
});
