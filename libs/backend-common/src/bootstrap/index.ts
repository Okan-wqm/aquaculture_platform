/**
 * Bootstrap module barrel export.
 *
 * Re-exports the shared NestJS application factory and its option types
 * so consumers can import from '@aquaculture/backend-common'.
 */
export {
  createServiceApp,
  bootstrapService,
  type ServiceBootstrapOptions,
} from './create-service-app';

export {
  mountEdgeHardening,
  resolveTrustProxy,
  type EdgeHardeningHost,
  type EdgeRequestHandler,
  type ServiceVisibility,
  type TrustProxySetting,
} from './edge-hardening';

export {
  sanitizeForLogging,
  truncateStack,
  logBootstrapError,
} from './safe-error-logger';
