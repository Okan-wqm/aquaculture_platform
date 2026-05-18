#!/usr/bin/env node
/**
 * apply-rls-additions — Faz 3.5 of day-one baseline reset.
 *
 * Appends the canonical RLS install/uninstall calls (helper-driven, per
 * Faz 1.7 invariant) to every tenant-scoped service's baseline migration.
 * Idempotent — re-runnable; checks for the marker comment before adding.
 *
 * Targeted services: ai, alert, farm, hr, messaging, sensor.
 * (hydroponics already wired by hand as the pattern template.)
 *
 * Usage: node scripts/migration/apply-rls-additions.mjs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const TARGETS = [
  { svc: 'ai-service', schema: 'ai', migDir: 'src/database/migrations' },
  { svc: 'alert-engine', schema: 'alert', migDir: 'src/database/migrations' },
  { svc: 'farm-service', schema: 'farm', migDir: 'src/database/migrations' },
  { svc: 'hr-service', schema: 'hr', migDir: 'src/database/migrations' },
  { svc: 'messaging-service', schema: 'messaging', migDir: 'src/migrations' },
  { svc: 'sensor-service', schema: 'sensor', migDir: 'src/database/migrations' },
];

const HEADER_MARKER = '// Faz 3.5 RLS additions: import block';
const UP_MARKER = '// ── Faz 3.5 hand-author addition — RLS canonical predicate ──';
const DOWN_MARKER = '// Reverse Faz 3.5 RLS install first';

function applyRlsAdditions({ svc, schema, migDir }) {
  const path = resolve(REPO_ROOT, 'apps', svc, migDir, '1800000000000-Baseline.ts');
  if (!existsSync(path)) {
    console.error(`[skip] ${svc}: ${path} not found`);
    return;
  }
  let src = readFileSync(path, 'utf8');

  if (src.includes(UP_MARKER)) {
    console.log(`[skip] ${svc}: RLS additions already present`);
    return;
  }

  // 1) Insert import after the first existing typeorm import line.
  const importLine = `import { applyTenantRlsToSchema, removeTenantRlsFromSchema } from '@aquaculture/backend-common/database'; ${HEADER_MARKER}`;
  const importInsertRe = /^(import\s+\{[^}]*\}\s+from\s+["']typeorm["'];\s*$)/m;
  if (!importInsertRe.test(src)) {
    console.error(`[fail] ${svc}: no typeorm import line found; cannot insert RLS import`);
    return;
  }
  src = src.replace(importInsertRe, `$1\n${importLine}`);

  // 2) Append RLS install call before the closing brace of up().
  // We look for the up() method body and insert before its closing brace.
  const upRe =
    /(public\s+async\s+up\s*\(\s*queryRunner\s*:\s*QueryRunner\s*\)\s*:\s*Promise<\s*void\s*>\s*\{[\s\S]*?)(\n\s*\}\s*\n\s*public\s+async\s+down)/m;
  if (!upRe.test(src)) {
    console.error(`[fail] ${svc}: could not find up() method block`);
    return;
  }
  const upInjection = `\n\n        ${UP_MARKER}\n        await applyTenantRlsToSchema(queryRunner, {\n            schema: '${schema}',\n            tenantIdColumns: ['tenant_id', 'tenantId'],\n            excludeTables: [],\n        });`;
  src = src.replace(upRe, `$1${upInjection}$2`);

  // 3) Prepend RLS removal call at the top of down() body.
  const downRe =
    /(public\s+async\s+down\s*\(\s*queryRunner\s*:\s*QueryRunner\s*\)\s*:\s*Promise<\s*void\s*>\s*\{)(\s*\n)/m;
  if (!downRe.test(src)) {
    console.error(`[fail] ${svc}: could not find down() method block`);
    return;
  }
  const downInjection = `\n        ${DOWN_MARKER} (avoids policy-on-missing-table errors).\n        await removeTenantRlsFromSchema(queryRunner, {\n            schema: '${schema}',\n            tenantIdColumns: ['tenant_id', 'tenantId'],\n            excludeTables: [],\n        });\n`;
  src = src.replace(downRe, `$1${downInjection}`);

  writeFileSync(path, src, 'utf8');
  console.log(`[ok]   ${svc}: RLS additions appended (${path})`);
}

for (const t of TARGETS) {
  applyRlsAdditions(t);
}
