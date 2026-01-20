const { composePlugins, withNx } = require('@nx/webpack');

module.exports = composePlugins(withNx(), (config) => {
  // Disable optimizations that cause circular dependency issues
  // with GraphQL types ("Cannot access 'X' before initialization" errors)
  if (config.optimization) {
    config.optimization.concatenateModules = false;
    // Disable minification to preserve variable declaration order
    config.optimization.minimize = false;
  }
  return config;
});
