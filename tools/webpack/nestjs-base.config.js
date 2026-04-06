/**
 * Shared NestJS Webpack Configuration
 *
 * WHY: NestJS uses TypeScript decorator metadata (design:paramtypes) for
 * dependency injection. Webpack's module concatenation optimization merges
 * module scopes, which can change evaluation order and cause decorator
 * metadata to resolve to `Object` instead of the actual class reference.
 * When this happens, NestJS reports "dependencies: [null, null, null]"
 * and the service crashes at startup.
 *
 * IMPORTANT: ALL backend services MUST use this config. Services that
 * skip it will eventually crash when their DI tree becomes complex enough
 * to trigger webpack's evaluation order bug.
 *
 * Usage in service webpack.config.js:
 *   const { withNestJS } = require('../../tools/webpack/nestjs-base.config');
 *   module.exports = withNestJS();
 *
 *   // With custom modifications:
 *   module.exports = withNestJS((config) => {
 *     config.entry['worker'] = './src/worker.ts';
 *     return config;
 *   });
 */
const { composePlugins, withNx } = require('@nx/webpack');

/**
 * Creates a webpack config with NestJS-safe optimizations.
 *
 * @param customizer - Optional function to further modify the config.
 *                     Receives the config object and must return it.
 * @returns Composed webpack config
 */
function withNestJS(customizer) {
  return composePlugins(withNx(), (config) => {
    // SECURITY: Disable optimizations that break NestJS DI metadata
    if (config.optimization) {
      // CRITICAL: concatenateModules merges module scopes, breaking
      // TypeScript's emitDecoratorMetadata evaluation order.
      // Without this, design:paramtypes resolves to [Object, Object, Object]
      // instead of [Reflector, ConfigService, JwtService].
      config.optimization.concatenateModules = false;

      // Named modules/chunks for debuggable stack traces in production
      config.optimization.moduleIds = 'named';
      config.optimization.chunkIds = 'named';

      // Disable minification to preserve variable declaration order.
      // Terser can reorder declarations which breaks "Cannot access
      // 'X' before initialization" in circular dependency scenarios.
      config.optimization.minimize = false;
    }

    // Apply service-specific customizations if provided
    if (typeof customizer === 'function') {
      return customizer(config);
    }

    return config;
  });
}

module.exports = { withNestJS };
