/**
 * ai-service tenant schema-routing architecture invariants (ORPHAN-HIGH-408).
 *
 * ai is a schema-per-tenant service: `search_path` routes every per-tenant
 * table into `tenant_<uuid>`. Two things must hold for that to work, and
 * ORPHAN-HIGH-408 broke the second one:
 *
 *  1. ENTITY placement — a per-tenant entity must NOT pin `schema: 'ai'`,
 *     because a schema-qualified entity bypasses TenantConnectionBootstrap and
 *     reads/writes the source template instead of the tenant.
 *  2. MIGRATION placement — the tenant provisioner REPLAYS post-baseline
 *     migrations into each tenant schema with `search_path` pinned and NO SQL
 *     text-rewrite. A `CREATE TABLE IF NOT EXISTS "ai"."x"` therefore targets
 *     the SOURCE schema on every tenant pass: the source gets the table, the
 *     `IF NOT EXISTS` no-ops for every tenant, and no tenant schema ever
 *     receives it. `1803000000000-CreateAiProposedActions` did exactly that,
 *     so `ai_proposed_actions` existed only in `ai` — and the MOB-HIGH-001
 *     confirm flow would have hit `relation "ai_proposed_actions" does not
 *     exist` for every tenant the moment ai-service came out of dormancy.
 *
 * Both classifications are DERIVED from `MODULE_SCHEMAS['ai']` rather than
 * from a hand-maintained copy: `tables` minus `infrastructureTables` IS the
 * per-tenant set (İ1 — one SSoT, no second list to drift).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { MODULE_SCHEMAS } from '@aquaculture/backend-common/database';

const AI_SRC = resolve(__dirname, '../../');
const AI_MIGRATIONS = join(AI_SRC, 'database/migrations');
const BASELINE_MIGRATION = '1800000000000-Baseline.ts';

const aiModule = MODULE_SCHEMAS.find((m) => m.moduleName === 'ai');
if (!aiModule) {
  throw new Error("MODULE_SCHEMAS has no 'ai' module — the SSoT this spec derives from is gone");
}

const INFRASTRUCTURE_TABLES = new Set(aiModule.infrastructureTables ?? []);
/** Per-tenant = declared, minus the cross-tenant infrastructure set. */
const PER_TENANT_TABLES = aiModule.tables.filter((t) => !INFRASTRUCTURE_TABLES.has(t));

interface EntityFile {
  relativePath: string;
  content: string;
  /** `content` with comments stripped — the rules judge code, not prose. */
  code: string;
  tableName: string | undefined;
  declaresSchema: boolean;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function findEntityFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
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

function readEntities(): EntityFile[] {
  return findEntityFiles(AI_SRC).map((file) => {
    const content = readFileSync(file, 'utf8');
    const code = stripComments(content);
    const decorator = /@Entity\(([\s\S]*?)\)\s*(?:@|export)/.exec(code)?.[1] ?? '';
    const positional = /^\s*['"]([a-z0-9_]+)['"]/.exec(decorator)?.[1];
    const named = /name:\s*['"]([a-z0-9_]+)['"]/.exec(decorator)?.[1];
    return {
      relativePath: file.slice(AI_SRC.length + 1),
      content,
      code,
      tableName: positional ?? named,
      declaresSchema: /schema:\s*['"]ai['"]/.test(decorator),
    };
  });
}

function migrationFiles(): { name: string; content: string }[] {
  return readdirSync(AI_MIGRATIONS)
    .filter((f) => /^\d+-.*\.ts$/.test(f))
    .map((name) => ({ name, content: readFileSync(join(AI_MIGRATIONS, name), 'utf8') }));
}

describe('ai-service tenant schema-routing architecture', () => {
  it('derives a non-empty per-tenant table set from MODULE_SCHEMAS', () => {
    expect(PER_TENANT_TABLES).toContain('ai_proposed_actions');
    expect(INFRASTRUCTURE_TABLES.has('tool_execution_audit')).toBe(true);
  });

  it('keeps per-tenant entities unqualified so search_path controls isolation', () => {
    const violations = readEntities()
      .filter((e) => e.tableName !== undefined && PER_TENANT_TABLES.includes(e.tableName))
      .filter((e) => e.declaresSchema)
      .map((e) => `${e.relativePath} (${e.tableName ?? '?'})`);

    expect(violations).toEqual([]);
  });

  it('keeps cross-tenant infrastructure entities schema-qualified', () => {
    // The mirror half: an infrastructure table that LOSES its `schema:` would
    // be routed per tenant and its cross-tenant row stream would fragment.
    const violations = readEntities()
      .filter((e) => e.tableName !== undefined && INFRASTRUCTURE_TABLES.has(e.tableName))
      .filter((e) => !e.declaresSchema)
      .map((e) => `${e.relativePath} (${e.tableName ?? '?'})`);

    expect(violations).toEqual([]);
  });

  it('creates every post-baseline per-tenant table with UNQUALIFIED DDL so the replay lands it in each tenant', () => {
    const migrations = migrationFiles();
    const baseline = migrations.find((m) => m.name === BASELINE_MIGRATION)?.content ?? '';
    const postBaseline = migrations.filter((m) => m.name !== BASELINE_MIGRATION);

    const unreachable: string[] = [];
    for (const table of PER_TENANT_TABLES) {
      // Tables the Baseline creates are cloned into new tenant schemas by
      // TenantSchemaSyncService (CREATE TABLE LIKE), so they are reachable
      // without a post-baseline CREATE.
      if (new RegExp(`"ai"\\."${table}"`).test(baseline)) continue;

      const hasUnqualifiedCreate = postBaseline.some((m) =>
        new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?"${table}"`).test(m.content),
      );
      if (!hasUnqualifiedCreate) {
        unreachable.push(table);
      }
    }

    expect(unreachable).toEqual([]);
  });

  it('declares ai_proposed_actions timestamps as timestamptz, matching the DDL that created it', () => {
    // The heal migration created/converted `executedAt`, `createdAt` and
    // `updatedAt` to `timestamptz`. An entity still declaring naive
    // `timestamp` is live entity↔DDL drift in the opposite direction: TypeORM
    // would map an aware column through a naive type and silently drop the
    // offset on an actuation audit trail.
    const entity = readEntities().find((e) => e.tableName === 'ai_proposed_actions');
    expect(entity).toBeDefined();

    const source = entity?.code ?? '';
    expect(source).not.toMatch(/type:\s*'timestamp'/);
    // The generated audit columns must be explicit too — a bare
    // @CreateDateColumn() resolves to `timestamp without time zone`.
    for (const decorator of ['CreateDateColumn', 'UpdateDateColumn']) {
      const match = new RegExp(`@${decorator}\\(([^)]*)\\)`).exec(source);
      expect(match).not.toBeNull();
      expect(match?.[1]).toContain("type: 'timestamptz'");
    }
  });
});
