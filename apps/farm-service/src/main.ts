// WHY: MUST be first import — see apps/admin-api-service/src/main.ts for full explanation.
import 'reflect-metadata';
import { bootstrapService } from '@aquaculture/backend-common/bootstrap';
import { AppModule } from './app.module';
import { FARM_INTERNAL_MARINE_PREFIX_EXCLUSIONS } from './marine-data/marine-data.controller';
import { RETIRED_SENTINEL_PREFIX_EXCLUSIONS } from './sentinel-hub/sentinel-hub-proxy.controller';

bootstrapService(AppModule, {
  serviceName: 'farm-service',
  // ADR-0006: reached only over the Docker network (gateway federation / NATS);
  // nginx proxies nothing here, so no CORS and no edge bundle.
  serviceVisibility: 'internal',
  portEnvVar: 'FARM_SERVICE_PORT',
  hasGraphQL: true,
  // The gateway signs and calls this internal binary surface at its explicit
  // /api/internal path. Exclude it (and the authenticated 410 tombstones) from
  // the default /api/v1 prefix so Nest does not silently expose
  // /api/v1/api/internal/... while the gateway calls /api/internal/....
  prefixExclusions: [
    'health',
    'health/(.*)',
    'metrics',
    ...FARM_INTERNAL_MARINE_PREFIX_EXCLUSIONS,
    ...RETIRED_SENTINEL_PREFIX_EXCLUSIONS,
  ],
  // Request-reply responder transport (queue group) so ai-service can invoke
  // farm actions (request.farm.createTask) over NATS instead of an HTTP hop.
  natsTransport: { queue: 'farm-service' },
});
