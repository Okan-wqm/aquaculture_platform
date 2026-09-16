/**
 * adapters/index — explicit builder→runtime adapters (T7c).
 *
 * Each adapter is a PURE function returning the runtime artifact plus a
 * `warnings` array describing anything that could not be mapped. Callers
 * pass the warnings to `logAdapterWarnings` so degradations surface in the
 * console (visible) instead of silently dropping configured behavior.
 */

export {
  adaptWidgetPermissions,
  resolveHmiRole,
  HMI_ROLES,
} from './permissionsAdapter';
export type { AdaptedPermission } from './permissionsAdapter';

export { adaptWidgetEvents } from './eventsAdapter';
export type { AdaptedEvents } from './eventsAdapter';

export { adaptAnimationRules } from './animationsAdapter';
export type { AdaptedAnimations } from './animationsAdapter';

/** Log adapter degradation warnings visibly (once per call site). */
export function logAdapterWarnings(context: string, warnings: string[]): void {
  if (warnings.length === 0) return;
  console.warn(
    `[RuntimeWidgetRenderer] ${context}: ${warnings.length} unmapped item(s):`,
    warnings,
  );
}
