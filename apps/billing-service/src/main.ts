// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { bootstrapService } from '@aquaculture/backend-common/bootstrap';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'billing-service',
  portEnvVar: 'BILLING_SERVICE_PORT',
  hasGraphQL: true,
  nestFactoryOptions: { rawBody: true, bodyParser: true },
});
