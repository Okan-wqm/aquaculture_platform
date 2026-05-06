/**
 * SCADA Shared Types — Barrel Re-export
 *
 * Centralises the cross-package import from the shared SCADA type definitions
 * so that every file in scada-runtime imports from this single location instead
 * of duplicating a fragile deep relative path.
 *
 * TODO: Replace this relative import with a TSConfig path alias once the
 * monorepo build tooling supports it. The ideal setup is:
 *
 *   // tsconfig.json (sensor-service)
 *   "paths": {
 *     "@aquaculture/scada-types": [
 *       "../../web/modules/sensor-module/src/types/scada-runtime.types"
 *     ]
 *   }
 *
 * Then this file becomes:
 *   export * from '@aquaculture/scada-types';
 *   export { ScadaSocketEvent } from '@aquaculture/scada-types';
 */

// Single well-documented relative import — the ONLY place this path appears.
export type {
  AlarmStatusSummary,
  HmiRole,
  TagValueChange,
  HistoricalDataPoint,
  DaqAggregation,
  DaqResultPayload,
  TagWritePayload,
  DaqQueryPayload,
} from '../../../../web/modules/sensor-module/src/types/scada-runtime.types';

export { ScadaSocketEvent } from '../../../../web/modules/sensor-module/src/types/scada-runtime.types';
