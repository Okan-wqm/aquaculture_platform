#!/usr/bin/env node
/**
 * wrap-create-type-idempotent — Faz 3.5 post-process.
 *
 * Wraps every `CREATE TYPE … AS ENUM(…)` statement in every baseline
 * migration with a `DO $$ BEGIN … EXCEPTION WHEN duplicate_object THEN
 * NULL; END $$;` block — the canonical PostgreSQL idempotency idiom
 * for type creation (PG has no `CREATE TYPE IF NOT EXISTS`).
 *
 * Why we need this: TypeORM's `migration:generate` emits bare CREATE
 * TYPE, which crashes on replay with `42710 duplicate_object`. The
 * `migration-sql-lint` R8 rule enforces the DO/EXCEPTION wrap. Faz 6
 * cutover requires a clean replay of every baseline against the
 * disposable Postgres + the production Postgres in turn; bare CREATE
 * TYPE would block both.
 *
 * Idempotent — re-runnable; already-wrapped statements are detected and
 * skipped.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const BASELINE_LOCATIONS = [
  'apps/admin-api-service/src/migrations/1800000000000-Baseline.ts',
  'apps/auth-service/src/migrations/1800000000000-Baseline.ts',
  'apps/billing-service/src/database/migrations/1800000000000-Baseline.ts',
  'apps/config-service/src/database/migrations/1800000000000-Baseline.ts',
  'apps/event-store-service/src/migrations/1800000000000-Baseline.ts',
  'apps/notification-service/src/database/migrations/1800000000000-Baseline.ts',
  'apps/observability-service/src/database/migrations/1800000000000-Baseline.ts',
  'apps/ai-service/src/database/migrations/1800000000000-Baseline.ts',
  'apps/alert-engine/src/database/migrations/1800000000000-Baseline.ts',
  'apps/farm-service/src/database/migrations/1800000000000-Baseline.ts',
  'apps/hr-service/src/database/migrations/1800000000000-Baseline.ts',
  'apps/hydroponics-service/src/database/migrations/1800000000000-Baseline.ts',
  'apps/messaging-service/src/migrations/1800000000000-Baseline.ts',
  'apps/sensor-service/src/database/migrations/1800000000000-Baseline.ts',
];

// Match: await queryRunner.query(`CREATE TYPE … AS ENUM(…)`);
// Group 1: indentation, Group 2: the full SQL string contents
const CREATE_TYPE_RE = /(\s*)await queryRunner\.query\(`(CREATE TYPE [^`]+ AS ENUM\([^`]+\))`\);/g;

function wrapFile(rel) {
  const p = resolve(REPO_ROOT, rel);
  if (!existsSync(p)) {
    console.log(`[skip] ${rel}: not found`);
    return 0;
  }
  let src = readFileSync(p, 'utf8');
  let wraps = 0;
  const next = src.replace(CREATE_TYPE_RE, (full, indent, sqlBody) => {
    // Already-wrapped: skip
    if (sqlBody.includes('DO $$') || sqlBody.includes('EXCEPTION WHEN')) {
      return full;
    }
    wraps++;
    return `${indent}await queryRunner.query(\`DO $$ BEGIN ${sqlBody}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;\`);`;
  });
  if (wraps === 0) {
    console.log(`[noop] ${rel}`);
    return 0;
  }
  writeFileSync(p, next, 'utf8');
  console.log(`[ok]   ${rel} (${wraps} CREATE TYPE wraps)`);
  return wraps;
}

let total = 0;
for (const rel of BASELINE_LOCATIONS) {
  total += wrapFile(rel);
}
console.log(`\nDone. total_create_type_wraps=${total}`);
