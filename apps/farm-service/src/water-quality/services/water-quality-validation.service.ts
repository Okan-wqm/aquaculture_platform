/**
 * WaterQualityValidationService
 *
 * Validates dynamic parameters against tenant-specific parameter configurations.
 * Checks data types, enum values, required fields, and equipment mappings.
 *
 * Backward compatible: if no configs exist for the tenant, validation passes.
 *
 * @module WaterQuality/Services
 */
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ParameterConfigCacheService } from './parameter-config-cache.service';
import { WaterQualityParamEquipment } from '../entities/water-quality-param-equipment.entity';
import { WaterQualityParameterConfig } from '../entities/water-quality-parameter-config.entity';

// ============================================================================
// TYPES
// ============================================================================

export interface ValidationError {
  field: string;
  code: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class WaterQualityValidationService {
  private readonly logger = new Logger(WaterQualityValidationService.name);

  constructor(
    private readonly configCache: ParameterConfigCacheService,
    @InjectRepository(WaterQualityParamEquipment)
    private readonly mappingRepository: Repository<WaterQualityParamEquipment>,
  ) {}

  /**
   * Validates dynamic parameters against tenant-specific configurations.
   *
   * @param tenantId - The tenant whose configs define allowed parameters
   * @param dynamicParameters - The key-value pairs to validate
   * @param equipmentId - Optional equipment ID to also check parameter-equipment mappings
   * @returns Validation result with detailed errors per field
   */
  async validate(
    tenantId: string,
    dynamicParameters: Record<string, number | string | boolean>,
    equipmentId?: string,
  ): Promise<ValidationResult> {
    const errors: ValidationError[] = [];
    const configs = await this.configCache.getActiveConfigs(tenantId);

    if (configs.length === 0) {
      // No configs - skip validation (backward compat)
      this.logger.debug(`No active configs for tenant ${tenantId}, skipping dynamic parameter validation`);
      return { valid: true, errors: [] };
    }

    const configMap = new Map<string, WaterQualityParameterConfig>(
      configs.map(c => [c.code, c]),
    );

    // If equipmentId provided, get mapped parameter codes
    let mappedCodes: Set<string> | null = null;
    if (equipmentId) {
      const mappings = await this.mappingRepository.find({
        where: { tenantId, equipmentId, isActive: true },
        select: ['parameterConfigId'],
        relations: ['parameterConfig'],
      });
      mappedCodes = new Set(
        mappings
          .map(m => m.parameterConfig?.code)
          .filter((code): code is string => Boolean(code)),
      );
    }

    // Validate each submitted parameter
    for (const [code, value] of Object.entries(dynamicParameters)) {
      const config = configMap.get(code);

      // Unknown parameter code
      if (!config) {
        errors.push({
          field: code,
          code: 'UNKNOWN_PARAMETER',
          message: `Parameter '${code}' is not configured for this tenant`,
        });
        continue;
      }

      // Not mapped to equipment (if equipmentId provided)
      if (mappedCodes && !mappedCodes.has(code)) {
        errors.push({
          field: code,
          code: 'NOT_MAPPED',
          message: `Parameter '${code}' is not mapped to this equipment`,
        });
        continue;
      }

      // Data type validation
      this.validateDataType(config, code, value, errors);
    }

    // Check required parameters
    this.validateRequiredParameters(configs, dynamicParameters, mappedCodes, errors);

    if (errors.length > 0) {
      this.logger.warn(
        `Validation failed for tenant ${tenantId}: ${errors.length} error(s)`,
      );
    }

    return { valid: errors.length === 0, errors };
  }

  // -------------------------------------------------------------------------
  // PRIVATE HELPERS
  // -------------------------------------------------------------------------

  private validateDataType(
    config: WaterQualityParameterConfig,
    code: string,
    value: number | string | boolean,
    errors: ValidationError[],
  ): void {
    const dataType = config.dataType.toLowerCase();

    if (dataType === 'number') {
      if (typeof value !== 'number') {
        errors.push({
          field: code,
          code: 'INVALID_TYPE',
          message: `Parameter '${code}' must be a number`,
        });
      }
    } else if (dataType === 'enum') {
      if (typeof value !== 'string') {
        errors.push({
          field: code,
          code: 'INVALID_TYPE',
          message: `Parameter '${code}' must be a string`,
        });
      } else if (config.enumValues && !config.enumValues.includes(value)) {
        errors.push({
          field: code,
          code: 'INVALID_ENUM',
          message: `Parameter '${code}' must be one of: ${config.enumValues.join(', ')}`,
        });
      }
    } else if (dataType === 'boolean') {
      if (typeof value !== 'boolean') {
        errors.push({
          field: code,
          code: 'INVALID_TYPE',
          message: `Parameter '${code}' must be a boolean`,
        });
      }
    }
  }

  private validateRequiredParameters(
    configs: WaterQualityParameterConfig[],
    dynamicParameters: Record<string, number | string | boolean>,
    mappedCodes: Set<string> | null,
    errors: ValidationError[],
  ): void {
    for (const config of configs) {
      if (config.isRequired && !(config.code in dynamicParameters)) {
        if (!mappedCodes || mappedCodes.has(config.code)) {
          errors.push({
            field: config.code,
            code: 'REQUIRED',
            message: `Parameter '${config.name}' is required`,
          });
        }
      }
    }
  }
}
