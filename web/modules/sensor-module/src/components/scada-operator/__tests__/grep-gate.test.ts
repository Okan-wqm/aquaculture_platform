/**
 * Grep-gate spec (T7g / T1):
 *  1. No `as unknown as` STORE-READ casts in scada-operator/** — the old
 *     pattern `(s as unknown as {...}).field` against useOperatorStore read
 *     `undefined` forever because the alarm runtime state never lived there.
 *  2. The standalone operatorStore.ts must not exist (ONE store).
 *  3. The dead alarm transport is gone: useAlarmRuntime (and anything under
 *     scada-operator/) must not reach for socketFactory's default-path
 *     `/socket.io/` sockets for `/scada` traffic.
 *
 * If this spec fails, a change reintroduced a second store or a dead socket
 * path — both shipped as production defects before.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

// vitest runs with cwd = the sensor-module root; src is <cwd>/src.
const SRC = resolve(process.cwd(), 'src');

/** Non-store shape casts that are explicitly allowed (documented here). */
const AS_UNKNOWN_AS_ALLOWLIST: string[] = [
  // Narrows a DOM event payload shape; not a store read.
  'components/scada-operator/widgets/RuntimeScheduler.tsx',
  // Narrows a legacy widget config shape; not a store read.
  'components/scada-operator/widgets/RuntimePipe.tsx',
];

function collectFiles(dir: string, exts: string[], acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      collectFiles(full, exts, acc);
    } else if (exts.some((e) => entry.endsWith(e))) {
      acc.push(full);
    }
  }
  return acc;
}

describe('grep-gate: one store, one transport, no cast reads', () => {
  it('scada-operator/** contains no `as unknown as` store-read casts', () => {
    const dir = join(SRC, 'components/scada-operator');
    const files = collectFiles(dir, ['.ts', '.tsx']);
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const rel = file.replace(SRC + '/', '');
      if (AS_UNKNOWN_AS_ALLOWLIST.includes(rel)) continue;
      const text = readFileSync(file, 'utf8');
      if (text.includes('as unknown as')) {
        offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the standalone operatorStore.ts no longer exists (ONE store)', () => {
    expect(existsSync(join(SRC, 'store/scada/operatorStore.ts'))).toBe(false);
  });

  it('nothing references useOperatorStore anymore', () => {
    const files = collectFiles(SRC, ['.ts', '.tsx']);
    const offenders = files.filter((file) => {
      const text = readFileSync(file, 'utf8');
      return text.includes('useOperatorStore');
    });
    expect(offenders.map((f) => f.replace(SRC + '/', ''))).toEqual([]);
  });

  it('useAlarmRuntime does not use the socketFactory default-path transport', () => {
    const hook = readFileSync(join(SRC, 'hooks/useAlarmRuntime.ts'), 'utf8');
    expect(hook).not.toContain("from './socketFactory'");
    expect(hook).not.toContain('getSocket(');

    // And no scada-operator component opens a raw socketFactory socket.
    const dir = join(SRC, 'components/scada-operator');
    for (const file of collectFiles(dir, ['.ts', '.tsx'])) {
      const text = readFileSync(file, 'utf8');
      expect(text).not.toContain('getSocket(');
    }
  });
});
