// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { bootstrapService } from '@aquaculture/backend-common';
import { AppModule } from './app.module';
import { InternalApiKeyGuard } from './guards/internal-api-key.guard';

bootstrapService(AppModule, {
  serviceName: 'event-store-service',
  portEnvVar: 'EVENT_STORE_SERVICE_PORT',
  globalGuards: [new InternalApiKeyGuard()],
  additionalCorsHeaders: ['X-Internal-Api-Key'],
});
