/**
 * Federated remotes must NOT create their own QueryClient / QueryClientProvider.
 *
 * WHY: a remote that wraps its tree in a SECOND QueryClientProvider gets a SEPARATE
 * React Query cache that the shell's tenant-scoped invalidation and logout
 * `queryClient.clear()` never reach — so its queries serve stale / cross-tenant data
 * after a tenant switch or logout. That was the hr-module bug (plan A6), fixed in
 * #682. A remote MUST consume the shell's QueryClient through the Module-Federation
 * shared singleton (federationSharedConfig), never instantiate its own.
 *
 * ALLOWED and excluded from the scan:
 *   - `main.tsx` — the standalone dev entry, which runs OUTSIDE the shell and
 *     legitimately needs its own provider; it is never loaded as a federated remote.
 *   - test files / `test` + `__tests__` dirs — test harnesses spin up their own client.
 *
 * Tier-3 "make it detectable": this gate fails CI the moment a remote re-introduces
 * a nested client, instead of the regression surfacing as a stale-cache bug in prod.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const MODULES_DIR = resolve(REPO_ROOT, 'web', 'modules');

const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', 'test', '__mocks__']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      out.push(...walk(full));
    } else if (
      /\.(ts|tsx)$/.test(entry) &&
      !/\.(spec|test)\.(ts|tsx)$/.test(entry) &&
      entry !== 'main.tsx'
    ) {
      out.push(full);
    }
  }
  return out;
}

describe('federated remotes do not nest a QueryClientProvider', () => {
  const moduleSrcDirs = readdirSync(MODULES_DIR)
    .map((m) => join(MODULES_DIR, m, 'src'))
    .filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
  const files = moduleSrcDirs.flatMap(walk);

  it('scans a non-empty set of remote source files', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no QueryClientProvider or new QueryClient() in federated remote code', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (/QueryClientProvider/.test(src) || /new\s+QueryClient\s*\(/.test(src)) {
        offenders.push(f.replace(`${REPO_ROOT}/`, ''));
      }
    }
    expect(offenders).toEqual([]);
  });
});
