/**
 * Tenant schema routing architecture invariants.
 *
 * WHY: farm-service uses schema-per-tenant routing through PostgreSQL
 * search_path. Tenant-owned entities must not pin `schema: 'farm'`, because
 * explicit schema-qualified SQL bypasses TenantConnectionBootstrap and can
 * write/read source-schema data instead of the current tenant schema.
 *
 * ## Why the permitted set is DERIVED, not listed here (ORPHAN-MEDIUM-118)
 *
 * This spec used to carry a hand-written allowlist of file paths. That copy
 * drifted from the real cross-tenant set the moment anyone added an
 * infrastructure table without also editing this file — and because the whole
 * integration lane that owns this spec was never invoked by CI, the drift went
 * unseen: `farm_audit_logs` and `tenant_erasure_audit` are legitimately
 * cross-tenant, declare `schema: 'farm'` correctly, and were reported as
 * violations for months.
 *
 * The authoritative set of farm tables that live once in the source schema
 * (rather than being cloned into `tenant_<uuid>`) is
 * `MODULE_SCHEMAS['farm'].infrastructureTables` — the same list that drives
 * tenant provisioning and the strict-ownership reconciler. Deriving from it
 * makes the two structurally incapable of disagreeing (tier-1): declaring a new
 * cross-tenant table there permits its entity automatically, and pinning
 * `schema: 'farm'` on an entity whose table is NOT declared cross-tenant fails
 * here — which is exactly the bug worth catching.
 *
 * The inverse direction (a cross-tenant table that FORGETS `schema:`) is guarded
 * by `e2e/tests/integration/schema-invariants.spec.ts` B.1/B.2, so it is not
 * duplicated here.
 */
import * as fs from 'fs';
import * as path from 'path';

import { MODULE_SCHEMAS } from '@aquaculture/backend-common/database';

const SRC_ROOT = path.resolve(__dirname, '../../');

/** Farm tables that live ONCE in the source schema — the provisioning SSoT. */
function farmSourceSchemaTables(): ReadonlySet<string> {
  const farm = MODULE_SCHEMAS.find((module) => module.moduleName === 'farm');
  if (!farm) {
    throw new Error("MODULE_SCHEMAS has no 'farm' module — the SSoT this spec derives from is gone");
  }
  return new Set(farm.infrastructureTables ?? []);
}

function findEntityFiles(dir: string): string[] {
  const files: string[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        files.push(...findEntityFiles(fullPath));
      }
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.entity.ts')) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * The argument list of the `@Entity(...)` call, extracted with balanced
 * parentheses. A regex terminating at the first `)` would truncate the common
 * `@Entity('x', { schema: 'farm' })` form the moment an option value contained
 * one, and silently report "no table name".
 */
function entityDecoratorArgs(source: string): string | null {
  const start = source.indexOf('@Entity(');
  if (start === -1) return null;

  let index = start + '@Entity('.length;
  let depth = 1;
  while (index < source.length && depth > 0) {
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      const quote = char;
      index += 1;
      while (index < source.length && source[index] !== quote) {
        index += source[index] === '\\' ? 2 : 1;
      }
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) break;
    }
    index += 1;
  }

  return source.slice(start + '@Entity('.length, index);
}

/** Both supported shapes: `@Entity('t', {...})` and `@Entity({ name: 't' })`. */
function tableNameOf(source: string): string | null {
  const args = entityDecoratorArgs(source);
  if (args === null) return null;

  const positional = /^\s*'([^']+)'/.exec(args);
  if (positional) return positional[1] ?? null;

  const named = /\bname:\s*'([^']+)'/.exec(args);
  return named?.[1] ?? null;
}

interface PinnedEntity {
  relativePath: string;
  tableName: string | null;
}

function entitiesPinningSourceSchema(): PinnedEntity[] {
  return findEntityFiles(SRC_ROOT)
    .map((file) => ({
      relativePath: path.normalize(path.relative(SRC_ROOT, file)),
      content: fs.readFileSync(file, 'utf-8'),
    }))
    .filter(({ content }) => /@Entity\([\s\S]*?schema:\s*'farm'/.test(content))
    .map(({ relativePath, content }) => ({ relativePath, tableName: tableNameOf(content) }));
}

describe('Tenant schema routing architecture', () => {
  it('keeps tenant-owned entities unqualified so search_path controls tenant isolation', () => {
    const crossTenant = farmSourceSchemaTables();

    const violations = entitiesPinningSourceSchema()
      .filter(({ tableName }) => tableName === null || !crossTenant.has(tableName))
      .map(({ relativePath, tableName }) => `${relativePath} (table: ${tableName ?? 'UNRESOLVED'})`);

    expect(violations).toEqual([]);
  });

  it('derives the permitted set from the provisioning SSoT, not a local copy', () => {
    const crossTenant = farmSourceSchemaTables();

    // A refactor that empties or renames the SSoT must not turn this gate into
    // a silent pass — the set is load-bearing, so its shape is asserted.
    expect(crossTenant.size).toBeGreaterThan(0);
    expect(crossTenant.has('outbox_events')).toBe(true);
  });

  it('resolves a table name for every entity that pins the source schema', () => {
    // An unresolved name would make the check above vacuous for that file.
    const unresolved = entitiesPinningSourceSchema()
      .filter(({ tableName }) => tableName === null)
      .map(({ relativePath }) => relativePath);

    expect(unresolved).toEqual([]);
  });
});
