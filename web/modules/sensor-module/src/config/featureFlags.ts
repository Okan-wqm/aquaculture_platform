/**
 * Sensor-module feature flags (enterprise plan Faz 6).
 *
 * Build-time env-var flags — the established web/ gating pattern
 * (`import.meta.env.*`; there is no web-wide flag framework, see
 * `web/shared-ui/src/config/brand.ts`). A flag defaults to its
 * status-quo value so an unset env preserves current behaviour;
 * operators opt into the new posture explicitly.
 */

/**
 * Read a boolean env flag. Absent / empty → `defaultValue`. Any of
 * `false`/`0`/`off`/`no` (case-insensitive) is false; anything else
 * truthy is true.
 */
function readBoolFlag(raw: unknown, defaultValue: boolean): boolean {
  if (raw === undefined || raw === null || raw === '') return defaultValue;
  const normalized = String(raw).trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(normalized)) return false;
  return true;
}

/**
 * The legacy iframe SCADA viewer (`components/scada/ScadaViewer.tsx`,
 * `pages/SensorScadaPage.tsx`, `store/scadaViewerStore.ts`) is scheduled
 * for removal now that the SCADA package builder + operator runtime own
 * the HMI experience. It rides one release behind this flag (default ON
 * to preserve the current index route), then gets deleted. Set
 * `VITE_SENSOR_LEGACY_SCADA_VIEWER=false` to switch the index route over
 * to the package list and preview the post-removal state.
 */
export function isLegacyScadaViewerEnabled(): boolean {
  return readBoolFlag(
    import.meta.env['VITE_SENSOR_LEGACY_SCADA_VIEWER'],
    /* defaultValue */ true,
  );
}

/** Exported for unit tests — pure, env-free evaluation of the flag rule. */
export const __test = { readBoolFlag };
