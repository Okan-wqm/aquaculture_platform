/**
 * PLC Control DTOs - Data Transfer Objects
 *
 * This module exports all DTOs for PLC control operations
 * including connections, feeding parameters, alarms, and telemetry.
 */

// PLC Connection DTOs
export {
  CreatePlcConnectionDto,
  UpdatePlcConnectionDto,
  PlcConnectionFilterDto,
  PlcPaginationDto,
  PaginatedPlcConnectionsDto,
  PlcConnectionCountByStatusDto,
  PlcConnectionTestResultDto,
  DiscoveredEndpointDto,
  NodeBrowseResultDto,
  HistoricalDataPointDto,
  ReadHistoricalDataInputDto,
  MethodArgumentInputDto,
  CallMethodInputDto,
  MethodCallResultDto,
  WriteNodeInputDto,
} from './plc-connection.dto';

// Feeding Parameter DTOs
export {
  PlcFeedingScheduleEntryInput,
  ThresholdConfigInput,
  VfdSettingsInput,
  CreateFeedingParameterDto,
  UpdateFeedingParameterDto,
  FeedingParameterFilterDto,
  PaginatedFeedingParametersDto,
  ParameterSendResultDto,
} from './feeding-parameter.dto';

// PLC Alarm DTOs
export {
  PlcAlarmFilterDto,
  AcknowledgeAlarmDto,
  BulkAcknowledgeAlarmsDto,
  PaginatedPlcAlarmsDto,
  PlcAlarmStatsDto,
  AlarmCountBySeverityDto,
  AlarmCountBySourceDto,
} from './plc-alarm.dto';

// PLC Telemetry DTOs
export {
  PlcTelemetryFilterDto,
  TelemetryTimeRangeDto,
  PaginatedPlcTelemetryDto,
  PlcTelemetryStatsDto,
  SensorStats,
  FeedingStatsDto,
  ActuatorUsageStatsDto,
  LatestTelemetrySummaryDto,
} from './plc-telemetry.dto';
