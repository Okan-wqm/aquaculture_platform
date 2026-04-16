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
