// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { bootstrapService } from '@aquaculture/backend-common/bootstrap';
import { AppModule } from './app.module';
import { InternalApiKeyGuard } from './guards/internal-api-key.guard';

bootstrapService(AppModule, {
  serviceName: 'event-store-service',
  portEnvVar: 'EVENT_STORE_SERVICE_PORT',
  // Internal-only service: every endpoint is gated by InternalApiKeyGuard
  // and the only consumers are other backend services using the
  // X-Internal-Api-Key header. No browser ever talks to this service —
  // CORS preflight is impossible by design — so the shared bootstrap skips
  // configureCors() entirely instead of requiring a synthetic CORS_ORIGINS
  // env var to bypass the production hard-fail.
  serviceVisibility: 'internal',
  globalGuards: [new InternalApiKeyGuard()],
  // Header retained for documentation/discovery; ignored when CORS is skipped
  // but kept so the field stays visible during a future visibility audit.
  additionalCorsHeaders: ['X-Internal-Api-Key'],
});
