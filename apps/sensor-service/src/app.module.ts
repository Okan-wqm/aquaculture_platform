import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { Module, NestModule, MiddlewareConsumer, Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { GraphQLModule } from '@nestjs/graphql';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import {
  UserContextMiddleware,
  TenantContextMiddleware,
  CorrelationIdMiddleware,
  RequestContextMiddleware,
  MetricsMiddleware,
  TenantGuard,
  RolesGuard,
  SourceSchemaBootstrapService,
} from '@platform/backend-common';
import { EventBusModule } from '@platform/event-bus';
import depthLimit from 'graphql-depth-limit';
import { GraphQLError } from 'graphql';
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
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { HealthModule } from './health/health.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { SensorMetricsModule } from './metrics/metrics.module';
import { TenantSchemaMiddleware } from './middleware/tenant-schema.middleware';
import { TenantConnectionBootstrap } from './infrastructure/tenant-connection-bootstrap.service';
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
import { DeviceGroupModule } from './device-group/device-group.module';
import { DeviceGroup } from './device-group/entities/device-group.entity';
import { DeviceGroupMember } from './device-group/entities/device-group-member.entity';
import { PlcControlModule } from './plc-control/plc-control.module';
import { PlcConnection } from './plc-control/entities/plc-connection.entity';
import { FeedingParameter } from './plc-control/entities/feeding-parameter.entity';
import { PlcAlarm } from './plc-control/entities/plc-alarm.entity';
import { PlcTelemetry } from './plc-control/entities/plc-telemetry.entity';
import { CreateDynamicSensorTypes1740200000000 } from './database/migrations/1740200000000-CreateDynamicSensorTypes';
import { CreateProcessesTable1740300000000 } from './database/migrations/1740300000000-CreateProcessesTable';
import { CreateAutomationTables1740300001000 } from './database/migrations/1740300001000-CreateAutomationTables';
import { AddEnterprisePlcConnectionFields1741100000000 } from './database/migrations/1741100000000-AddEnterprisePlcConnectionFields';
import { EnterprisePerformanceOptimizations1741200000000 } from './database/migrations/1741200000000-EnterprisePerformanceOptimizations';
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

    // Database connection with schema separation
    // sensor-service owns the 'sensor' schema - uses TimescaleDB (PostgreSQL extension)
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        // SECURITY: Fail fast in production if database password is not configured
        const dbPassword = configService.get<string>('DATABASE_PASSWORD') || configService.get<string>('TIMESCALE_PASSWORD');
        if (!dbPassword && process.env['NODE_ENV'] === 'production') {
          throw new Error('SECURITY: DATABASE_PASSWORD or TIMESCALE_PASSWORD must be set in production');
        }
        return {
        type: 'postgres',
        host: configService.get('DATABASE_HOST') || configService.get('TIMESCALE_HOST') || 'localhost',
        port: configService.get<number>('DATABASE_PORT') || configService.get<number>('TIMESCALE_PORT') || 5432,
        username: configService.get('DATABASE_USER') || configService.get('TIMESCALE_USER') || 'postgres',
        password: dbPassword || 'postgres',
        database: configService.get('DATABASE_NAME') || configService.get('TIMESCALE_DATABASE') || 'aquaculture',
        // Schema is now dynamic - set via search_path in TenantSchemaMiddleware
        // schema: undefined - entities should not specify schema, it comes from search_path
        // Explicit entity list required for webpack bundle (glob patterns don't work)
        entities: [
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
          DeviceIoConfig,
          LoRaDevice,
          TenantProvisioningKey,
          DeviceEvent,
          // Automation entities (IEC 61131-3)
          AutomationProgram,
          ProgramStep,
          StepAction,
          ProgramTransition,
          ProgramVariable,
          DeploymentLog,
          // PLC Control entities (OPC UA)
          PlcConnection,
          FeedingParameter,
          PlcAlarm,
          PlcTelemetry,
          // Dynamic sensor type entities
          SensorTypeDefinition,
          IndustryTemplate,
          ChannelDetectionLog,
          // Unified SCADA entities
          UnifiedTag,
          ScadaDeployLog,
          // Device group entities
          DeviceGroup,
          DeviceGroupMember,
          // Audit trail
          AuditLog,
        ],
        migrations: [
          CreateDynamicSensorTypes1740200000000,
          CreateProcessesTable1740300000000,
          CreateAutomationTables1740300001000,
          AddEnterprisePlcConnectionFields1741100000000,
          EnterprisePerformanceOptimizations1741200000000,
        ],
        // When sync is on (initial deploy), skip migrations to avoid index conflicts.
        // When sync is off (production), run migrations for structural changes.
        synchronize: configService.get('DATABASE_SYNC', 'false') === 'true',
        migrationsRun: configService.get('DATABASE_SYNC', 'false') !== 'true',
        logging: configService.get('DATABASE_LOGGING', 'false') === 'true',
        subscribers: [AuditSubscriber],
        // SECURITY: SSL configuration with proper certificate validation
        ssl: (() => {
          const sslEnabled = configService.get('DATABASE_SSL') === 'true';
          if (!sslEnabled) return false;

          const isProduction = configService.get('NODE_ENV') === 'production';
          const caPath = configService.get<string>('DATABASE_SSL_CA');
          const rejectUnauthorized = configService.get('DATABASE_SSL_REJECT_UNAUTHORIZED', 'true') !== 'false';

          if (isProduction && !rejectUnauthorized && !caPath) {
            console.warn(
              '⚠️  WARNING: SSL certificate verification disabled in production! ' +
              'Set DATABASE_SSL_CA for proper security.',
            );
          }

          return {
            rejectUnauthorized,
            ...(caPath ? { ca: require('fs').readFileSync(caPath) } : {}),
          };
        })(),
        extra: {
          // Connection pool optimized for time-series / continuous ingestion (MEDIUM-006)
          // max: 50 handles concurrent MQTT ingestion + HTTP requests + health checks
          max: configService.get<number>('DATABASE_POOL_SIZE', 50),
          // min: 10 keeps warm connections for continuous ingestion (avoids cold-start latency)
          min: configService.get<number>('DATABASE_POOL_MIN', 10),
          // 5 minutes — prevents churn during continuous MQTT ingestion
          idleTimeoutMillis: configService.get<number>('DATABASE_IDLE_TIMEOUT_MS', 300000),
          connectionTimeoutMillis: 5000,
          // Default search_path targets the source schema so TypeORM sync/migrations
          // create tables there. TenantSchemaMiddleware overrides per-request.
          options: '-c search_path=sensor,public',
        },
      };
      },
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
          },
          buildSchemaOptions: {
            // VFD entities and their nested types are registered via @ObjectType decorators
            // This ensures proper schema composition in Apollo Federation
            orphanedTypes: [],
          },
          playground: configService.get('NODE_ENV') !== 'production',
          // SECURITY: Disable introspection in production
          introspection: configService.get('NODE_ENV') !== 'production',
          context: ({ req }: { req: unknown }) => ({ req }),

          // SECURITY: Query depth limiting to prevent DoS via deeply nested queries
          validationRules: [depthLimit(maxDepth)],

          // SECURITY: Query complexity limiting to prevent DoS via expensive queries
          plugins: [
            {
              requestDidStart: async () => ({
                async didResolveOperation({ request, document, schema }) {
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
                    logger.warn(
                      `Query complexity ${complexity} exceeds max ${maxComplexity}`,
                    );
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
      useFactory: (configService: ConfigService) => ({
        natsUrl: configService.get<string>('NATS_URL', 'nats://localhost:4222'),
        streamName: configService.get<string>('NATS_STREAM_NAME', 'AQUACULTURE_EVENTS'),
      }),
    }),

    // JWT Module for auth guards (global for all feature modules)
    JwtModule.registerAsync({
      global: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: configService.get('JWT_EXPIRES_IN', '1d') },
      }),
    }),

    // Scheduler for @Interval/@Cron decorators (deployment timeout check, etc.)
    ScheduleModule.forRoot(),

    // Enterprise infrastructure (@Global modules - must be before feature modules)
    CredentialVaultModule,
    AuditModule,

    // Shared MQTT module (@Global - provides MqttClientService everywhere)
    SharedMqttModule,

    // Feature modules
    SensorModule,
    HealthModule,

    // Prometheus metrics (per-service /metrics endpoint)
    SensorMetricsModule,

    // Protocol and Registration modules
    ProtocolModule.forRoot(),
    RegistrationModule,

    // VFD (Variable Frequency Drive) module
    VfdModule,

    // Data ingestion module (MQTT listener, data processing)
    IngestionModule,

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
  ],
  providers: [
    // Global exception filter
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    // Tenant guard - ensures tenant isolation
    {
      provide: APP_GUARD,
      useClass: TenantGuard,
    },
    // SECURITY: Roles guard - enforces @Roles() decorator authorization
    // Without this, @Roles decorators would have no effect!
    {
      provide: APP_GUARD,
      useClass: RolesGuard,
    },
    // Bootstrap source schema tables on startup (creates template tables if missing)
    SourceSchemaBootstrapService,
    // Pool-level tenant schema routing (patches pg Pool.connect for search_path injection)
    TenantConnectionBootstrap,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(
        MetricsMiddleware,        // Record request metrics (first for accurate duration)
        CorrelationIdMiddleware,
        RequestContextMiddleware, // Populate AsyncLocalStorage for structured logging
        UserContextMiddleware,
        TenantContextMiddleware,
        TenantSchemaMiddleware,   // Sets PostgreSQL search_path to tenant schema
      )
      .forRoutes('*');
  }
}
