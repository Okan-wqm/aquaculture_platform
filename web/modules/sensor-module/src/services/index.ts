/**
 * services — Barrel exports for SCADA runtime services.
 *
 * Consumers should import from here rather than from individual service
 * files so that the public API surface is stable and internal paths can
 * change without updating every import site.
 */

// ── Socket service ────────────────────────────────────────────────────────────

export {
  ScadaSocketService,
  getScadaSocketService,
} from './ScadaSocketService';

export type {
  ScadaEventPayloadMap,
  ScadaEventCallback,
  TagValuesPayload,
  TagWritePayload,
  DaqQueryPayload,
  DaqResultPayload,
} from './ScadaSocketService';

// ── Tag subscription manager ─────────────────────────────────────────────────

export {
  TagSubscriptionManager,
  createTagSubscriptionManager,
} from './TagSubscriptionManager';
