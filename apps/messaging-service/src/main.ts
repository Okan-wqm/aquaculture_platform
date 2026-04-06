// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { bootstrapService } from '@aquaculture/backend-common';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'messaging-service',
  portEnvVar: 'PORT',
  hasGraphQL: true,
  natsTransport: { queue: 'messaging-service' },
  additionalCorsHeaders: ['X-User-Payload'],
});
