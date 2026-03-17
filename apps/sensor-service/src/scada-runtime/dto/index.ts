/**
 * Barrel export for all SCADA runtime DTOs.
 */

export {
  TagSubscriptionDto,
  TagWriteDto,
  DaqAggregationDto,
  DaqQueryDto,
  AlarmAckDto,
  AlarmAckAllDto,
  SCADA_ERROR_CODES,
  MAX_TAG_IDS_PER_SUBSCRIPTION,
  ALLOWED_WRITE_FUNCTIONS,
  ALLOWED_DAQ_AGGREGATION_FUNCTIONS,
  ALLOWED_DAQ_AGGREGATION_INTERVALS,
} from './scada-socket.dto';

export type { ScadaErrorPayload, ScadaErrorCode } from './scada-socket.dto';
