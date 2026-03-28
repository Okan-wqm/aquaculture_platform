/**
 * @aquaculture/farm-shared — Public API
 *
 * Shared types, utilities, and components for the farm module.
 * Both web and mobile import from this barrel — no copy-paste.
 */

// Types
export type {
  ParameterStatus,
  ThresholdLimits,
  ThresholdResult,
  ParameterFieldConfig,
} from './types/water-quality.types';

// Utilities
export { evaluateThreshold } from './utils/threshold-evaluator';

// Components
export { DynamicMeasurementForm } from './components/DynamicMeasurementForm';
