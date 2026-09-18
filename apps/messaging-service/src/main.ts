// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { bootstrapService } from '@aquaculture/backend-common/bootstrap';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'messaging-service',
  // ADR-0006: reached only over the Docker network (gateway federation / NATS);
  // nginx proxies nothing here, so no CORS and no edge bundle.
  serviceVisibility: 'internal',
  portEnvVar: 'PORT',
  hasGraphQL: true,
  natsTransport: { queue: 'messaging-service' },
  additionalCorsHeaders: ['X-User-Payload'],
});
