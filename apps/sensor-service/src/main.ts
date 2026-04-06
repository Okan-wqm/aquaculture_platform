// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import { ValidationError } from 'class-validator';
import { bootstrapService } from '@aquaculture/backend-common';
import { AppModule } from './app.module';

// ── Custom Validation Pipe ──
// Custom exceptionFactory replaces disableErrorMessages so that:
//   - validation details are always logged server-side (observability)
//   - client receives sanitized "Bad Request" in production (security)
const validationLogger = new Logger('ValidationPipe');
const isProduction = process.env['NODE_ENV'] === 'production';

const flattenErrors = (errors: ValidationError[], parent = ''): string[] => {
  const messages: string[] = [];
  for (const err of errors) {
    const prop = parent ? `${parent}.${err.property}` : err.property;
    if (err.constraints) {
      messages.push(...Object.values(err.constraints).map((c) => `${prop}: ${c}`));
    }
    if (err.children?.length) {
      messages.push(...flattenErrors(err.children, prop));
    }
  }
  return messages;
};

bootstrapService(AppModule, {
  serviceName: 'sensor-service',
  portEnvVar: 'SENSOR_SERVICE_PORT',
  enableTelemetry: true,
  hasGraphQL: true,
  natsTransport: { queue: 'sensor-service' },
  customValidationPipe: new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    exceptionFactory: (errors: ValidationError[]) => {
      const details = flattenErrors(errors);
      validationLogger.warn(`Validation failed: ${details.join(' | ')}`);
      if (isProduction) {
        return new BadRequestException('Bad Request');
      }
      return new BadRequestException(details);
    },
  }),
});
