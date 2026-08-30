// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { bootstrapService } from '@aquaculture/backend-common/bootstrap';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'config-service',
  portEnvVar: 'CONFIG_SERVICE_PORT',
  hasGraphQL: true,
  additionalCorsHeaders: ['X-Api-Key'],
  // Faz C (D6): bind the config.runtime.* request-reply handler. config-service
  // already opens a NATS connection for the config_outbox GDPR relay; this makes
  // startAllMicroservices register the ConfigRuntimeNatsHandler @MessagePattern
  // subscribers so billing can read effective config (incl. decrypted secrets).
  natsTransport: { queue: 'config-service' },
});
