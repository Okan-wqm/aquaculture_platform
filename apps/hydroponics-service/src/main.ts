// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { bootstrapService } from '@aquaculture/backend-common/bootstrap';
import { AppModule } from './app.module';

bootstrapService(AppModule, {
  serviceName: 'hydroponics-service',
  portEnvVar: 'HYDROPONICS_SERVICE_PORT',
  hasGraphQL: true,
  /** SEC-M12: Disable implicit type conversion to prevent type confusion attacks.
   *  Explicit @Type() decorators must be used on DTOs that need transformation. */
  validationPipeOverrides: { transformOptions: { enableImplicitConversion: false } },
});
