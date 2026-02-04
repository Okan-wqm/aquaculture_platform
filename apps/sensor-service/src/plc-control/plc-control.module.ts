import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { FeedingParameter } from './entities/feeding-parameter.entity';
import { PlcAlarm } from './entities/plc-alarm.entity';
import { PlcConnection } from './entities/plc-connection.entity';
import { PlcTelemetry } from './entities/plc-telemetry.entity';

// Services
import {
  PlcConnectionService,
  FeedingParameterService,
  PlcAlarmService,
  PlcTelemetryService,
} from './services';

// Resolvers
import {
  PlcControlResolver,
  PlcConnectionResolver,
  FeedingParameterResolver,
} from './resolvers';

/**
 * PLC Control Module
 *
 * Provides OPC UA based communication with PLCs for:
 * - Uploading feeding parameters/scenarios
 * - Receiving telemetry data
 * - Collecting alarms and reports
 *
 * Architecture:
 * - Cloud sends PARAMETERS (FCR, biomass, thresholds, schedules)
 * - PLC is AUTONOMOUS - makes all real-time decisions locally
 * - PLC sends TELEMETRY and REPORTS back to cloud
 *
 * Features:
 * - PLC connection management with OPC UA support
 * - Feeding parameter configuration and versioning
 * - Alarm monitoring and acknowledgment
 * - Telemetry data collection and statistics
 * - Full tenant isolation for multi-tenancy support
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      PlcConnection,
      FeedingParameter,
      PlcTelemetry,
      PlcAlarm,
    ]),
  ],
  providers: [
    // Services
    PlcConnectionService,
    FeedingParameterService,
    PlcAlarmService,
    PlcTelemetryService,

    // Resolvers
    PlcControlResolver,
    PlcConnectionResolver,
    FeedingParameterResolver,
  ],
  exports: [
    // Export services for use in other modules
    PlcConnectionService,
    FeedingParameterService,
    PlcAlarmService,
    PlcTelemetryService,
  ],
})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class PlcControlModule {}
