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

export * from './list-parameter-configs.handler';
export * from './get-parameter-config.handler';
export * from './get-parameter-config-by-code.handler';
export * from './list-parameter-templates.handler';
export * from './list-param-equipment.handler';
export * from './get-equipment-params.handler';

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
];
