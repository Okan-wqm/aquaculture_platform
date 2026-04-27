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
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

  /**
   * Strict mode — when true, a measurement submission against a
   * tenant with ZERO active parameter configs is REJECTED rather
   * than silently accepted. Before phase 6.5 this was the default
   * behaviour: any typo like "temeperature" went through without
   * complaint because the service had nothing to check against.
   * Operators were unaware the tenant had no configs and shipped
   * incoherent data for weeks.
   *
   * Default: strict. Set `WQ_STRICT_VALIDATION=false` to restore
   * the pre-6.5 pass-through behaviour for tenants still onboarding
   * — the env switch is deliberately opt-OUT so new deployments
   * get the safer default. Phase 7.5 tenant onboarding seeds a
   * default config set so brand-new tenants never hit strict-mode
   * rejection in the normal onboarding flow.
   *
   * Phase 6.5 of the "Farm modülü kalan kör noktalar" plan —
   * closes Girdi 15-B5.
   */
  private readonly strictMode: boolean;

  constructor(
    private readonly configCache: ParameterConfigCacheService,
    @InjectRepository(WaterQualityParamEquipment)
    private readonly mappingRepository: Repository<WaterQualityParamEquipment>,
    @Optional()
    configService?: ConfigService,
  ) {
    const raw = configService?.get<string | boolean>(
      'WQ_STRICT_VALIDATION',
    );
    this.strictMode = this.parseStrictFlag(raw);
  }

  private parseStrictFlag(raw: string | boolean | undefined): boolean {
    if (raw === undefined || raw === null || raw === '') return true;
    if (typeof raw === 'boolean') return raw;
    return !['false', '0', 'no', 'off'].includes(String(raw).toLowerCase());
  }

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
      // Phase 6.5 — strict-mode gate. Before this phase we silently
      // passed any submitted parameters through when a tenant had
      // zero active configs, which meant a typo ("temeperature"
      // with 3 m/s) was recorded as valid data. Strict mode
      // rejects such submissions so the operator finds out
      // immediately; the env var lets opt-out for legacy tenants
      // still onboarding their parameter catalogue.
      const submittedKeys = Object.keys(dynamicParameters ?? {});
      if (this.strictMode && submittedKeys.length > 0) {
        this.logger.warn(
          `Strict mode rejection: tenant ${tenantId.slice(0, 8)}... has no ` +
            `active parameter configs but is submitting ${submittedKeys.length} ` +
            `parameter(s). Seed a config set via WaterQualityParameterConfig ` +
            `mutations or set WQ_STRICT_VALIDATION=false to opt out.`,
        );
        return {
          valid: false,
          errors: [
            {
              field: '__tenant__',
              code: 'NO_ACTIVE_PARAMETER_CONFIGS',
              message:
                `Tenant has no active water-quality parameter configurations. ` +
                `Seed a config set before recording measurements (or set ` +
                `WQ_STRICT_VALIDATION=false to restore legacy pass-through behaviour).`,
            },
          ],
        };
      }
      // No configs AND nothing submitted, or strict mode disabled —
      // fall through as valid so existing tests and tenants that
      // send empty measurements keep working.
      this.logger.debug(
        `No active configs for tenant ${tenantId}, skipping dynamic parameter validation`,
      );
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
