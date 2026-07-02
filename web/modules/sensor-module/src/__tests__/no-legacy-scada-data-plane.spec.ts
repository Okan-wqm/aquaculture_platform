import { readFileSync, readdirSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

/**
 * Single-live-data-plane guard (enterprise plan Faz 6, SENSOR-HIGH-006).
 *
 * The legacy "Layer A" live-data path — the `/sensors` device-code
 * `useScadaLiveData` + `ScadaDataContext` (`context/ScadaDataProvider.tsx`)
 * — is now FULLY RETIRED. The sensor module has ONE live-data plane:
 * "Layer B", the `/scada` tag path (`IDataProvider` / `useDataProvider` /
 * `useRealtimeData`, tenant-fenced + registry-gated server side). The
 * builder preview canvas (`ScreenCanvas` via `StableModeProvider`) now
 * runs on Layer B like the operator.
 *
 * The allowlist is EMPTY: no file may import or use the legacy path. Any
 * reintroduction fails this test by construction, so the second data plane
 * cannot grow back.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

/** No file may couple to Layer A — the path is retired. */
const LEGACY_LAYER_A_ALLOWLIST = new Set<string>([]);

/**
 * Real couplings only — an `import` from the legacy modules, or an actual
 * usage of the legacy context/hook (call or JSX). Prose mentions in
 * comments (e.g. "same pattern as useScadaLiveData") are deliberately NOT
 * matched, and the guard spec itself is skipped.
 */
const LEGACY_MARKERS: RegExp[] = [
  /from\s+['"][^'"]*(?:context\/ScadaDataProvider|hooks\/useScadaLiveData)['"]/,
  /\buseScadaLiveData\s*\(/,
  /\buseScadaData(?:Optional)?\s*\(/,
  /\bScadaDataContext\b\s*[.<]/,
];

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, acc);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

describe('no-legacy-scada-data-plane guard', () => {
  const SELF = '__tests__/no-legacy-scada-data-plane.spec.ts';
  const offenders = new Map<string, number>();
  for (const file of walk(SRC)) {
    const rel = relative(SRC, file).split('\\').join('/');
    if (rel === SELF) continue;
    const content = readFileSync(file, 'utf8');
    const hits = LEGACY_MARKERS.filter((m) => m.test(content)).length;
    if (hits > 0) offenders.set(rel, hits);
  }

  it('no NEW file couples to the legacy Layer-A live-data path', () => {
    const unexpected = [...offenders.keys()].filter((f) => !LEGACY_LAYER_A_ALLOWLIST.has(f));
    expect(
      unexpected,
      `New coupling(s) to the retired Layer-A live-data plane. Use the canonical ` +
        `useDataProvider/useRealtimeData (/scada) path instead, or (if truly migrating ` +
        `the builder preview) update LEGACY_LAYER_A_ALLOWLIST. Offenders: ${JSON.stringify(unexpected)}`,
    ).toEqual([]);
  });

  it('allowlist has no stale entries (retirement only ratchets down)', () => {
    const stale = [...LEGACY_LAYER_A_ALLOWLIST].filter((f) => !offenders.has(f));
    expect(
      stale,
      `Allowlisted file(s) no longer import Layer-A — delete them from ` +
        `LEGACY_LAYER_A_ALLOWLIST so the guard keeps ratcheting: ${JSON.stringify(stale)}`,
    ).toEqual([]);
  });

  it('the duplicate/orphan Layer-A sim wrappers are gone', () => {
    expect(offenders.has('context/SimulationDataProvider.tsx')).toBe(false);
    expect(offenders.has('components/unified-editor/ConnectionStatusBanner.tsx')).toBe(false);
  });
});
