import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlcConnection } from './entities/plc-connection.entity';
import { FeedingParameter } from './entities/feeding-parameter.entity';
import { PlcTelemetry } from './entities/plc-telemetry.entity';
import { PlcAlarm } from './entities/plc-alarm.entity';
// TODO: Implement these services in future sprints
// import { OpcUaClientService } from './services/opc-ua-client.service';
// import { ParameterPublisherService } from './services/parameter-publisher.service';
// import { TelemetryCollectorService } from './services/telemetry-collector.service';
// import { PlcConnectionService } from './services/plc-connection.service';
// import { PlcControlResolver } from './resolvers/plc-control.resolver';

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
 * Note: Services are not yet implemented. This module currently only
 * provides entity definitions for future development.
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
    // TODO: Add services when implemented
    // OpcUaClientService,
    // ParameterPublisherService,
    // TelemetryCollectorService,
    // PlcConnectionService,
    // PlcControlResolver,
  ],
  exports: [
    // TODO: Export services when implemented
    // OpcUaClientService,
    // ParameterPublisherService,
    // TelemetryCollectorService,
    // PlcConnectionService,
  ],
})
export class PlcControlModule {}
