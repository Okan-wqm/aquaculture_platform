/**
 * SetPropertyHandler — Event action that dynamically changes a widget's config property.
 *
 * Enables interactive UX patterns like: click button -> change another widget's
 * color/text/visibility without scripting.
 *
 * The action specifies targetWidgetId, propertyPath, and value. The handler
 * resolves the widget in the store and applies a partial config update.
 * Property paths are dot-separated for nested properties (e.g., 'fill', 'config.opacity').
 *
 * SECURITY: Property paths are validated against a safe-list pattern to prevent
 * prototype pollution attacks. Only alphanumeric keys with dots are allowed.
 * Paths containing '__proto__', 'constructor', or 'prototype' are rejected.
 */

import type { EventHandler } from '../types';

/** Dangerous property path segments that could enable prototype pollution */
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** Validates a property path is safe to use for object traversal */
function isPropertyPathSafe(path: string): boolean {
  if (!path || path.length === 0 || path.length > 200) return false;

  // Only allow alphanumeric characters, dots, underscores, and hyphens
  if (!/^[a-zA-Z0-9_.-]+$/.test(path)) return false;

  // Reject paths containing forbidden segments
  const segments = path.split('.');
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return false;
    if (segment.length === 0) return false; // reject consecutive dots
  }

  return true;
}

/**
 * Sets a nested property on an object using a dot-separated path.
 * Creates intermediate objects as needed.
 *
 * @param obj   - The root object to modify
 * @param path  - Dot-separated property path (e.g., 'config.fill')
 * @param value - The value to set at the resolved path
 */
function setNestedProperty(
  obj: Record<string, unknown>,
  path: string,
  value: string | number | boolean,
): void {
  const segments = path.split('.');
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    if (typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }

  const lastKey = segments[segments.length - 1];
  current[lastKey] = value;
}

interface WidgetStoreActions {
  updateWidget: (screenId: string, widgetId: string, updates: Record<string, unknown>) => void;
}

export function createSetPropertyHandler(store: WidgetStoreActions): EventHandler {
  return (event) => {
    if (event.action !== 'setProperty') return;

    const { targetWidgetId, propertyPath, propertyValue } = event.params;

    if (!targetWidgetId || !propertyPath || propertyValue === undefined) return;

    // Security: validate the property path before applying
    if (!isPropertyPathSafe(propertyPath)) {
      console.warn(
        `[SetPropertyHandler] Rejected unsafe property path: "${propertyPath}"`,
      );
      return;
    }

    // Build a partial config update object from the dot-separated path
    const configUpdate: Record<string, unknown> = {};
    setNestedProperty(configUpdate, propertyPath, propertyValue);

    store.updateWidget(event.screenId, targetWidgetId, { config: configUpdate });
  };
}

// Re-export the safety check for testing
export { isPropertyPathSafe as _isPropertyPathSafe };
