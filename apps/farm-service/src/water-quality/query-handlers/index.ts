/**
 * Water Quality Query Handlers Index
 * @module WaterQuality/QueryHandlers
 */
import { ListParameterConfigsHandler } from './list-parameter-configs.handler';
import { GetParameterConfigHandler } from './get-parameter-config.handler';
import { GetParameterConfigByCodeHandler } from './get-parameter-config-by-code.handler';
import { ListParameterTemplatesHandler } from './list-parameter-templates.handler';
import { ListParamEquipmentHandler } from './list-param-equipment.handler';
import { GetEquipmentParamsHandler } from './get-equipment-params.handler';
// Measurement read handlers (fail-closed tenant boundary — FARM-HIGH-076)
import { GetWaterQualityHandler } from './get-water-quality.handler';
import { ListWaterQualityHandler } from './list-water-quality.handler';
import { GetLatestWaterQualityHandler } from './get-latest-water-quality.handler';
import { ListCriticalWaterQualityHandler } from './list-critical-water-quality.handler';
import { GetWaterQualityChartHandler } from './get-water-quality-chart.handler';
import { GetTankWaterQualityStatisticsHandler } from './get-tank-water-quality-statistics.handler';
import { GetSystemWaterQualityChartHandler } from './get-system-water-quality-chart.handler';
import { GetSystemWaterQualityStatisticsHandler } from './get-system-water-quality-statistics.handler';

export * from './list-parameter-configs.handler';
export * from './get-parameter-config.handler';
export * from './get-parameter-config-by-code.handler';
export * from './list-parameter-templates.handler';
export * from './list-param-equipment.handler';
export * from './get-equipment-params.handler';
export * from './get-water-quality.handler';
export * from './list-water-quality.handler';
export * from './get-latest-water-quality.handler';
export * from './list-critical-water-quality.handler';
export * from './get-water-quality-chart.handler';
export * from './get-tank-water-quality-statistics.handler';
export * from './get-system-water-quality-chart.handler';
export * from './get-system-water-quality-statistics.handler';

/**
 * All water quality query handlers for module registration
 */
export const WaterQualityQueryHandlers = [
  ListParameterConfigsHandler,
  GetParameterConfigHandler,
  GetParameterConfigByCodeHandler,
  ListParameterTemplatesHandler,
  ListParamEquipmentHandler,
  GetEquipmentParamsHandler,
  GetWaterQualityHandler,
  ListWaterQualityHandler,
  GetLatestWaterQualityHandler,
  ListCriticalWaterQualityHandler,
  GetWaterQualityChartHandler,
  GetTankWaterQualityStatisticsHandler,
  GetSystemWaterQualityChartHandler,
  GetSystemWaterQualityStatisticsHandler,
];
