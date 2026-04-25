/**
 * @aquaculture/farm-shared — Public API
 *
 * Shared types, utilities, and components for the farm module.
 * Both web and mobile import from this barrel — no copy-paste.
 *
 * WHY this is a separate library (not inlined into farm-service):
 *   1. Water quality types and threshold logic are consumed by both
 *      the NestJS farm-service backend AND the React Native mobile app.
 *      Inlining into farm-service would force the mobile app to depend
 *      on a backend package with NestJS/TypeORM transitive deps.
 *   2. DynamicMeasurementForm is a React component shared across web
 *      and mobile — it cannot live inside a NestJS service package.
 *   3. Growth plan: species-specific parameter configs, feed calculation
 *      utils, and additional shared components will be added here as
 *      the farm module matures.
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
export {
  DynamicMeasurementForm,
  DynamicParameterFields,
  collectDynamicValues,
} from './components/DynamicMeasurementForm';
export type { DynamicParameterFieldsProps } from './components/DynamicMeasurementForm';
