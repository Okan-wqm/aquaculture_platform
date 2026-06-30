/**
 * INVARIANT: farm-service read query-handlers read through runInTenantRead.
 *
 * WHY: a GraphQL read query-handler must read through the fail-closed
 * `runInTenantRead` boundary, which pins AND asserts `search_path` +
 * the `app.current_tenant` RLS GUC before any domain query runs. A raw
 * `@InjectRepository` read relies only on pool-checkout search_path: a lost or
 * wrong tenant context then resolves silently against the source `farm` schema
 * or RLS-denies to an empty result — indistinguishable from a legitimately
 * empty table. That is the platform's "data appears then disappears" failure
 * mode (Farm Data SSOT plan §3-A). This invariant fails the build if a NEW read
 * query-handler reintroduces `@InjectRepository`.
 *
 * Scope: every `*.handler.ts` under `apps/farm-service/src` whose class
 * implements `IQueryHandler`. Command handlers use `ICommandHandler` and own
 * their transaction via `runInTenantTransaction` (tracked under plan Task #9
 * write side, not gated here).
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, relative, normalize, join, sep } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FARM_SRC = resolve(REPO_ROOT, 'apps/farm-service/src');

/**
 * Read query-handlers that legitimately do NOT yet read through
 * `runInTenantRead`. Each entry is tracked; do NOT add to this list without a
 * registered finding. The list MUST shrink as the tracked work lands — the
 * second test below fails if an allowlisted file no longer uses
 * `@InjectRepository` (migrated but left stale here).
 *
 * Paths are POSIX-relative to apps/farm-service/src.
 */
const READ_BOUNDARY_ALLOWLIST = new Set<string>([
  // Reference-data reads (per-tenant catalogs read via a request-context
  // tenantId rather than a query field) + a service-delegating read. These do
  // not yet route through a boundary; tracked under plan Task #23 / #9-tail.
  // (get-farm migrated in FARM-* Task #23: tenant path → runInTenantRead,
  // federation __resolveReference → runInSourceRead.)
  // get-batch-performance.handler.ts migrated to runInTenantRead (read-boundary
  // straggler remediation, ORPHAN-MEDIUM-264) → removed from this allowlist.
  'equipment/handlers/get-equipment-types.handler.ts',
  'equipment/handlers/get-sub-equipment-types.handler.ts',
  // Delegates to the shared paginateCursor(repository, …) primitive; routing it
  // through the boundary needs paginateCursor to accept a boundary-scoped
  // manager first (plan Task #9 tail).
  'storage/handlers/list-storage-inventory-by-cursor.handler.ts',
]);

function findHandlerFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        files.push(...findHandlerFiles(fullPath));
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.handler.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function toPosix(p: string): string {
  return p.split(sep).join('/');
}

interface HandlerFile {
  readonly relativePath: string;
  readonly content: string;
}

function readQueryHandlers(): HandlerFile[] {
  return findHandlerFiles(FARM_SRC)
    .map((file) => ({
      relativePath: toPosix(normalize(relative(FARM_SRC, file))),
      content: readFileSync(file, 'utf-8'),
    }))
    .filter(({ content }) => /\bIQueryHandler\b/.test(content));
}

/**
 * Resolver-level read boundary (ORPHAN-MEDIUM-264). The query-handler invariant
 * above misses reads done DIRECTLY in a GraphQL resolver via
 * `this.<x>Repository.find*` on the shared pool — the same fail-closed gap
 * (`growthMeasurement(id)` / `feedingRecord(id)` shipped this way). A resolver
 * must read a tenant-scoped entity through `runInTenantRead` (or delegate to the
 * query bus), never off a raw `@InjectRepository` handle. The remaining direct-
 * read resolvers are tracked deferrals (ORPHAN-MEDIUM-265); the list MUST shrink.
 */
const DIRECT_REPO_READ = /this\.[a-zA-Z]+Repository\.(find|findOne|findAndCount|count|createQueryBuilder)\b/;

const RESOLVER_READ_BOUNDARY_ALLOWLIST = new Set<string>([
  'batch/resolvers/cleaner-fish.resolver.ts',
  'chemical/chemical.resolver.ts',
  'feed/feed.resolver.ts',
  'feeding/resolvers/feeding-program.resolver.ts',
  'supplier/supplier.resolver.ts',
  'tank/resolvers/tank.resolver.ts',
]);

function findResolverFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        files.push(...findResolverFiles(fullPath));
      }
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.resolver.ts') && !entry.name.endsWith('.spec.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

function readResolvers(): HandlerFile[] {
  return findResolverFiles(FARM_SRC).map((file) => ({
    relativePath: toPosix(normalize(relative(FARM_SRC, file))),
    content: readFileSync(file, 'utf-8'),
  }));
}

describe('INVARIANT: farm resolvers route tenant reads through the boundary', () => {
  it('has no resolver reading a tenant entity via raw this.<x>Repository (outside the tracked allowlist)', () => {
    const violations = readResolvers()
      .filter(({ relativePath }) => !RESOLVER_READ_BOUNDARY_ALLOWLIST.has(relativePath))
      .filter(({ content }) => DIRECT_REPO_READ.test(content))
      .map(({ relativePath }) => relativePath);

    expect(violations).toEqual([]);
  });

  it('keeps the resolver deferral allowlist honest — every entry still does a direct repository read', () => {
    const stale: string[] = [];
    for (const relativePath of RESOLVER_READ_BOUNDARY_ALLOWLIST) {
      const absolute = resolve(FARM_SRC, relativePath);
      if (!existsSync(absolute)) {
        stale.push(`${relativePath} (file no longer exists)`);
        continue;
      }
      if (!DIRECT_REPO_READ.test(readFileSync(absolute, 'utf-8'))) {
        stale.push(`${relativePath} (now reads through the boundary — remove from allowlist)`);
      }
    }

    expect(stale).toEqual([]);
  });
});

describe('INVARIANT: farm read query-handlers route through the tenant boundary', () => {
  it('has no read query-handler reading via raw @InjectRepository (outside the tracked allowlist)', () => {
    const violations = readQueryHandlers()
      .filter(({ relativePath }) => !READ_BOUNDARY_ALLOWLIST.has(relativePath))
      .filter(({ content }) => /@InjectRepository/.test(content))
      .map(({ relativePath }) => relativePath);

    expect(violations).toEqual([]);
  });

  it('keeps the deferral allowlist honest — every entry still exists and still reads outside the boundary', () => {
    const stale: string[] = [];
    for (const relativePath of READ_BOUNDARY_ALLOWLIST) {
      const absolute = resolve(FARM_SRC, relativePath);
      if (!existsSync(absolute)) {
        stale.push(`${relativePath} (file no longer exists)`);
        continue;
      }
      const content = readFileSync(absolute, 'utf-8');
      if (!/\bIQueryHandler\b/.test(content)) {
        stale.push(`${relativePath} (no longer a query-handler)`);
        continue;
      }
      if (!/@InjectRepository/.test(content)) {
        stale.push(`${relativePath} (now reads through the boundary — remove from allowlist)`);
      }
    }

    expect(stale).toEqual([]);
  });
});
