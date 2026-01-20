import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GraphQLModule } from '@nestjs/graphql';
import {
  ApolloFederationDriver,
  ApolloFederationDriverConfig,
} from '@nestjs/apollo';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import {
  UserContextMiddleware,
  TenantContextMiddleware,
  CorrelationIdMiddleware,
  TenantGuard,
} from '@platform/backend-common';
import { EventBusModule } from '@platform/event-bus';
import { SensorModule } from './sensor/sensor.module';
import { HealthModule } from './health/health.module';
import { GlobalExceptionFilter } from './filters/global-exception.filter';
import { ProtocolModule } from './protocol/protocol.module';
import { RegistrationModule } from './registration/registration.module';
import { VfdModule } from './vfd/vfd.module';
import { IngestionModule } from './ingestion/ingestion.module';
import { ProcessModule } from './process/process.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { TenantSchemaMiddleware } from './middleware/tenant-schema.middleware';

// Explicitly import all entities (required for webpack bundle)
import { Sensor } from './database/entities/sensor.entity';
import { SensorReading } from './database/entities/sensor-reading.entity';
import { SensorProtocol } from './database/entities/sensor-protocol.entity';
import { SensorDataChannel } from './database/entities/sensor-data-channel.entity';
import { VfdDevice } from './vfd/entities/vfd-device.entity';
import { VfdReading } from './vfd/entities/vfd-reading.entity';
import { VfdRegisterMapping } from './vfd/entities/vfd-register-mapping.entity';
import { Process } from './process/entities/process.entity';
import { DashboardLayout } from './dashboard/entities/dashboard-layout.entity';
import { EdgeDevice } from './edge-device/entities/edge-device.entity';
import { DeviceIoConfig } from './edge-device/entities/device-io-config.entity';
import { EdgeDeviceModule } from './edge-device/edge-device.module';

// Automation entities (IEC 61131-3 SFC programs)
import {
  AutomationProgram,
  ProgramStep,
  StepAction,
  ProgramTransition,
  ProgramVariable,
} from './automation/entities';
import { AutomationModule } from './automation/automation.module';

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
      useFactory: (configService: ConfigService) => ({
        type: 'postgres',
        host: configService.get('DATABASE_HOST') || configService.get('TIMESCALE_HOST') || 'localhost',
        port: configService.get<number>('DATABASE_PORT') || configService.get<number>('TIMESCALE_PORT') || 5432,
        username: configService.get('DATABASE_USER') || configService.get('TIMESCALE_USER') || 'postgres',
        password: configService.get('DATABASE_PASSWORD') || configService.get('TIMESCALE_PASSWORD') || 'postgres',
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
          DashboardLayout,
          EdgeDevice,
          DeviceIoConfig,
          // Automation entities (IEC 61131-3)
          AutomationProgram,
          ProgramStep,
          StepAction,
          ProgramTransition,
          ProgramVariable,
        ],
        synchronize: false, // Disabled due to index conflict bug
        logging: configService.get('DATABASE_LOGGING', 'false') === 'true',
        ssl:
          configService.get('DATABASE_SSL') === 'true'
            ? { rejectUnauthorized: false }
            : false,
        extra: {
          // Connection pool optimized for time-series data
          max: configService.get<number>('DATABASE_POOL_SIZE', 30),
          idleTimeoutMillis: 30000,
          connectionTimeoutMillis: 5000,
        },
      }),
    }),

    // GraphQL Federation
    GraphQLModule.forRootAsync<ApolloFederationDriverConfig>({
      driver: ApolloFederationDriver,
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        autoSchemaFile: {
          federation: 2,
        },
        playground: configService.get('NODE_ENV') !== 'production',
        // SECURITY: Disable introspection in production
        introspection: configService.get('NODE_ENV') !== 'production',
        context: ({ req }: { req: unknown }) => ({ req }),
      }),
    }),

    // Event Bus Module
    EventBusModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        natsUrl: configService.get('NATS_URL', 'nats://localhost:4222'),
        streamName: configService.get('NATS_STREAM_NAME', 'AQUACULTURE_EVENTS'),
      }),
    }),

    // Feature modules
    SensorModule,
    HealthModule,

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
  ],
  providers: [
    // Global exception filter
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    // Tenant guard
    {
      provide: APP_GUARD,
      useClass: TenantGuard,
    },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer
      .apply(
        CorrelationIdMiddleware,
        UserContextMiddleware,
        TenantContextMiddleware,
        TenantSchemaMiddleware, // Sets PostgreSQL search_path to tenant schema
      )
      .forRoutes('*');
  }
}
