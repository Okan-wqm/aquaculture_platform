/**
 * Single source of truth for READING a widget's tag binding.
 *
 * Historically the builder/preview read `config.tagName || config.tag`
 * (ScreenCanvas, ScadaViewport) while the operator runtime read
 * `config.tagId` (OperatorView) — the same widget bound different tags in
 * the two runtimes. Every runtime now resolves the binding through this
 * accessor; the precedence starts at the canonical `config.tagRef`
 * (ScadaPackageDocV2) and falls back through the legacy keys until the
 * Faz 6 backfill removes them.
 *
 * All live-data paths are keyed by DEVICE-LOCAL tag names today, so a full
 * `deviceCode/localName` TagRef is reduced to its local segment here.
 */

import { isTagRef, splitTagRef } from '@platform/sensor-contracts';

/** Binding keys in canonical-first precedence order. */
const BINDING_KEYS = ['tagRef', 'tagName', 'tag', 'tagId'] as const;

/** Reduce a binding value to the device-local tag name runtimes key on. */
export function localTagFromBindingValue(value: string): string {
  return isTagRef(value) ? splitTagRef(value).localName : value;
}

/**
 * Resolve the widget's primary tag binding as a device-local tag name.
 * Returns undefined for unbound widgets.
 */
export function getWidgetTagBinding(
  config: Record<string, unknown> | undefined | null,
): string | undefined {
  if (!config) return undefined;
  for (const key of BINDING_KEYS) {
    const value = config[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return localTagFromBindingValue(value.trim());
    }
  }
  return undefined;
}
