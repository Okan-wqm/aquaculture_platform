import { readFileSync, readdirSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';

import { describe, expect, it } from 'vitest';

/**
 * Live-data-plane consolidation guard (enterprise plan Faz 6).
 *
 * The sensor module has TWO live-data generations:
 *   - Legacy "Layer A": the `/sensors` device-code path — `useScadaLiveData`
 *     + `ScadaDataContext` (`context/ScadaDataProvider.tsx`).
 *   - Canonical "Layer B": the `/scada` tag path — `IDataProvider` /
 *     `useDataProvider` / `useRealtimeData` (tenant-fenced, registry-gated
 *     server side).
 *
 * Layer B is the single data plane going forward. Layer A survives ONLY
 * as the builder-preview canvas dependency (`ScreenCanvas` via
 * `StableModeProvider`) pending its migration (tracked:
 * SENSOR-HIGH-006). This guard freezes the blast radius: the set of files
 * importing the legacy context/hook may only SHRINK. Any NEW importer
 * fails this test — so the retirement cannot silently regrow, and the
 * next migration PR deletes entries here as it removes them.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..');

/**
 * The COMPLETE allowlist of files still coupled to Layer A. Every path is
 * relative to `src/`. Removing a coupling means deleting its line here;
 * adding a new Layer-A importer is a test failure by construction.
 */
const LEGACY_LAYER_A_ALLOWLIST = new Set<string>([
  // The legacy provider + hook themselves (definition sites).
  'context/ScadaDataProvider.tsx',
  'hooks/useScadaLiveData.ts',
  'hooks/__tests__/useScadaLiveData.tenant-isolation.test.ts',
  // The one remaining live consumer chain — the builder preview canvas.
  'components/scada-builder/StableModeProvider.tsx',
  'components/scada-builder/ScreenCanvas.tsx',
]);

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
