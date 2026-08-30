#!/usr/bin/env node
/**
 * scripts/schema-registry/generate-init-schemas.ts
 * =============================================================================
 *
 * Regenerates the `# BEGIN GENERATED` region of
 * `infrastructure/docker/init-scripts/00-init-schemas.sh` from
 * `apps/db-migrate/src/schema-registry.ts`.
 *
 * # Why this codegen exists
 *
 * `SCHEMA_REGISTRY` is the Single Source of Truth for which service owns
 * which schema. `00-init-schemas.sh` runs at postgres container init and
 * must CREATE SCHEMA + grant privileges for every entry. When the two lists
 * drift (schema added to SCHEMA_REGISTRY but not init-schemas.sh), deploy
 * fails at migration-orchestrator time with
 *   search_path pin verification failed for "<schema>"
 * because the schema never existed in the database.
 *
 * This generator emits deterministic SQL between the
 *   # BEGIN GENERATED — schema-registry
 *   # END GENERATED — schema-registry
 * sentinels. Hand-written parts outside the sentinels (password handling,
 * TimescaleDB extension install, per-service special grants) are preserved.
 *
 * # Invocation
 *
 *   npm run codegen:schema-registry
 *
 * CI (in `.github/workflows/ci-affected.yml`) runs the generator and
 * `git diff --exit-code` to detect drift. A PR that edits SCHEMA_REGISTRY
 * without regenerating fails the drift check.
 *
 * # Determinism
 *
 * Output is byte-identical across runs on the same SCHEMA_REGISTRY. No
 * timestamps, no order flips. `public` schema is skipped (PostgreSQL
 * creates it automatically).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SCHEMA_REGISTRY } from '../../apps/db-migrate/src/schema-registry.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const INIT_SCRIPT_PATH = resolve(
  REPO_ROOT,
  'infrastructure/docker/init-scripts/00-init-schemas.sh',
);
const BEGIN = '# BEGIN GENERATED — schema-registry';
const END = '# END GENERATED — schema-registry';

/** Safe SQL identifier regex — must match the regex used by both runners. */
const SAFE_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Cross-service shared tables (ADR-011 §"shared schema").
 *
 * The `shared` schema is the ONE designated cross-service write surface.
 * Every service that imports `AuditLogModule` from
 * `@aquaculture/backend-common` writes to `shared.audit_logs`; auth-service
 * writes/reads `shared.gdpr_data_requests` + `shared.user_consents`.
 *
 * SchemaDriftValidator runs per-service-role queries against
 * `information_schema.columns`. PostgreSQL filters that view by privilege
 * — a role with no grant on `shared.audit_logs` sees ZERO columns, and
 * the validator (correctly given its inputs, incorrectly given the
 * actual DB shape) reports "DB has no such column" for every entity-
 * declared field. Without grants, every service that registers a shared
 * entity emits a false-positive drift block for `shared.*`.
 *
 * Mirrors `SHARED_SCHEMA_TABLES` in
 * `e2e/tests/integration/schema-invariants.spec.ts`. Adding a new
 * shared table requires updating BOTH constants in the same PR; the
 * invariant test catches drift between them.
 *
 * 2026-05-18 (Faz 4 of day-one baseline reset): `access_logs` promoted
 * to the canonical shared list. The table exists in the live shared
 * schema (admin-api migration 1788400-CreateSharedAccessLogs) and is
 * declared in protected-tables.ts as a compliance-critical surface;
 * its absence here would create a SSoT drift the next reset cycle.
 *
 * 2026-07-12 (ADR-042, ORPHAN-HIGH-378): `user_permissions` RETIRED from
 * the canonical list. It was a dead parallel permission catalog owned by
 * admin-api; the live RBAC SSoT is the auth-service tenant RBAC
 * (auth.tenant_role_permissions.panel_permissions). Archived into
 * admin.retired_config_backups + dropped by admin-api migration
 * 1801500000000-DropRetiredUserPermissions.
 */
const SHARED_SCHEMA_TABLES = [
  'audit_logs',
  'gdpr_data_requests',
  'user_consents',
  'access_logs',
] as const;

function assertSafeIdent(name: string, context: string): void {
  if (!SAFE_IDENT_RE.test(name)) {
    throw new Error(
      `[generate-init-schemas] Unsafe SQL identifier in ${context}: "${name}". ` +
        `Must match ${SAFE_IDENT_RE.source}.`,
    );
  }
}

function buildGeneratedBlock(): string {
  const entries = SCHEMA_REGISTRY.filter(
    (e): e is typeof e & { role: string } => typeof e.role === 'string',
  );

  for (const e of entries) {
    assertSafeIdent(e.schema, `schema for service "${e.service}"`);
    assertSafeIdent(e.role, `role for service "${e.service}"`);
  }

  const lines: string[] = [];
  lines.push('  -- Source: apps/db-migrate/src/schema-registry.ts');
  lines.push('  -- Regenerate with: npm run codegen:schema-registry');
  lines.push('');
  lines.push('  -- Create schemas owned by their service roles');
  for (const e of entries) {
    lines.push(
      `  CREATE SCHEMA IF NOT EXISTS ${e.schema} AUTHORIZATION ${e.role};`,
    );
  }
  lines.push('');
  lines.push(
    '  -- Idempotent ownership fix: ALTER OWNER ensures correct owner even',
  );
  lines.push(
    '  -- when the schema already existed before this init ran (IF NOT',
  );
  lines.push('  -- EXISTS skips the AUTHORIZATION clause in that case).');
  for (const e of entries) {
    lines.push(`  ALTER SCHEMA ${e.schema} OWNER TO ${e.role};`);
  }
  lines.push('');
  lines.push('  -- Shared POSTGRES_USER access (backward compat — services still');
  lines.push('  -- connect as POSTGRES_USER in some paths until full role cutover).');
  for (const e of entries) {
    lines.push(`  GRANT USAGE ON SCHEMA ${e.schema} TO \${POSTGRES_USER};`);
  }
  lines.push('');
  for (const e of entries) {
    lines.push(
      `  GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${e.schema} TO \${POSTGRES_USER};`,
    );
  }
  lines.push('');
  for (const e of entries) {
    lines.push(
      `  GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${e.schema} TO \${POSTGRES_USER};`,
    );
  }
  lines.push('');
  lines.push('  -- Default privileges for future objects in each schema');
  for (const e of entries) {
    lines.push(
      `  ALTER DEFAULT PRIVILEGES IN SCHEMA ${e.schema} GRANT ALL ON TABLES TO \${POSTGRES_USER};`,
    );
  }
  lines.push('');
  for (const e of entries) {
    lines.push(
      `  ALTER DEFAULT PRIVILEGES IN SCHEMA ${e.schema} GRANT ALL ON SEQUENCES TO \${POSTGRES_USER};`,
    );
  }
  lines.push('');

  // ── Shared schema grants — service-role visibility on cross-service tables ──
  //
  // Why this block exists: SchemaDriftValidator runs as the per-service
  // DB role; PostgreSQL's information_schema.columns filters by privilege,
  // so a role with no grant on shared.audit_logs sees ZERO columns and
  // emits a false-positive drift block. Granting USAGE + table-level
  // SELECT/INSERT/UPDATE/DELETE to every service role makes the column
  // metadata visible AND matches what services actually need at runtime
  // (every service that imports AuditLogModule writes to shared.audit_logs).
  //
  // Grants are uniform across service roles — uniform granting is
  // simpler than per-service slicing AND matches the "shared schema is by
  // design cross-service" architectural premise.
  //
  // Sequences: shared tables use uuid PKs (no sequences) but the GRANT
  // ALL ON SEQUENCES line is included for forward compat — adding a
  // sequence-bearing column to a shared table later does not require
  // regenerating grants per service.
  lines.push('  -- Shared schema grants (cross-service write surface, ADR-011)');
  lines.push('  -- Source-of-truth: SHARED_SCHEMA_TABLES in this codegen + spec');
  lines.push(
    `  CREATE SCHEMA IF NOT EXISTS shared AUTHORIZATION \${POSTGRES_USER};`,
  );
  lines.push('');
  for (const e of entries) {
    lines.push(`  GRANT USAGE ON SCHEMA shared TO ${e.role};`);
  }
  lines.push('');
  for (const tbl of SHARED_SCHEMA_TABLES) {
    assertSafeIdent(tbl, `shared schema table`);
    for (const e of entries) {
      lines.push(
        `  GRANT SELECT, INSERT, UPDATE, DELETE ON shared.${tbl} TO ${e.role};`,
      );
    }
    lines.push('');
  }
  for (const e of entries) {
    lines.push(
      `  ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${e.role};`,
    );
  }
  lines.push('');
  for (const e of entries) {
    lines.push(
      `  ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT USAGE, SELECT ON SEQUENCES TO ${e.role};`,
    );
  }
  return lines.join('\n');
}

function splice(target: string, generated: string): string {
  const beginIdx = target.indexOf(BEGIN);
  const endIdx = target.indexOf(END);
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
    throw new Error(
      `[generate-init-schemas] Sentinels not found in target.\n` +
        `  Expected "${BEGIN}" and "${END}" in the target file.\n` +
        `  Add them once (commit without generated content) before running this script.`,
    );
  }
  const before = target.slice(0, beginIdx + BEGIN.length);
  const after = target.slice(endIdx);
  return `${before}\n${generated}\n  ${after}`;
}

function main(): void {
  const original = readFileSync(INIT_SCRIPT_PATH, 'utf8');
  const generated = buildGeneratedBlock();
  const updated = splice(original, generated);

  if (updated === original) {
    console.log('[generate-init-schemas] No changes — output already in sync.');
    return;
  }

  writeFileSync(INIT_SCRIPT_PATH, updated, 'utf8');
  console.log(
    `[generate-init-schemas] Regenerated ${INIT_SCRIPT_PATH} with ${SCHEMA_REGISTRY.length} SCHEMA_REGISTRY entries (${SCHEMA_REGISTRY.filter((e) => e.role).length} with a role).`,
  );
}

main();
