import { Injectable, Logger } from '@nestjs/common';
import { AlertRule, AlertCondition, AlertOperator } from '../database/entities/alert-rule.entity';

/**
 * Logical operator for combining conditions
 */
export enum LogicalOperator {
  AND = 'AND',
  OR = 'OR',
  NOT = 'NOT',
}

/**
 * Context variables for rule evaluation
 */
export interface EvaluationContext {
  // Sensor reading values
  values: Record<string, number | string | boolean | null>;

  // Metadata
  timestamp?: Date;
  sensorId?: string;
  pondId?: string;
  farmId?: string;
  tenantId?: string;

  // Historical data for rate-of-change calculations
  previousValues?: Record<string, number>;
  previousTimestamp?: Date;

  // Global variables
  globalVars?: Record<string, unknown>;

  // Local variables for nested evaluation
  localVars?: Record<string, unknown>;
}

/**
 * Single condition evaluation result
 */
export interface ConditionResult {
  condition: AlertCondition;
  matched: boolean;
  actualValue: unknown;
  expectedValue: number;
  operator: AlertOperator;
}

/**
 * Full evaluation result
 */
export interface EvaluationResult {
  matched: boolean;
  matchedConditions: AlertCondition[];
  allResults: ConditionResult[];
  evaluationTime: number; // ms
  timestamp: Date;
}

/**
 * Complex condition with nested groups
 */
export interface ComplexCondition {
  type: 'simple' | 'group';
  condition?: AlertCondition;
  operator?: LogicalOperator;
  children?: ComplexCondition[];
}

/**
 * Rule Evaluator Service
 * Evaluates conditions against context data
 */
@Injectable()
export class RuleEvaluatorService {
  private readonly logger = new Logger(RuleEvaluatorService.name);

  /**
   * Evaluate a rule against the given context
   */
  async evaluate(rule: AlertRule, context: EvaluationContext): Promise<EvaluationResult> {
    const startTime = Date.now();

    try {
      const allResults: ConditionResult[] = [];
      const matchedConditions: AlertCondition[] = [];

      // Evaluate each condition
      for (const condition of rule.conditions) {
        const result = this.evaluateCondition(condition, context);
        allResults.push(result);

        if (result.matched) {
          matchedConditions.push(condition);
        }
      }

      // Default behavior: ANY condition match triggers alert (OR logic)
      // For AND logic, all conditions must match
      const matched = matchedConditions.length > 0;

      return {
        matched,
        matchedConditions,
        allResults,
        evaluationTime: Date.now() - startTime,
        timestamp: new Date(),
      };
    } catch (error) {
      this.logger.error(`Error evaluating rule ${rule.id}: ${(error as Error).message}`);
      throw error;
    }
  }

  /**
   * Evaluate with AND logic (all conditions must match)
   */
  async evaluateWithAnd(rule: AlertRule, context: EvaluationContext): Promise<EvaluationResult> {
    const startTime = Date.now();

    const allResults: ConditionResult[] = [];

    for (const condition of rule.conditions) {
      const result = this.evaluateCondition(condition, context);
      allResults.push(result);

      // Short-circuit: if any condition fails, stop
      if (!result.matched) {
        return {
          matched: false,
          matchedConditions: [],
          allResults,
          evaluationTime: Date.now() - startTime,
          timestamp: new Date(),
        };
      }
    }

    return {
      matched: true,
      matchedConditions: rule.conditions,
      allResults,
      evaluationTime: Date.now() - startTime,
      timestamp: new Date(),
    };
  }

  /**
   * Evaluate complex nested conditions
   */
  async evaluateComplex(
    conditions: ComplexCondition,
    context: EvaluationContext,
  ): Promise<boolean> {
    if (conditions.type === 'simple' && conditions.condition) {
      const result = this.evaluateCondition(conditions.condition, context);
      return result.matched;
    }

    if (conditions.type === 'group' && conditions.children) {
      const childResults = await Promise.all(
        conditions.children.map(child => this.evaluateComplex(child, context)),
      );

      switch (conditions.operator) {
        case LogicalOperator.AND:
          return childResults.every(r => r);
        case LogicalOperator.OR:
          return childResults.some(r => r);
        case LogicalOperator.NOT:
          // NOT applies to first child only
          return !childResults[0];
        default:
          return childResults.some(r => r);
      }
    }

    return false;
  }

  /**
   * Evaluate a single condition
   */
  evaluateCondition(condition: AlertCondition, context: EvaluationContext): ConditionResult {
    const { parameter, operator, threshold } = condition;

    // Get the actual value from context
    let actualValue = this.resolveValue(parameter, context);

    // Handle special parameters
    if (parameter.startsWith('rate_of_change_')) {
      const baseParam = parameter.replace('rate_of_change_', '');
      actualValue = this.calculateRateOfChange(baseParam, context);
    }

    // Handle null/undefined values
    if (actualValue === null || actualValue === undefined) {
      return {
        condition,
        matched: false,
        actualValue: null,
        expectedValue: threshold,
        operator,
      };
    }

    // Convert to number for comparison
    const numericValue = typeof actualValue === 'number' ? actualValue : parseFloat(String(actualValue));

    if (isNaN(numericValue)) {
      return {
        condition,
        matched: false,
        actualValue,
        expectedValue: threshold,
        operator,
      };
    }

    // Perform comparison
    const matched = this.compareValues(numericValue, operator, threshold);

    return {
      condition,
      matched,
      actualValue: numericValue,
      expectedValue: threshold,
      operator,
    };
  }

  /**
   * Evaluate threshold rule: value > X
   */
  evaluateGreaterThan(value: number, threshold: number): boolean {
    return value > threshold;
  }

  /**
   * Evaluate threshold rule: value < X
   */
  evaluateLessThan(value: number, threshold: number): boolean {
    return value < threshold;
  }

  /**
   * Evaluate threshold rule: value between X and Y
   */
  evaluateBetween(value: number, min: number, max: number): boolean {
    return value >= min && value <= max;
  }

  /**
   * Evaluate rate-of-change: X% increase/decrease
   */
  evaluateRateOfChange(
    currentValue: number,
    previousValue: number,
    thresholdPercent: number,
    direction: 'increase' | 'decrease' | 'any' = 'any',
  ): boolean {
    if (previousValue === 0) {
      return currentValue !== 0; // Any change from 0
    }

    const changePercent = ((currentValue - previousValue) / Math.abs(previousValue)) * 100;

    switch (direction) {
      case 'increase':
        return changePercent >= thresholdPercent;
      case 'decrease':
        return changePercent <= -thresholdPercent;
      case 'any':
        return Math.abs(changePercent) >= thresholdPercent;
    }
  }

  /**
   * Evaluate consecutive occurrence rule
   */
  evaluateConsecutiveOccurrences(
    occurrences: boolean[],
    requiredCount: number,
  ): boolean {
    let consecutive = 0;
    for (const occurred of occurrences) {
      if (occurred) {
        consecutive++;
        if (consecutive >= requiredCount) return true;
      } else {
        consecutive = 0;
      }
    }
    return false;
  }

  /**
   * Evaluate time-window rule: N events in M minutes
   */
  evaluateTimeWindow(
    eventTimestamps: Date[],
    windowMinutes: number,
    requiredCount: number,
  ): boolean {
    const now = new Date();
    const windowStart = new Date(now.getTime() - windowMinutes * 60 * 1000);

    const eventsInWindow = eventTimestamps.filter(t => t >= windowStart);
    return eventsInWindow.length >= requiredCount;
  }

  /**
   * Evaluate aggregation rule
   */
  evaluateAggregation(
    values: number[],
    aggregationType: 'avg' | 'sum' | 'count' | 'min' | 'max',
    operator: AlertOperator,
    threshold: number,
  ): boolean {
    if (values.length === 0) return false;

    let aggregatedValue: number;

    switch (aggregationType) {
      case 'avg':
        aggregatedValue = values.reduce((a, b) => a + b, 0) / values.length;
        break;
      case 'sum':
        aggregatedValue = values.reduce((a, b) => a + b, 0);
        break;
      case 'count':
        aggregatedValue = values.length;
        break;
      case 'min':
        aggregatedValue = Math.min(...values);
        break;
      case 'max':
        aggregatedValue = Math.max(...values);
        break;
      default:
        return false;
    }

    return this.compareValues(aggregatedValue, operator, threshold);
  }

  /**
   * Evaluate regex pattern matching
   */
  evaluateRegex(value: string, pattern: string): boolean {
    try {
      const regex = new RegExp(pattern);
      return regex.test(value);
    } catch {
      this.logger.warn(`Invalid regex pattern: ${pattern}`);
      return false;
    }
  }

  /**
   * Evaluate date range rule
   */
  evaluateDateRange(date: Date, startDate: Date, endDate: Date): boolean {
    return date >= startDate && date <= endDate;
  }

  /**
   * Evaluate time-based rule (time of day)
   */
  evaluateTimeOfDay(
    date: Date,
    startTime: string, // HH:mm format
    endTime: string,   // HH:mm format
  ): boolean {
    const currentTime = `${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;

    // Handle overnight ranges (e.g., 22:00 - 06:00)
    if (startTime > endTime) {
      return currentTime >= startTime || currentTime <= endTime;
    }

    return currentTime >= startTime && currentTime <= endTime;
  }

  /**
   * Evaluate absence rule (event not occurring)
   */
  evaluateAbsence(
    lastEventTime: Date | null,
    maxAbsenceMinutes: number,
  ): boolean {
    if (!lastEventTime) return true; // No event ever = absence

    const now = new Date();
    const absenceMs = now.getTime() - lastEventTime.getTime();
    const absenceMinutes = absenceMs / (1000 * 60);

    return absenceMinutes >= maxAbsenceMinutes;
  }

  /**
   * Evaluate anomaly detection (simple z-score based)
   */
  evaluateAnomaly(
    value: number,
    historicalValues: number[],
    zScoreThreshold: number = 2,
  ): boolean {
    if (historicalValues.length < 10) {
      return false; // Not enough data
    }

    const mean = historicalValues.reduce((a, b) => a + b, 0) / historicalValues.length;
    const variance = historicalValues.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / historicalValues.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) return value !== mean;

    const zScore = Math.abs((value - mean) / stdDev);
    return zScore >= zScoreThreshold;
  }

  // ============================================
  // Private Helper Methods
  // ============================================

  private compareValues(
    actual: number,
    operator: AlertOperator,
    threshold: number,
  ): boolean {
    switch (operator) {
      case AlertOperator.GT:
        return actual > threshold;
      case AlertOperator.GTE:
        return actual >= threshold;
      case AlertOperator.LT:
        return actual < threshold;
      case AlertOperator.LTE:
        return actual <= threshold;
      case AlertOperator.EQ:
        return actual === threshold;
      default:
        this.logger.warn(`Unknown operator: ${operator}`);
        return false;
    }
  }

  private resolveValue(
    parameter: string,
    context: EvaluationContext,
  ): number | string | boolean | null {
    // Check direct values first
    if (context.values[parameter] !== undefined) {
      return context.values[parameter];
    }

    // Check local variables
    if (context.localVars?.[parameter] !== undefined) {
      return context.localVars[parameter] as number | string | boolean;
    }

    // Check global variables
    if (context.globalVars?.[parameter] !== undefined) {
      return context.globalVars[parameter] as number | string | boolean;
    }

    // Check for dot notation (e.g., "sensor.temperature")
    if (parameter.includes('.')) {
      return this.resolveNestedValue(parameter, context);
    }

    return null;
  }

  private resolveNestedValue(
    path: string,
    context: EvaluationContext,
  ): number | string | boolean | null {
    const parts = path.split('.');
    let current: unknown = context;

    for (const part of parts) {
      if (current === null || current === undefined) {
        return null;
      }
      current = (current as Record<string, unknown>)[part];
    }

    return current as number | string | boolean | null;
  }

  private calculateRateOfChange(
    parameter: string,
    context: EvaluationContext,
  ): number | null {
    const currentValue = context.values[parameter];
    const previousValue = context.previousValues?.[parameter];

    if (
      currentValue === undefined ||
      currentValue === null ||
      previousValue === undefined ||
      previousValue === null
    ) {
      return null;
    }

    const current = typeof currentValue === 'number' ? currentValue : parseFloat(String(currentValue));
    const previous = typeof previousValue === 'number' ? previousValue : parseFloat(String(previousValue));

    if (isNaN(current) || isNaN(previous) || previous === 0) {
      return null;
    }

    return ((current - previous) / Math.abs(previous)) * 100;
  }
}
