import { DEFAULT_NATS_URL } from '@aquaculture/backend-common/nats';
import { ConfigService } from '@nestjs/config';

import type { EventBusModuleOptions } from './nats.module';

/**
 * Canonical NATS / event-bus defaults — the SINGLE source of truth.
 *
 * `DEFAULT_NATS_URL` is declared in backend-common's nats-connection.factory
 * (the connection layer) and re-exported here, because event-bus already
 * depends on backend-common — declaring it here instead would force
 * backend-common's nats-connection.factory to import event-bus, a cycle.
 * `DEFAULT_NATS_STREAM_NAME` is JetStream-layer and lives with the event bus.
 */
export { DEFAULT_NATS_URL };
export const DEFAULT_NATS_STREAM_NAME = 'AQUACULTURE_EVENTS';

/**
 * SSoT factory for `EventBusModule.forRootAsync` across every service.
 *
 * Replaces the inline `{ natsUrl: cs.get('NATS_URL', 'nats://localhost:4222'),
 * streamName: cs.get('NATS_STREAM_NAME', 'AQUACULTURE_EVENTS') }` object that was
 * hand-copied into 10 `app.module.ts`. Mirrors `createServiceTypeOrmConfig`
 * (`libs/backend-common/src/database/typeorm-config.factory.ts`): one
 * parameterized factory, a documented env contract, and production fail-fast.
 *
 * Env contract:
 *   NATS_URL          — server address (default: nats://localhost:4222;
 *                       REQUIRED to be a non-localhost address in production —
 *                       fail-fast at boot rather than running event-less)
 *   NATS_STREAM_NAME  — JetStream stream name (default: AQUACULTURE_EVENTS)
 *
 * Usage:
 *   EventBusModule.forRootAsync({
 *     imports: [ConfigModule],
 *     inject: [ConfigService],
 *     useFactory: buildEventBusConfig,
 *   })
 */
export function buildEventBusConfig(configService: ConfigService): EventBusModuleOptions {
  const url = configService.get<string>('NATS_URL', DEFAULT_NATS_URL);
  const streamName = configService.get<string>('NATS_STREAM_NAME', DEFAULT_NATS_STREAM_NAME);

  // RELIABILITY: never silently connect a production service to a localhost
  // broker. If NATS_URL is unset (or left at the localhost default) in
  // production, fail fast at boot rather than half-running without events.
  if (process.env['NODE_ENV'] === 'production' && url === DEFAULT_NATS_URL) {
    throw new Error(
      'NATS_URL must be set to a non-localhost address in production (event-bus config SSoT).',
    );
  }

  // `url` is the canonical EventBusModuleOptions field. (The previous inline
  // factories returned `natsUrl`, an excess property the consumer ignored —
  // NatsEventBus reads NATS_URL/NATS_STREAM_NAME from ConfigService directly;
  // see nats-event-bus.ts.)
  return { url, streamName };
}
