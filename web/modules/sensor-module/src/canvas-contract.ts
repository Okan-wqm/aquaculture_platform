/**
 * Canvas contract — the single source of truth for the host↔iframe boundary
 * of the P&ID process-editor canvas (and the legacy SCADA viewer iframe).
 *
 * WHY (SENSOR-MEDIUM-005): before this module existed, the boundary was
 * fragmented — THREE hand-rolled `getCanvasUrl()` copies (two carrying a dead
 * `localhost:3006` port sniff that matched no real dev port, so the "dev"
 * branch never executed) and FOURTEEN stringly-typed `'process-editor-host'` /
 * `'process-editor-canvas'` literals spread across six files on both sides of
 * the postMessage wire. Renaming any one of them silently broke the handshake.
 *
 * Both worlds import THIS file:
 *   - the host side (UnifiedEditorPage / ProcessEditorPage / ScreenManager /
 *     processStore / ScadaViewer) as normal TS,
 *   - the bundled canvas app (canvas/main.jsx) through the same Vite build.
 *
 * The URL constants derive from the module's Vite `base`
 * ('/remotes/sensor-module/'), which is identical in dev and prod — the module
 * dev server serves public/ + built canvas under the same base the prod nginx
 * exposes, so ONE canonical URL replaces environment sniffing. The invariant
 * spec (src/__tests__/canvas-contract.spec.ts) pins this prefix to the actual
 * `base` in vite.config.ts and bans stray literals, so drift is build-time
 * detectable.
 */

/** `source` field the canvas iframe stamps on every message it posts. */
export const CANVAS_SOURCE = 'process-editor-canvas' as const;

/** `source` field the host page stamps on every message it posts. */
export const HOST_SOURCE = 'process-editor-host' as const;

/** Vite `base` of the sensor-module remote — dev and prod serve under it. */
export const SENSOR_MODULE_BASE = '/remotes/sensor-module/' as const;

/** Canonical URL of the bundled process-editor canvas document. */
export const PROCESS_EDITOR_CANVAS_URL = `${SENSOR_MODULE_BASE}process-editor-canvas.html` as const;

/** Canonical URL of the legacy (flag-gated) SCADA viewer canvas document. */
export const SCADA_VIEWER_CANVAS_URL = `${SENSOR_MODULE_BASE}scada-viewer-canvas.html` as const;

/** Envelope every message on the wire carries, in both directions. */
export interface CanvasMessageEnvelope<T = unknown> {
  type: string;
  data?: T;
  source: typeof CANVAS_SOURCE | typeof HOST_SOURCE;
}
