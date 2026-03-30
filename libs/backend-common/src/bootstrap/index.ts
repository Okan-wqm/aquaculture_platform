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
