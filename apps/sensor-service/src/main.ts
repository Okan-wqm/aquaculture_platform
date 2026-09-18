// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { BadRequestException, Logger, ValidationPipe } from '@nestjs/common';
import { ValidationError } from 'class-validator';
import { bootstrapService } from '@aquaculture/backend-common/bootstrap';
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
  // ADR-0006: nginx upstream (infrastructure/nginx/droplet.conf). The factory
  // requires TRUST_PROXY in production and mounts the access log on every request.
  serviceVisibility: 'public',
  portEnvVar: 'SENSOR_SERVICE_PORT',
  enableTelemetry: true,
  hasGraphQL: true,
  natsTransport: { queue: 'sensor-service' },
  // MQTT auth endpoints are infrastructure — Mosquitto's mosquitto-go-auth
  // plugin calls sensor-service over the Docker internal network to verify
  // credentials / ACLs / superuser claims. The plugin config (mosquitto-
  // production.conf + simulators/mosquitto-http-auth.conf) is locked to
  // the broker runtime and cannot participate in the application's API
  // versioning scheme. Excluding the mqtt/* routes from the api/v1 prefix
  // keeps sensor-service's HTTP controller path (`@Controller('mqtt')`)
  // and mosquitto's backend URIs (`/mqtt/auth`, `/mqtt/superuser`,
  // `/mqtt/acl`) in lockstep — the same rationale that exempts health
  // probes and metrics endpoints from the global prefix (see
  // DEFAULT_PREFIX_EXCLUSIONS in create-service-app.ts).
  //
  // Without this exclusion, mosquitto posted to `/mqtt/auth` but the
  // actual route was `/api/v1/mqtt/auth` — every MQTT auth attempt 404ed,
  // and the sensor-service reconnect loop climbed toward the 20-attempt
  // limit after every device reconnection (see 2026-04-14 log audit G9).
  // install/* and api/devices/* are the public device-provisioning surface:
  // the installer is fetched as https://<host>/install/<code> and the Rust edge
  // agent posts to /api/devices/activate (nginx forwards both verbatim). They
  // sit outside the /api/v1 prefix like mqtt/*; enforced by
  // tests/invariants/nginx-route-resolution.spec.ts.
  prefixExclusions: [
    'health',
    'health/(.*)',
    'metrics',
    'mqtt/(.*)',
    'install',
    'install/(.*)',
    'api/devices',
    'api/devices/(.*)',
  ],
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
