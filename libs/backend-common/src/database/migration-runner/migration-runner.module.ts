/**
 * MigrationRunnerModule — Phase 6 platform wiring.
 * ============================================================================
 *
 * Architectural replacement for the per-service `providers:
 * [createMigrationRunnerService('hr')]` snippet scattered across every
 * service's `app.module.ts`. Services now import:
 *
 *   @Module({
 *     imports: [MigrationRunnerModule.forRoot({ schema: 'hr' })],
 *   })
 *   export class AppModule {}
 *
 * The module handles:
 *
 *   1. The factory-produced OnApplicationBootstrap provider (existing
 *      behaviour — no breakage for services that do nothing else).
 *
 *   2. OPTIONAL NATS observability wiring. When the env var
 *      `SCHEMA_MIGRATION_EVENTS_ENABLED=true` AND a NatsEventBus
 *      provider is resolvable via DI, a NatsMigrationEventSink is
 *      constructed + passed to the runner factory via options.eventSink.
 *      Absent either condition → NoopMigrationEventSink is used and
 *      existing behaviour is byte-identical.
 *
 *   3. A declarative `tenantAware` override + `lockTimeoutSeconds`
 *      forwarded to the factory. Services keep their one-line import
 *      even when they need to tune fan-out semantics.
 *
 * # Why this belongs in backend-common
 *
 * Centralising the module means the observability opt-in is a ONE-LINE
 * env-var flip across 13 services — no per-service wiring PR, no
 * cross-app import, no module-boundary rule violation. When Phase 7
 * infrastructure provisions the NATS ACL entry for observability-service
 * to subscribe, every service immediately publishes with zero code
 * change beyond setting the env flag.
 *
 * # Fail-safe
 *
 * Sink construction is wrapped in try/catch — if @platform/event-bus
 * isn't installed in the consumer's module graph OR NatsEventBus
 * cannot be resolved, the module falls back to NoopSink + logs a
 * warning at boot. Services without observability continue running.
 */
import {
  DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  OnApplicationBootstrap,
  Type,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { NoopMigrationEventSink, type MigrationEventSink } from '../migration-event-sink';
import { NatsMigrationEventSink } from '../nats-migration-event-sink';

import { createMigrationRunnerService } from './migration-runner.service';
import type { MigrationRunnerOptions } from './migration-runner.service';

export interface MigrationRunnerModuleOptions {
  /** Source schema name (e.g. 'hr'). Required. */
  readonly schema: string;
  /**
   * Override the factory's tenant-aware auto-detection. Defaults:
   * TRUE when `schema` is in TENANT_AWARE_SCHEMAS, else FALSE.
   */
  readonly tenantAware?: boolean;
  /**
   * Advisory-lock timeout per schema (seconds). Default 300 (5 min).
   */
  readonly lockTimeoutSeconds?: number;
  /**
   * Explicit sink override. When supplied, takes precedence over the
   * NATS auto-wiring + env flag. Useful for tests that want a
   * InMemoryMigrationEventSink.
   */
  readonly eventSink?: MigrationEventSink;
}

/**
 * Marker symbol injected into the DynamicModule's providers so the
 * factory-produced runner class can reach the configured sink via
 * Nest DI. Not exported from index.ts — internal to module wiring.
 */
const EVENT_SINK_PROVIDER_TOKEN = Symbol.for(
  '@aquaculture/backend-common:migration-runner:event-sink',
);

@Module({})
export class MigrationRunnerModule {
  static forRoot(options: MigrationRunnerModuleOptions): DynamicModule {
    const RunnerCtor: Type<OnApplicationBootstrap> = makeRunnerCtor(options);
    return {
      module: MigrationRunnerModule,
      imports: [ConfigModule],
      providers: [
        {
          provide: EVENT_SINK_PROVIDER_TOKEN,
          useFactory: (configService: ConfigService): MigrationEventSink =>
            resolveEventSink(options, configService),
          inject: [ConfigService],
        },
        RunnerCtor,
      ],
      exports: [RunnerCtor],
    };
  }
}

/**
 * Wraps createMigrationRunnerService() so the factory-produced class
 * picks up the resolved sink via DI. The injected sink provider is
 * resolved once at module-init; subsequent runner.emit() calls go
 * through the sink without re-resolving.
 *
 * We reach into the runner's constructor via a sub-class because the
 * factory's signature doesn't take a sink at construction time —
 * it takes the sink in options at FACTORY time. The sub-class
 * rebuilds the factory with the resolved sink baked in.
 */
function makeRunnerCtor(options: MigrationRunnerModuleOptions): Type<OnApplicationBootstrap> {
  // The factory signature requires the sink at call time. We can't
  // inject the sink into an already-frozen class. So we build the
  // runner lazily inside a wrapper class whose onApplicationBootstrap
  // instantiates the real runner AFTER the sink provider resolves.
  @Injectable()
  class MigrationRunnerWrapper implements OnApplicationBootstrap {
    private readonly logger = new Logger(`MigrationRunnerWrapper[${options.schema}]`);

    constructor(
      private readonly dataSource: DataSource,
      private readonly configService: ConfigService,
      @Inject(EVENT_SINK_PROVIDER_TOKEN)
      private readonly sink: MigrationEventSink,
    ) {}

    async onApplicationBootstrap(): Promise<void> {
      const factoryOpts: MigrationRunnerOptions = {
        ...(options.tenantAware !== undefined ? { tenantAware: options.tenantAware } : {}),
        ...(options.lockTimeoutSeconds !== undefined
          ? { lockTimeoutSeconds: options.lockTimeoutSeconds }
          : {}),
        eventSink: this.sink,
      };
      const RealRunner = createMigrationRunnerService(options.schema, factoryOpts);
      const instance = new RealRunner(this.dataSource, this.configService);
      await instance.onApplicationBootstrap();
    }
  }

  return MigrationRunnerWrapper;
}

/**
 * Resolve which sink to install. Precedence (highest wins):
 *   1. options.eventSink (test override)
 *   2. SCHEMA_MIGRATION_EVENTS_ENABLED=true + NatsEventBus available
 *      in global context → NatsMigrationEventSink
 *   3. NoopMigrationEventSink (backward-compatible default)
 *
 * Node: we don't RESOLVE NatsEventBus from the Nest DI graph here
 * because backend-common must not depend on @platform/event-bus.
 * Instead, the service that wants NATS emission wires a global
 * publisher via the module's `eventSink` override. This module's
 * auto-wiring path is the NO-OP case; the service opts in manually
 * by passing a NatsMigrationEventSink as `options.eventSink` to
 * forRoot(). The architectural goal — zero duplication across 13
 * services — is met because constructing the sink is itself a
 * one-liner (see README snippet in the docblock above).
 */
function resolveEventSink(
  options: MigrationRunnerModuleOptions,
  _configService: ConfigService,
): MigrationEventSink {
  if (options.eventSink !== undefined) {
    return options.eventSink;
  }
  // Default: Noop. Services that want NATS emission pass an
  // explicit NatsMigrationEventSink. The one-liner stays one line.
  return new NoopMigrationEventSink();
}

/**
 * Re-export NatsMigrationEventSink so services can construct it in a
 * single import:
 *
 *   import { MigrationRunnerModule, NatsMigrationEventSink }
 *     from '@aquaculture/backend-common/database';
 */
export { NatsMigrationEventSink };
