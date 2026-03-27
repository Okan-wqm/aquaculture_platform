/**
 * WaterQualityEvaluationService
 *
 * Enterprise dynamic evaluation engine that evaluates water quality
 * parameters against tenant-specific, species-specific thresholds
 * loaded from WaterQualityParameterConfig.
 *
 * Replaces the hardcoded evaluateParameters() on the entity with
 * a fully configurable, tenant-driven evaluation pipeline.
 *
 * @module WaterQuality/Services
 */
import { Injectable, Logger } from '@nestjs/common';
import { ParameterConfigCacheService } from './parameter-config-cache.service';
import { ParameterDataType, SpeciesLimitEntry } from '../entities/water-quality-parameter-config.entity';
import {
  WaterQualitySummary,
  ParameterEvaluation,
  ParameterStatus,
  WaterQualityStatus,
} from '../entities/water-quality-measurement.entity';

@Injectable()
export class WaterQualityEvaluationService {
  private readonly logger = new Logger(WaterQualityEvaluationService.name);

  constructor(
    private readonly configCache: ParameterConfigCacheService,
  ) {}

  /**
   * Evaluates a set of water quality parameters against tenant-specific
   * configuration. Supports species-specific threshold overrides.
   *
   * @param tenantId - Tenant identifier
   * @param parameters - Key-value map of parameter codes to measured values
   * @param speciesCode - Optional species code for species-specific limits
   * @returns Full evaluation summary with per-parameter status and recommendations
   */
  async evaluate(
    tenantId: string,
    parameters: Record<string, unknown>,
    speciesCode?: string,
  ): Promise<WaterQualitySummary> {
    const configs = await this.configCache.getActiveConfigs(tenantId);

    // If no configs, return UNKNOWN (backward-compatible fallback)
    if (configs.length === 0) {
      this.logger.warn(`No active parameter configs found for tenant ${tenantId}`);
      return {
        overallStatus: WaterQualityStatus.UNKNOWN,
        criticalCount: 0,
        warningCount: 0,
        optimalCount: 0,
        evaluations: [],
        recommendations: [],
      };
    }

    const evaluations: ParameterEvaluation[] = [];
    let criticalCount = 0;
    let warningCount = 0;
    let optimalCount = 0;
    const recommendations: string[] = [];

    for (const config of configs) {
      const rawValue = parameters[config.code];

      // Skip non-numeric configs (enum, boolean) for threshold evaluation
      if (config.dataType !== ParameterDataType.NUMBER) continue;

      if (rawValue === undefined || rawValue === null) {
        if (config.isRequired) {
          evaluations.push({
            parameter: config.code,
            value: 0,
            unit: config.unit,
            status: ParameterStatus.NOT_MEASURED,
            message: `${config.name} is required but not measured`,
          });
          warningCount++;
          recommendations.push(`Measure ${config.name}`);
        }
        continue;
      }

      const value = Number(rawValue);
      if (isNaN(value)) continue;

      // Get effective limits (species-specific if available)
      let limits: SpeciesLimitEntry = {
        optimalMin: config.optimalMin,
        optimalMax: config.optimalMax,
        warningMin: config.warningMin,
        warningMax: config.warningMax,
        criticalMin: config.criticalMin,
        criticalMax: config.criticalMax,
      };

      if (speciesCode && config.speciesLimits) {
        const speciesOverride = config.speciesLimits[speciesCode];
        if (speciesOverride) {
          limits = { ...limits, ...speciesOverride };
        }
      }

      // Evaluate parameter against thresholds
      const evaluation = this.evaluateParameter(config.code, config.name, value, config.unit, limits);
      evaluations.push(evaluation);

      switch (evaluation.status) {
        case ParameterStatus.CRITICAL_LOW:
        case ParameterStatus.CRITICAL_HIGH:
          criticalCount++;
          recommendations.push(
            `${config.name} requires immediate attention - ${evaluation.status === ParameterStatus.CRITICAL_LOW ? 'below critical minimum' : 'above critical maximum'}`,
          );
          break;
        case ParameterStatus.LOW:
        case ParameterStatus.HIGH:
          warningCount++;
          break;
        case ParameterStatus.OPTIMAL:
          optimalCount++;
          break;
      }
    }

    // Determine overall status
    let overallStatus: WaterQualityStatus;
    if (criticalCount > 0) {
      overallStatus = WaterQualityStatus.CRITICAL;
    } else if (warningCount > 0) {
      overallStatus = WaterQualityStatus.WARNING;
    } else if (optimalCount > 0) {
      overallStatus = WaterQualityStatus.OPTIMAL;
    } else {
      overallStatus = WaterQualityStatus.ACCEPTABLE;
    }

    this.logger.debug(
      `Evaluation for tenant ${tenantId}: ${overallStatus} (critical=${criticalCount}, warning=${warningCount}, optimal=${optimalCount})`,
    );

    return {
      overallStatus,
      criticalCount,
      warningCount,
      optimalCount,
      evaluations,
      recommendations,
    };
  }

  /**
   * Evaluates a single numeric parameter against its threshold limits.
   */
  private evaluateParameter(
    code: string,
    name: string,
    value: number,
    unit: string,
    limits: SpeciesLimitEntry,
  ): ParameterEvaluation {
    let status: ParameterStatus;
    let message: string | undefined;

    if (limits.criticalMin != null && value < limits.criticalMin) {
      status = ParameterStatus.CRITICAL_LOW;
      message = `${name} critically low`;
    } else if (limits.criticalMax != null && value > limits.criticalMax) {
      status = ParameterStatus.CRITICAL_HIGH;
      message = `${name} critically high`;
    } else if (limits.warningMin != null && value < limits.warningMin) {
      status = ParameterStatus.LOW;
      message = `${name} below optimal`;
    } else if (limits.warningMax != null && value > limits.warningMax) {
      status = ParameterStatus.HIGH;
      message = `${name} above optimal`;
    } else if (limits.optimalMin != null && value < limits.optimalMin) {
      status = ParameterStatus.LOW;
      message = `${name} below optimal range`;
    } else if (limits.optimalMax != null && value > limits.optimalMax) {
      status = ParameterStatus.HIGH;
      message = `${name} above optimal range`;
    } else {
      status = ParameterStatus.OPTIMAL;
    }

    return {
      parameter: code,
      value,
      unit,
      status,
      optimalMin: limits.optimalMin ?? undefined,
      optimalMax: limits.optimalMax ?? undefined,
      criticalMin: limits.criticalMin ?? undefined,
      criticalMax: limits.criticalMax ?? undefined,
      message,
    };
  }
}
