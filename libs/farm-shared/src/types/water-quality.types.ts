/**
 * Water Quality Types
 *
 * Shared type definitions for water quality parameter evaluation.
 * Used by both backend threshold evaluation and frontend forms.
 */

export type ParameterStatus =
  | 'OPTIMAL'
  | 'LOW'
  | 'HIGH'
  | 'CRITICAL_LOW'
  | 'CRITICAL_HIGH'
  | 'NOT_MEASURED'
  | 'UNKNOWN';

export interface ThresholdLimits {
  optimalMin: number | null;
  optimalMax: number | null;
  warningMin: number | null;
  warningMax: number | null;
  criticalMin: number | null;
  criticalMax: number | null;
}

export interface ThresholdResult {
  status: ParameterStatus;
  message: string | null;
  color: 'green' | 'yellow' | 'red' | 'gray';
  icon: 'check' | 'warning' | 'critical' | 'unknown';
}

export interface ParameterFieldConfig {
  code: string;
  name: string;
  unit: string;
  dataType: 'NUMBER' | 'ENUM' | 'BOOLEAN';
  precision: number;
  enumValues: string[] | null;
  isRequired: boolean;
  group: string;
  displayOrder: number;
  chartColor: string;
  limits: ThresholdLimits;
}
