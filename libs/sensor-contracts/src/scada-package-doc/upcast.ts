/**
 * @module ScadaPackageDocUpcaster
 *
 * V1 → V2 upcaster for the SCADA package document, mirroring the upcaster
 * discipline of `libs/event-contracts/src/upcasters/`: pure function, never
 * mutates its input, applied at every read boundary until the one-time
 * backfill migration rewrites stored documents (enterprise plan Faz 6).
 *
 * The critical V1 defect this closes: the builder read `config.tagName`
 * while the operator runtime read `config.tagId`, so the same widget bound
 * different tags in the two runtimes. V2 canonicalises the binding into
 * `config.tagRef` (a full `deviceCode/localName` TagRef). Legacy keys are
 * PRESERVED so not-yet-migrated readers keep working.
 */

import { isTagRef } from '../tag-ref';

import {
  SCADA_PACKAGE_DOC_SCHEMA_VERSION,
  ScadaPackageDocV2,
} from './scada-package-doc.types';

export interface UpcastContext {
  /**
   * Device code of the package's bound edge device, when the caller can
   * supply it (backend resolves `meta.edgeDeviceId` → deviceCode; the
   * builder knows its selected device). Without it, legacy DEVICE-LOCAL
   * tag names cannot be promoted to full TagRefs and are left as-is for
   * the reader-side fallback chain.
   */
  deviceCode?: string;
}

/** Legacy widget binding keys, in precedence order. */
const LEGACY_BINDING_KEYS = ['tagName', 'tag', 'tagId'] as const;

function canonicalTagRefFor(
  config: Record<string, unknown>,
  ctx?: UpcastContext,
): string | undefined {
  const existing = config['tagRef'];
  if (typeof existing === 'string' && isTagRef(existing)) return existing;

  for (const key of LEGACY_BINDING_KEYS) {
    const value = config[key];
    if (typeof value !== 'string' || value.length === 0) continue;
    // A legacy value that already IS a full ref adopts directly.
    if (isTagRef(value)) return value;
    // A device-local name promotes only when the device is known.
    if (ctx?.deviceCode) {
      const candidate = `${ctx.deviceCode}/${value}`;
      if (isTagRef(candidate)) return candidate;
    }
    // First present key wins the precedence — do not fall through to
    // weaker keys once a binding value exists.
    return undefined;
  }
  return undefined;
}

// Upcasters operate on Record<string, unknown> in and out (the
// event-contracts upcaster discipline); the typed claim is made once, at
// the public boundary, and the schema validator is the actual guarantee.
function upcastWidget(
  raw: Record<string, unknown>,
  ctx?: UpcastContext,
): Record<string, unknown> {
  const config = { ...((raw['config'] as Record<string, unknown>) ?? {}) };
  const tagRef = canonicalTagRefFor(config, ctx);
  if (tagRef !== undefined) {
    config['tagRef'] = tagRef;
  }
  return { ...raw, config };
}

function upcastScreen(
  raw: Record<string, unknown>,
  ctx?: UpcastContext,
): Record<string, unknown> {
  const widgets = Array.isArray(raw['widgets']) ? raw['widgets'] : [];
  return {
    ...raw,
    widgets: widgets.map((w) => upcastWidget((w ?? {}) as Record<string, unknown>, ctx)),
  };
}

/**
 * Upcast any stored SCADA package document to the current V2 shape.
 * Idempotent: a V2 document passes through with only widget-binding
 * canonicalisation re-applied (a no-op when `tagRef` is already set).
 *
 * @throws TypeError when `raw` is not an object document at all.
 */
export function upcastScadaPackageDoc(
  raw: unknown,
  ctx?: UpcastContext,
): ScadaPackageDocV2 {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('ScadaPackageDoc upcast: document must be a JSON object');
  }
  const doc = raw as Record<string, unknown>;
  const meta = { ...((doc['meta'] as Record<string, unknown>) ?? {}) };
  const screens = Array.isArray(doc['screens']) ? doc['screens'] : [];

  const upcasted: Record<string, unknown> = {
    ...doc,
    meta: {
      ...meta,
      schemaVersion: SCADA_PACKAGE_DOC_SCHEMA_VERSION,
    },
    screens: screens.map((s) => upcastScreen((s ?? {}) as Record<string, unknown>, ctx)),
  };
  return upcasted as ScadaPackageDocV2;
}
