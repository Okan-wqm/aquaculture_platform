import { ApolloFederationDriver, ApolloFederationDriverConfig } from '@nestjs/apollo';
import { Logger, Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, Reflector } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { join } from 'path';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformJwtModule } from '@aquaculture/backend-common/auth';
import { AuditedOperationModule } from '@aquaculture/backend-common/audit';
import { TenantErasureTargetModule } from '@aquaculture/backend-common/compliance';
import {
  createServiceTypeOrmConfig,
  isSchemaDdlOwnedByDbMigrate,
  RlsModule,
  getRlsExcludeTablesForService,
  SourceSchemaBootstrapService,
} from '@aquaculture/backend-common/database';
import { RolesGuard, ServiceIdentityGuard, TenantGuard, TenantPermissionGuard } from '@aquaculture/backend-common/guards';
import { RequestContextMiddleware } from '@aquaculture/backend-common/logging';
import { MetricsMiddleware } from '@aquaculture/backend-common/metrics';
import {
  CorrelationIdMiddleware,
  StripInternalHeadersMiddleware,
  TenantContextMiddleware,
  UserContextMiddleware,
  VerifiedUserAssertionMiddleware,
} from '@aquaculture/backend-common/middleware';
import { RedisModule, buildRedisOptions } from '@aquaculture/backend-common/redis';
import { CircuitBreakerModule } from '@aquaculture/backend-common/resilience';
import { EventBusModule, buildEventBusConfig } from '@platform/event-bus';
import depthLimit from 'graphql-depth-limit';
import { DocumentNode, GraphQLError, GraphQLSchema } from 'graphql';
import { fieldExtensionsEstimator, getComplexity, simpleEstimator } from 'graphql-query-complexity';

import { AutomationModule } from './automation/automation.module';
import {
  AutomationProgram,
  ProgramStep,
  StepAction,
  ProgramTransition,
  ProgramVariable,
} from './automation/entities';
import { DeploymentLog } from './automation/entities/deployment-log.entity';
import { DashboardModule } from './dashboard/dashboard.module';
import { DashboardLayout } from './dashboard/entities/dashboard-layout.entity';
import { SensorDataChannel } from './database/entities/sensor-data-channel.entity';
import { SensorProtocol } from './database/entities/sensor-protocol.entity';
import { SensorReading } from './database/entities/sensor-reading.entity';
import { ChannelDetectionLog } from './database/entities/channel-detection-log.entity';
import { IndustryTemplate } from './database/entities/industry-template.entity';
import { Sensor } from './database/entities/sensor.entity';
import { SensorTypeDefinition } from './database/entities/sensor-type-definition.entity';
import { EdgeDeviceModule } from './edge-device/edge-device.module';
import { DeviceIoConfig } from './edge-device/entities/device-io-config.entity';
import { EdgeDevice } from './edge-device/entities/edge-device.entity';
import {
  EdgeAuditArchiveV2,
  EdgeDeviceV2,
  EdgeFirmwareReleaseV2,
  EdgeLicenseV2,
  EdgePolicyV2,
  EdgeProvisioningRecordV2,
  EdgeWitnessV2,
} from './edge-device/entities/v2';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { HealthModule } from './health/health.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { SensorMetricsModule } from './metrics/metrics.module';
import { ScadaRuntimeModule } from './scada-runtime/scada-runtime.module';
import { SensorOutboxModule } from './outbox/sensor-outbox.module';
import { SensorOutbox } from './outbox/sensor-outbox.entity';
import {
  createTenantConnectionBootstrap,
  createSchemaVersionGate,
  TenantSchemaSyncService,
  SchemaDriftModule,
  TenantSchemaCacheModule,
} from '@aquaculture/backend-common/database';
import { TenantExecutionContextModule } from '@aquaculture/backend-common/context';
import { createTenantSchemaMiddleware } from '@aquaculture/backend-common/middleware';
const TenantSchemaMiddleware = createTenantSchemaMiddleware('sensor');
const TenantConnectionBootstrap = createTenantConnectionBootstrap('sensor');
const SensorSchemaVersionGate = createSchemaVersionGate('sensor');
/**
 * PR#363 port — runtime DDL authority gate. In authoritative deployments
 * the per-tenant RLS sweep belongs to aqua-db-migrate's tenant fan-out
 * hardening (SCHEMA_REGISTRY['sensor'].postMigrationHardening); local/dev
 * keeps syncTenantSchemas as the historical bootstrap convenience.
 */
const sensorSchemaDdlOwnedByDbMigrate = isSchemaDdlOwnedByDbMigrate(process.env);

type QueryComplexityOperationContext = {
  request: {
    operationName?: string;
    variables?: Record<string, unknown>;
  };
  document: DocumentNode;
  schema: GraphQLSchema;
};
import { DeployArtifact } from './deploy-artifact/entities/deploy-artifact.entity';
import { ReleaseBundle } from './release-bundle/entities/release-bundle.entity';
import { Process } from './process/entities/process.entity';
import { ScadaPackage } from './process/entities/scada-package.entity';
import { UnifiedTag } from './process/entities/unified-tag.entity';
import { ScadaDeployLog } from './process/entities/scada-deploy-log.entity';
import { ProcessModule } from './process/process.module';
import { ProtocolModule } from './protocol/protocol.module';
import { RegistrationModule } from './registration/registration.module';
import { SensorTypeModule } from './sensor-type/sensor-type.module';
import { SensorModule } from './sensor/sensor.module';
import { SharedMqttModule } from './shared-mqtt/shared-mqtt.module';
import { VfdDevice } from './vfd/entities/vfd-device.entity';
import { VfdReading } from './vfd/entities/vfd-reading.entity';
import { VfdRegisterMapping } from './vfd/entities/vfd-register-mapping.entity';
import { VfdModule } from './vfd/vfd.module';
import {
  VfdParameterDefinition,
  VfdChangeSet,
  VfdChangeSetItem,
  VfdParameterAuditLog,
  VfdAutomationRule,
} from './vfd-programming/entities';
import { VfdProgrammingModule } from './vfd-programming/vfd-programming.module';
import { DeviceGroupModule } from './device-group/device-group.module';
import { DeviceGroup } from './device-group/entities/device-group.entity';
import { DeviceGroupMember } from './device-group/entities/device-group-member.entity';
import { PlcControlModule } from './plc-control/plc-control.module';
import { StreamProcessingModule } from './stream-processing/stream-processing.module';
import { PlcConnection } from './plc-control/entities/plc-connection.entity';
import { FeedingParameter } from './plc-control/entities/feeding-parameter.entity';
import { PlcAlarm } from './plc-control/entities/plc-alarm.entity';
import { PlcTelemetry } from './plc-control/entities/plc-telemetry.entity';
// Migration class imports removed — TypeOrmModule now uses the glob
// pattern '/database/migrations/[0-9]*.{js,ts}' to load every timestamped
// migration on disk while excluding support files from TypeORM's migration
// loader. See ORPHAN-HIGH-001 cure note in migrations: array below.
import { CredentialVaultModule } from './infrastructure/vault/credential-vault.module';
import { AuditModule } from './infrastructure/audit/audit.module';
import { AuditLog } from './infrastructure/audit/audit-log.entity';
import { AuditSubscriber } from './infrastructure/audit/audit.subscriber';
import { LoRaDevice } from './edge-device/entities/lora-device.entity';
import { TenantProvisioningKey } from './edge-device/entities/tenant-provisioning-key.entity';
import { DeviceEvent } from './edge-device/entities/device-event.entity';

@Module({
  imports: [
    // Global configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '.env.local'],
      cache: true,
    }),
    // CIRCUIT-LOW-002 cure: register the canonical
    // CircuitBreakerService at the @Global module level so the
    // sensor-protocol HttpRestAdapter and the channel-detection
    // service can constructor-inject it without per-feature-module
    // re-imports. Same pattern admin-api uses for CIRCUIT-LOW-001.
    CircuitBreakerModule,

    // Database connection — sensor-service owns the 'sensor' schema (over
    // TimescaleDB). Uses the platform TypeORM factory.
    // INTENTIONAL: no `schema:` — TenantConnectionBootstrap manages
    // search_path per request.
    //
    // MEDIUM-006: pool sized 50 / min 10 / idle 5min for continuous MQTT
    // ingestion — connection cold-starts during burst ingest cause
    // >100ms tail-latency spikes. Idle 5min prevents pool churn between
    // bursts. Operators may further tune via DATABASE_POOL_* env vars.
    //
    // Legacy TIMESCALE_* env-var fallbacks were removed — they were not
    // set anywhere in the platform (compose / helm / .env). Operator
    // config flows through DATABASE_* uniformly.
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        createServiceTypeOrmConfig(configService, {
          serviceName: 'sensor',
          schema: 'sensor',
          defaultPoolSize: 50,
          defaultPoolMin: 10,
          defaultPoolIdleTimeoutMs: 300_000,
          subscribers: [AuditSubscriber],
          entities: [
            // SensorOutbox must be in TypeORM metadata: this service passes an
            // explicit entities list, so autoLoadEntities is off and OutboxModule.
            // forFeature() alone does not register the entity. Without it the new
            // OutboxNotifyListener.onModuleInit getMetadata(SensorOutbox) throws
            // ("No metadata for SensorOutbox"), crash-looping sensor-service boot.
            SensorOutbox,
            Sensor,
            SensorReading,
            SensorProtocol,
            SensorDataChannel,
            VfdDevice,
            VfdReading,
            VfdRegisterMapping,
            Process,
            ScadaPackage,
            DashboardLayout,
            EdgeDevice,
            EdgeDeviceV2,
            EdgePolicyV2,
            EdgeLicenseV2,
            EdgeFirmwareReleaseV2,
            EdgeProvisioningRecordV2,
            EdgeWitnessV2,
            EdgeAuditArchiveV2,
            DeviceIoConfig,
            LoRaDevice,
            TenantProvisioningKey,
            DeviceEvent,
            AutomationProgram,
            ProgramStep,
            StepAction,
            ProgramTransition,
            ProgramVariable,
            DeploymentLog,
            PlcConnection,
            FeedingParameter,
            PlcAlarm,
            PlcTelemetry,
            SensorTypeDefinition,
            IndustryTemplate,
            ChannelDetectionLog,
            UnifiedTag,
            ScadaDeployLog,
            DeployArtifact,
            ReleaseBundle,
            DeviceGroup,
            DeviceGroupMember,
            VfdParameterDefinition,
            VfdChangeSet,
            VfdChangeSetItem,
            VfdParameterAuditLog,
            VfdAutomationRule,
            AuditLog,
          ],
          // ORPHAN-HIGH-001 cure (sensor-service leg): switched to glob
          // pattern so every migration in the directory is registered.
          // Pre-fix the explicit array missed 6 of 15 on-disk migrations
          // (CreateSensorMetrics, CreateContinuousAggregates,
          // CreateReadingsAggregates, CreateEdgeDevicesTable,
          // AddSensorMetricsCompositeIndex, CreateScadaTables) — schema
          // state lagged the entity declarations on every fresh deploy.
          migrations: [__dirname + '/database/migrations/[0-9]*.{js,ts}'],
          // Single-writer deploy contract: aqua-db-migrate owns production
          // migrations. Local/E2E can still opt in explicitly.
          migrationsRunFromEnv: (cfg) =>
            cfg.get<string>('DATABASE_MIGRATIONS_RUN', 'false') === 'true',
        }),
    }),

    // GraphQL Federation
    GraphQLModule.forRootAsync<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const logger = new Logger('GraphQLModule');
        const maxDepth = configService.get<number>('GRAPHQL_MAX_DEPTH', 10);
        const maxComplexity = configService.get<number>('GRAPHQL_MAX_COMPLEXITY', 1000);

        return {
          autoSchemaFile: {
            federation: 2,
            path: join(process.cwd(), 'dist/graphql/subgraphs/sensor.graphql'),
          },
          /** SEC-M21: Disable GraphQL query batching to prevent batch-based brute-force attacks.
           *  The gateway already blocks batching, but subgraphs must also enforce this as
           *  defense-in-depth in case a subgraph becomes directly accessible. */
          allowBatchedHttpRequests: false,
          /**
           * Keep Apollo CSRF prevention explicit as defense in depth against
           * cross-site search and simple-request execution paths.
           */
          csrfPrevention: true,
          playground: false,
          graphiql: process.env['NODE_ENV'] !== 'production',
          buildSchemaOptions: {
            // VFD entities and their nested types are registered via @ObjectType decorators
            // This ensures proper schema composition in Apollo Federation
            orphanedTypes: [],
          },
          // 2026-04-30: Deprecated GraphQL Playground is not enabled at runtime.
          // WHY: sensor subgraph developer UI must not rely on deprecated Apollo Playground behavior.
          // SECURITY: Disable introspection in production
          introspection: configService.get('NODE_ENV') !== 'production',
          context: ({ req }: { req: unknown }) => ({ req }),

          // SECURITY: Query depth limiting to prevent DoS via deeply nested queries
          validationRules: [depthLimit(maxDepth)],

          // SECURITY: Query complexity limiting to prevent DoS via expensive queries
          plugins: [
            {
              requestDidStart: async () => ({
                async didResolveOperation({
                  request,
                  document,
                  schema,
                }: QueryComplexityOperationContext) {
                  const complexity = getComplexity({
                    schema,
                    operationName: request.operationName,
                    query: document,
                    variables: request.variables,
                    estimators: [
                      fieldExtensionsEstimator(),
                      simpleEstimator({ defaultComplexity: 1 }),
                    ],
                  });

                  if (complexity > maxComplexity) {
                    logger.warn(`Query complexity ${complexity} exceeds max ${maxComplexity}`);
                    throw new GraphQLError(
                      `Query too complex: ${complexity}. Maximum allowed: ${maxComplexity}`,
                      {
                        extensions: { code: 'QUERY_COMPLEXITY_EXCEEDED' },
                      },
                    );
                  }

                  logger.debug(`Query complexity: ${complexity}`);
                },
              }),
            },
          ],
        };
      },
    }),

    // Event Bus Module
    EventBusModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: buildEventBusConfig,
    }),
    SensorOutboxModule,
    TenantErasureTargetModule.forService('sensor-service'),

    // SECURITY (CRITICAL-001): RS256 asymmetric verification via the shared
    // PlatformJwtModule. sensor-service is a token CONSUMER, not an issuer.
    // Replaced the per-service JwtModule.registerAsync block (WS2.B,
    // 2026-04-14) — single source of truth for all consumer services.
    PlatformJwtModule,

    // AUDITTRAIL-CRITICAL-002 sweep — registers AuditedOperationInterceptor
    // as APP_INTERCEPTOR.
    AuditedOperationModule.forRoot(),

    // Scheduler for @Interval/@Cron decorators (deployment timeout check, etc.)
    ScheduleModule.forRoot(),

    // Event Emitter — single forRoot() for the entire service
    EventEmitterModule.forRoot(),

    /**
     * RedisModule is @Global — registered once here at the app level.
     * All feature modules (IngestionModule, etc.) access Redis via DI
     * without needing to re-import RedisModule.forRootAsync().
     */
    RedisModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        buildRedisOptions(configService, 'sensor-service', 'optional'),
    }),

    // Enterprise infrastructure (@Global modules - must be before feature modules)
    CredentialVaultModule,
    AuditModule,

    // Shared MQTT module (@Global - provides MqttClientService everywhere)
    SharedMqttModule,

    // Feature modules
    SensorModule,
    HealthModule,

    /**
     * SECURITY (HIGH-004): Tenant Row-Level Security (schema-per-tenant).
     * sensor-service data lives in per-tenant schemas created via
     * CREATE TABLE LIKE INCLUDING ALL, which does NOT copy RLS policies.
     * syncTenantSchemas makes RlsModule iterate every tenant_<uuid> schema
     * at OnApplicationBootstrap and install the canonical policy on each.
     */
    RlsModule.forPoolService({
      serviceName: 'sensor',
      // PR#363 port: runtime per-tenant RLS sweep only when db-migrate is
      // NOT authoritative — production tenants get the same policies from
      // the db-migrate tenant fan-out hardening.
      syncTenantSchemas: !sensorSchemaDdlOwnedByDbMigrate,
      excludeTables: getRlsExcludeTablesForService('sensor'),
    }),

    // Prometheus metrics (per-service /metrics endpoint)
    SensorMetricsModule,

    // Protocol and Registration modules
    ProtocolModule.forRoot(),
    RegistrationModule,

    // VFD (Variable Frequency Drive) module
    VfdModule,

    // VFD Programming module (remote parameter programming, Maker-Checker workflow)
    VfdProgrammingModule,

    // Data ingestion module (MQTT listener, data processing)
    IngestionModule,

    // SCADA operator runtime: the /scada WebSocket gateway (tag subscribe /
    // write / alarm ack), tag manager, alarm engine, DAQ storage. Without
    // this import the entire control plane is dead code — the gateway never
    // mounts and operator screens connect to nothing (SENSOR-HIGH-045).
    ScadaRuntimeModule,

    // Process module for equipment connection diagrams
    ProcessModule,

    // Dashboard layout persistence module
    DashboardModule,

    // Edge device management module (Industrial IoT)
    EdgeDeviceModule,

    // Automation module for IEC 61131-3 SFC programs
    AutomationModule,

    // PLC Control module for OPC UA based PLC communication
    PlcControlModule,

    // Sensor type definitions and industry templates
    SensorTypeModule,

    // Device group management and batch operations
    DeviceGroupModule,

    // Real-time stream processing (anomaly detection, rate-of-change, Kafka)
    StreamProcessingModule,

    /** P11 of 2026-04-14 teardown — runtime schema-drift validator. */
    // Tenant execution context interceptor (SSoT registration) — keeps the
    // validated tenant schema in AsyncLocalStorage across Apollo/CQRS async
    // boundaries so per-tenant search_path routing holds at pg checkout.
    TenantExecutionContextModule,
    // Shared tenant schema-existence cache + TenantProvisioned invalidation
    // (no stale-negative-cache block for freshly provisioned tenants).
    TenantSchemaCacheModule,
    SchemaDriftModule.forRoot({ serviceName: 'sensor' }),
  ],
  providers: [
    SensorSchemaVersionGate,
    // Global exception filter
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    // SECURITY: Service identity guard - validates HMAC-signed service identity headers
    // Must be FIRST guard (before tenant/roles) to verify request origin
    // WHY: useFactory bypasses reflect-metadata resolution which fails in Docker Alpine.
    {
      provide: APP_GUARD,
      useFactory: (configService: ConfigService): ServiceIdentityGuard =>
        new ServiceIdentityGuard(configService, undefined, 'sensor-service'),
      inject: [ConfigService],
    },
    // Tenant guard - ensures tenant isolation
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector, configService: ConfigService): TenantGuard =>
        new TenantGuard(reflector, undefined, configService),
      inject: [Reflector, ConfigService],
    },
    // SECURITY: Roles guard - enforces @Roles() decorator authorization
    // Without this, @Roles decorators would have no effect!
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector): RolesGuard => new RolesGuard(reflector),
      inject: [Reflector],
    },
    // SENSOR-HIGH-022: fine-grained tenant permission guard. It is opt-in — a
    // handler with no @RequireTenantPermission passes through untouched — so a
    // global registration is safe and makes every @RequireTenantPermission
    // (e.g. 'edge:manage-io-config') self-enforcing instead of dead metadata.
    {
      provide: APP_GUARD,
      useFactory: (reflector: Reflector): TenantPermissionGuard =>
        new TenantPermissionGuard(reflector),
      inject: [Reflector],
    },
    // Bootstrap source schema tables on startup (creates template tables if missing)
    SourceSchemaBootstrapService,
    // Pool-level tenant schema routing (patches pg Pool.connect for search_path injection)
    TenantConnectionBootstrap,
    // Auto-sync tenant schemas with source schema (creates missing tables/columns)
    TenantSchemaSyncService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // SEC-CRITICAL-002 sweep — strips forged internal headers when the request
    // lacks a valid x-service-identity HMAC. Safe on every route (only deletes
    // spoofable headers), so it + metrics stay on '*'.
    consumer.apply(StripInternalHeadersMiddleware, MetricsMiddleware).forRoutes('*');

    // SEC-HIGH-156 — resolve req.user/req.tenantId from the gateway-signed
    // verified-user assertion (runs after Strip sets req.verifiedIdentity,
    // before UserContext). EXCLUDED from the MQTT auth routes
    // (edge-device/mqtt-auth.controller.ts): Mosquitto's go-auth plugin calls
    // /mqtt/{auth,superuser,acl} with NO gateway service identity, so requiring
    // one there would 500 the broker. Both the prefix-stripped (/mqtt/*) and any
    // prefixed form are excluded to fail safe.
    consumer
      .apply(VerifiedUserAssertionMiddleware)
      // Non-gateway public surfaces that carry NO gateway service identity and
      // would otherwise 400 in production (requiresServiceIdentity):
      //  - /mqtt/*           Mosquitto go-auth plugin (edge-device/mqtt-auth.controller)
      //  - /install/*, /api/devices/*  edge-device provisioning + activation,
      //    called DIRECTLY by edge agents (nginx proxies these to sensor,
      //    bypassing the gateway — edge-device/provisioning.controller, @Public()).
      // Both prefix-stripped and api/v1-prefixed forms are excluded to fail safe.
      .exclude(
        'mqtt',
        'mqtt/{*path}',
        'api/v1/mqtt',
        'api/v1/mqtt/{*path}',
        'install',
        'install/{*path}',
        'api/v1/install',
        'api/v1/install/{*path}',
        'api/devices',
        'api/devices/{*path}',
        'api/v1/api/devices',
        'api/v1/api/devices/{*path}',
      )
      .forRoutes('*');

    consumer
      .apply(
        CorrelationIdMiddleware,
        RequestContextMiddleware, // Populate AsyncLocalStorage for structured logging
        UserContextMiddleware,
        TenantContextMiddleware,
        TenantSchemaMiddleware, // Sets PostgreSQL search_path to tenant schema
      )
      .forRoutes('*');
  }
}
