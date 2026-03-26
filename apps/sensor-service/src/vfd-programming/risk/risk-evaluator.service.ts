import { Injectable } from '@nestjs/common';
import {
  PARAMETER_RISK_RULES,
  RISK_LEVEL_SCORES,
  RiskLevel,
  RiskAssessmentResult,
  ParameterRiskRule,
} from './parameter-risk-rules';

@Injectable()
export class RiskEvaluatorService {
  /**
   * Evaluate risk for a parameter change.
   * Uses pattern matching + dynamic escalation based on requested value.
   *
   * @param parameterName - The VFD parameter name (e.g. 'accel_time_1', 'max_frequency')
   * @param requestedValue - The numeric value the user wants to set
   * @param limits - Optional min/max limits from the parameter definition
   * @returns RiskAssessmentResult with risk level, motor stop requirement, warnings, and numeric score
   */
  evaluateRisk(
    parameterName: string,
    requestedValue: number,
    limits?: { min?: number; max?: number },
  ): RiskAssessmentResult {
    const matchingRules = this.findMatchingRules(parameterName);

    if (matchingRules.length === 0) {
      return {
        riskLevel: RiskLevel.MEDIUM,
        requiresMotorStop: false,
        warnings: ['No specific risk rule found — defaulting to MEDIUM'],
        riskScore: RISK_LEVEL_SCORES[RiskLevel.MEDIUM],
      };
    }

    let highestRisk = RiskLevel.LOW;
    let requiresMotorStop = false;
    const warnings: string[] = [];

    for (const rule of matchingRules) {
      let effectiveRisk = rule.baseRisk;

      if (rule.escalationCondition && rule.escalatedRisk) {
        if (rule.escalationCondition(requestedValue, limits ?? {})) {
          effectiveRisk = rule.escalatedRisk;
          warnings.push(`ESCALATED: ${rule.reason}`);
        }
      }

      if (RISK_LEVEL_SCORES[effectiveRisk] > RISK_LEVEL_SCORES[highestRisk]) {
        highestRisk = effectiveRisk;
      }

      if (rule.requiresMotorStop) {
        requiresMotorStop = true;
      }

      if (RISK_LEVEL_SCORES[effectiveRisk] >= RISK_LEVEL_SCORES[RiskLevel.MEDIUM]) {
        if (!warnings.some((w) => w.includes(rule.reason))) {
          warnings.push(rule.reason);
        }
      }
    }

    return {
      riskLevel: highestRisk,
      requiresMotorStop,
      warnings,
      riskScore: RISK_LEVEL_SCORES[highestRisk],
    };
  }

  /**
   * Evaluate aggregate risk for a batch of parameter changes.
   * Returns the highest risk level across all changes with deduplicated warnings.
   *
   * @param changes - Array of parameter changes to evaluate
   * @returns RiskAssessmentResult representing the aggregate risk of the entire batch
   */
  evaluateBatchRisk(
    changes: Array<{
      parameterName: string;
      value: number;
      limits?: { min?: number; max?: number };
    }>,
  ): RiskAssessmentResult {
    let highestRisk = RiskLevel.LOW;
    let requiresMotorStop = false;
    const allWarnings: string[] = [];

    for (const change of changes) {
      const result = this.evaluateRisk(change.parameterName, change.value, change.limits);

      if (RISK_LEVEL_SCORES[result.riskLevel] > RISK_LEVEL_SCORES[highestRisk]) {
        highestRisk = result.riskLevel;
      }

      if (result.requiresMotorStop) {
        requiresMotorStop = true;
      }

      allWarnings.push(...result.warnings);
    }

    return {
      riskLevel: highestRisk,
      requiresMotorStop,
      warnings: [...new Set(allWarnings)],
      riskScore: RISK_LEVEL_SCORES[highestRisk],
    };
  }

  /**
   * Find all rules whose pattern matches the given parameter name.
   */
  private findMatchingRules(parameterName: string): ParameterRiskRule[] {
    return PARAMETER_RISK_RULES.filter((rule) =>
      this.matchesPattern(parameterName, rule.parameterPattern),
    );
  }

  /**
   * Simple glob pattern matching: supports single wildcard (*) at any position.
   * 'accel_time_*' matches 'accel_time_1', 'accel_time_2'
   * 'di_*_function' matches 'di_1_function', 'di_2_function'
   * 'max_frequency' matches 'max_frequency' exactly
   */
  private matchesPattern(name: string, pattern: string): boolean {
    const starIndex = pattern.indexOf('*');
    if (starIndex === -1) {
      return name === pattern;
    }
    const prefix = pattern.slice(0, starIndex);
    const suffix = pattern.slice(starIndex + 1);
    return (
      name.startsWith(prefix) &&
      name.endsWith(suffix) &&
      name.length >= prefix.length + suffix.length
    );
  }
}
