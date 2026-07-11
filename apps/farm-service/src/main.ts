// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { bootstrapService } from '@aquaculture/backend-common/bootstrap';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'farm-service',
  portEnvVar: 'FARM_SERVICE_PORT',
  hasGraphQL: true,
  // Request-reply responder transport (queue group) so ai-service can invoke
  // farm actions (request.farm.createTask) over NATS instead of an HTTP hop.
  natsTransport: { queue: 'farm-service' },
});
