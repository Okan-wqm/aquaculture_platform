/**
 * Threshold Evaluator
 *
 * Pure function with ZERO external dependencies.
 * Evaluates a numeric measurement against configured threshold limits
 * and returns a status result with color/icon for display.
 *
 * Used by both the backend evaluation service and frontend form components.
 */
import { ThresholdLimits, ThresholdResult } from '../types/water-quality.types';

export function evaluateThreshold(
  value: number | null | undefined,
  limits: ThresholdLimits,
): ThresholdResult {
  if (value == null || Number.isNaN(value) || !Number.isFinite(value)) {
    return { status: 'UNKNOWN', message: null, color: 'gray', icon: 'unknown' };
  }

  // Critical bounds first (outermost)
  if (limits.criticalMin != null && value < limits.criticalMin) {
    return { status: 'CRITICAL_LOW', message: 'Critically low', color: 'red', icon: 'critical' };
  }
  if (limits.criticalMax != null && value > limits.criticalMax) {
    return { status: 'CRITICAL_HIGH', message: 'Critically high', color: 'red', icon: 'critical' };
  }

  // Warning bounds
  if (limits.warningMin != null && value < limits.warningMin) {
    return { status: 'LOW', message: 'Below optimal', color: 'yellow', icon: 'warning' };
  }
  if (limits.warningMax != null && value > limits.warningMax) {
    return { status: 'HIGH', message: 'Above optimal', color: 'yellow', icon: 'warning' };
  }

  // Optimal bounds (innermost)
  if (limits.optimalMin != null && value < limits.optimalMin) {
    return { status: 'LOW', message: 'Below optimal range', color: 'yellow', icon: 'warning' };
  }
  if (limits.optimalMax != null && value > limits.optimalMax) {
    return { status: 'HIGH', message: 'Above optimal range', color: 'yellow', icon: 'warning' };
  }

  return { status: 'OPTIMAL', message: null, color: 'green', icon: 'check' };
}
