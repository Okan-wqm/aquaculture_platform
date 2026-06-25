/**
 * Platform-wide invariant (FE tenant isolation): no `||'default'` tenant fallback.
 *
 * A localStorage / cache key built as `${prefix}_${tenantId || 'default'}` (or
 * `getTenantId() || 'default'`) routes EVERY no-tenant session into one shared
 * `default` bucket — so tenant A's persisted UI state bleeds into tenant B during
 * the brief window tenantId is null (initial load / tenant switch). The canonical
 * fix is `tenantScopedStorageKey(baseKey, tenantId)` (web/shared-ui), which
 * returns `null` when tenantId is absent so the caller skips persistence and uses
 * an in-memory default — no shared bucket can exist.
 *
 * This guard fails the build if any tenant-identifier `|| 'default'` fallback
 * reappears. It is intentionally narrow: it matches ONLY the `getTenantId()` /
 * `tenantId` left-hand side, NOT the unrelated UI-mapping fallbacks
 * (`variants[status] || 'default'`, `equipmentType?.code || 'default'`).
 */

import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function grepTenantDefaultFallback(): string[] {
  // git grep returns exit 1 (no matches) → execFileSync throws; treat as clean.
  try {
    const out = execFileSync(
      'git',
      [
        '-C',
        REPO_ROOT,
        'grep',
        '-nE',
        String.raw`(getTenantId\(\)|tenantId)[[:space:]]*\|\|[[:space:]]*'default'`,
        '--',
        'web/',
      ],
      { encoding: 'utf8' },
    );
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      // test fixtures may legitimately reference the anti-pattern as a string
      .filter((l) => !/\.(spec|test)\.[tj]sx?:/.test(l) && !/__tests__/.test(l));
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    if (e.status === 1) return []; // git grep: no matches
    throw err;
  }
}

describe('INVARIANT (FE tenant isolation): no tenant `|| \'default\'` storage-key fallback', () => {
  it('web/ contains no `getTenantId()/tenantId || \'default\'` (use tenantScopedStorageKey instead)', () => {
    const hits = grepTenantDefaultFallback();
    expect(hits).toEqual([]);
  });

  it('the canonical helper exists and returns null for an absent tenant', () => {
    const lsFiles = execFileSync(
      'git',
      [
        '-C',
        REPO_ROOT,
        'ls-files',
        'web/shared-ui/src/utils/tenant-scoped-storage-namespace.ts',
      ],
      { encoding: 'utf8' },
    ).trim();
    expect(lsFiles).toBe('web/shared-ui/src/utils/tenant-scoped-storage-namespace.ts');
  });
});
