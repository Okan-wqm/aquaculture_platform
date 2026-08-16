#!/usr/bin/env node
/**
 * apply-audit-immutability — Faz 3.5 of day-one baseline reset.
 *
 * Installs immutability triggers on every protected audit table the
 * baseline generator creates. Each trigger refuses UPDATE/DELETE at
 * the database level, enforcing the SOC 2 CC4 + SOX § 802 append-only
 * invariant the Faz 1.4 protected-tables-guard requires.
 *
 * Idempotent — re-runnable; checks for the marker comment before adding.
 *
 * Target tables are read from the append-only catalog in backend-common.
 * Operational lifecycle tables (notably admin.impersonation_sessions) are
 * deliberately absent and therefore cannot be frozen by this script.
 *
 * Usage: node scripts/migration/apply-audit-immutability.mjs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadTargets() {
  const catalogPath = resolve(
    REPO_ROOT,
    'libs/backend-common/src/constants/append-only-table-catalog.json',
  );
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  if (!Array.isArray(catalog)) {
    throw new Error('append-only-table-catalog.json must contain an array');
  }

  const grouped = new Map();
  for (const entry of catalog) {
    if (!entry || typeof entry !== 'object' || typeof entry.qualifiedName !== 'string') {
      throw new Error('append-only catalog entries require qualifiedName');
    }
    if (!entry.baseline) continue;
    const { service, schema, migrationDirectory } = entry.baseline;
    if (
      typeof service !== 'string' ||
      typeof schema !== 'string' ||
      typeof migrationDirectory !== 'string'
    ) {
      throw new Error(`invalid baseline target for ${entry.qualifiedName}`);
    }
    const [qualifiedSchema, table, extra] = entry.qualifiedName.split('.');
    if (!qualifiedSchema || !table || extra || qualifiedSchema !== schema) {
      throw new Error(`baseline schema does not match ${entry.qualifiedName}`);
    }

    const key = `${service}\u0000${schema}\u0000${migrationDirectory}`;
    const target = grouped.get(key) ?? {
      svc: service,
      schema,
      migDir: migrationDirectory,
      tables: [],
    };
    target.tables.push(table);
    grouped.set(key, target);
  }
  return [...grouped.values()];
}

const TARGETS = loadTargets();

const UP_MARKER = '// ── Faz 3.5 hand-author addition — audit immutability triggers ──';
const DOWN_MARKER = '// Reverse Faz 3.5 audit immutability triggers';

function buildUpBlock(schema, tables) {
  const blocks = tables.map((tbl) => {
    const fn = `${tbl}_prevent_update_or_delete`;
    return `
        await queryRunner.query(\`
            CREATE OR REPLACE FUNCTION "${schema}".${fn}()
            RETURNS trigger AS $$
            BEGIN
              RAISE EXCEPTION 'Audit table "${schema}"."${tbl}" is append-only; UPDATE/DELETE refused (Faz 1.4 protected-tables-guard).';
            END;
            $$ LANGUAGE plpgsql;
        \`);
        await queryRunner.query(\`
            CREATE TRIGGER trg_${tbl}_prevent_update
            BEFORE UPDATE OR DELETE ON "${schema}"."${tbl}"
            FOR EACH ROW EXECUTE FUNCTION "${schema}".${fn}();
        \`);
        await queryRunner.query(\`
            REVOKE UPDATE, DELETE ON "${schema}"."${tbl}" FROM PUBLIC;
        \`);`;
  });
  return `\n\n        ${UP_MARKER}${blocks.join('')}`;
}

function buildDownBlock(schema, tables) {
  const reverses = tables.map((tbl) => {
    const fn = `${tbl}_prevent_update_or_delete`;
    return `        await queryRunner.query(\`DROP TRIGGER IF EXISTS trg_${tbl}_prevent_update ON "${schema}"."${tbl}";\`);
        await queryRunner.query(\`DROP FUNCTION IF EXISTS "${schema}".${fn}();\`);`;
  });
  return `\n        ${DOWN_MARKER}\n${reverses.join('\n')}\n`;
}

function applyImmutability({ svc, schema, migDir, tables }) {
  const path = resolve(REPO_ROOT, 'apps', svc, migDir, '1800000000000-Baseline.ts');
  if (!existsSync(path)) {
    console.error(`[skip] ${svc}: ${path} not found`);
    return;
  }
  let src = readFileSync(path, 'utf8');

  if (src.includes(UP_MARKER)) {
    console.log(`[skip] ${svc}: audit immutability triggers already present`);
    return;
  }

  // Confirm the baseline actually creates the audit tables we're trying to lock.
  const missing = tables.filter(
    (t) => !new RegExp(`CREATE TABLE "${schema}"\\."${t}"`).test(src),
  );
  if (missing.length === tables.length) {
    console.log(`[skip] ${svc}: baseline does not create any of [${tables.join(', ')}] — nothing to trigger-lock`);
    return;
  }
  const presentTables = tables.filter((t) => !missing.includes(t));

  // Insert up() block before the closing brace of up()
  const upRe =
    /(public\s+async\s+up\s*\(\s*queryRunner\s*:\s*QueryRunner\s*\)\s*:\s*Promise<\s*void\s*>\s*\{[\s\S]*?)(\n\s*\}\s*\n\s*public\s+async\s+down)/m;
  if (!upRe.test(src)) {
    console.error(`[fail] ${svc}: could not find up() method block`);
    return;
  }
  src = src.replace(upRe, `$1${buildUpBlock(schema, presentTables)}$2`);

  // Prepend down() block
  const downRe =
    /(public\s+async\s+down\s*\(\s*queryRunner\s*:\s*QueryRunner\s*\)\s*:\s*Promise<\s*void\s*>\s*\{)(\s*\n)/m;
  if (!downRe.test(src)) {
    console.error(`[fail] ${svc}: could not find down() method block`);
    return;
  }
  src = src.replace(downRe, `$1${buildDownBlock(schema, presentTables)}`);

  writeFileSync(path, src, 'utf8');
  console.log(`[ok]   ${svc}: immutability triggers on [${presentTables.join(', ')}]`);
}

for (const t of TARGETS) {
  applyImmutability(t);
}
