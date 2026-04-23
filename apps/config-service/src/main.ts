// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { bootstrapService } from '@aquaculture/backend-common/bootstrap';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'config-service',
  portEnvVar: 'CONFIG_SERVICE_PORT',
  hasGraphQL: true,
  additionalCorsHeaders: ['X-Api-Key'],
});
