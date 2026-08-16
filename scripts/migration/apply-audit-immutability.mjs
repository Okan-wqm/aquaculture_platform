#!/usr/bin/env node
/**
 * apply-audit-immutability — Faz 3.5 of day-one baseline reset.
 *
 * Installs the database row guard declared for every protected table the
 * baseline generator creates. Destructive-DDL protection is not treated as
 * row immutability: append-only ledgers reject UPDATE, retention-managed audit
 * rows use a legal-hold-aware DELETE guard, and lifecycle tables may UPDATE
 * while an explicit retention policy can still reject hard DELETE.
 *
 * Idempotent — re-runnable; checks for the marker comment before adding.
 *
 * The table set and each row/delete policy come exclusively from
 * libs/backend-common/src/constants/protected-tables.ts. This script owns only
 * the service-to-baseline filesystem locations.
 *
 * Usage: node scripts/migration/apply-audit-immutability.mjs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ROW_DELETE_POLICY,
  ROW_MUTATION_POLICY,
  protectedTableName,
  rowGuardTablePoliciesForSchema,
} from '../../libs/backend-common/src/constants/protected-tables.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const BASELINE_LOCATIONS = [
  { svc: 'admin-api-service', schema: 'admin', migDir: 'src/migrations' },
  { svc: 'auth-service', schema: 'auth', migDir: 'src/migrations' },
  { svc: 'event-store-service', schema: 'event_store', migDir: 'src/migrations' },
  { svc: 'farm-service', schema: 'farm', migDir: 'src/database/migrations' },
  { svc: 'hr-service', schema: 'hr', migDir: 'src/database/migrations' },
  { svc: 'ai-service', schema: 'ai', migDir: 'src/database/migrations' },
  { svc: 'alert-engine', schema: 'alert', migDir: 'src/database/migrations' },
  { svc: 'messaging-service', schema: 'messaging', migDir: 'src/migrations' },
  { svc: 'sensor-service', schema: 'sensor', migDir: 'src/database/migrations' },
];

const UP_MARKER = '// ── Faz 3.5 hand-author addition — audit immutability triggers ──';
const DOWN_MARKER = '// Reverse Faz 3.5 audit immutability triggers';

function buildStrictAppendOnlyUpBlock(schema, table) {
  const fn = `${table}_prevent_update_or_delete`;
  return `
        await queryRunner.query(\`
            CREATE OR REPLACE FUNCTION "${schema}".${fn}()
            RETURNS trigger AS $$
            BEGIN
              RAISE EXCEPTION 'Table "${schema}"."${table}" is append-only; UPDATE/DELETE refused (protected-tables SSoT).';
            END;
            $$ LANGUAGE plpgsql;
        \`);
        await queryRunner.query(\`
            DROP TRIGGER IF EXISTS trg_${table}_prevent_update ON "${schema}"."${table}";
            CREATE TRIGGER trg_${table}_prevent_update
            BEFORE UPDATE OR DELETE ON "${schema}"."${table}"
            FOR EACH ROW EXECUTE FUNCTION "${schema}".${fn}();
        \`);
        await queryRunner.query(\`
            REVOKE UPDATE, DELETE ON "${schema}"."${table}" FROM PUBLIC;
        \`);`;
}

function buildLegalHoldRetentionUpBlock(schema, table) {
  return `
        await queryRunner.query(\`
            CREATE OR REPLACE FUNCTION "${schema}".${table}_prevent_update()
            RETURNS trigger AS $$
            BEGIN
              RAISE EXCEPTION '${schema}.${table} rows are immutable - UPDATE is not permitted';
            END;
            $$ LANGUAGE plpgsql;
        \`);
        await queryRunner.query(\`
            CREATE OR REPLACE FUNCTION "${schema}".${table}_prevent_legal_hold_delete()
            RETURNS trigger AS $$
            BEGIN
              IF OLD."legalHold" = true THEN
                RAISE EXCEPTION 'Cannot delete ${schema}.${table} row with active legal hold (id=%)', OLD.id;
              END IF;
              RETURN OLD;
            END;
            $$ LANGUAGE plpgsql;
        \`);
        await queryRunner.query(\`
            DROP TRIGGER IF EXISTS trg_${table}_prevent_update ON "${schema}"."${table}";
            DROP TRIGGER IF EXISTS trg_${table}_prevent_legal_hold_delete ON "${schema}"."${table}";
            DROP FUNCTION IF EXISTS "${schema}".${table}_prevent_update_or_delete();
            CREATE TRIGGER trg_${table}_prevent_update
            BEFORE UPDATE ON "${schema}"."${table}"
            FOR EACH ROW EXECUTE FUNCTION "${schema}".${table}_prevent_update();
            CREATE TRIGGER trg_${table}_prevent_legal_hold_delete
            BEFORE DELETE ON "${schema}"."${table}"
            FOR EACH ROW EXECUTE FUNCTION "${schema}".${table}_prevent_legal_hold_delete();
        \`);`;
}

function buildLifecycleDeleteGuardUpBlock(schema, table) {
  return `
        await queryRunner.query(\`
            CREATE OR REPLACE FUNCTION "${schema}".${table}_prevent_delete()
            RETURNS trigger AS $$
            BEGIN
              RAISE EXCEPTION 'Table "${schema}"."${table}" is lifecycle-mutated and retention-guarded; hard DELETE refused (protected-tables SSoT).';
            END;
            $$ LANGUAGE plpgsql;
        \`);
        await queryRunner.query(\`
            DROP TRIGGER IF EXISTS trg_${table}_prevent_delete ON "${schema}"."${table}";
            CREATE TRIGGER trg_${table}_prevent_delete
            BEFORE DELETE ON "${schema}"."${table}"
            FOR EACH ROW EXECUTE FUNCTION "${schema}".${table}_prevent_delete();
        \`);
        await queryRunner.query(\`
            REVOKE DELETE ON "${schema}"."${table}" FROM PUBLIC;
        \`);`;
}

function buildUpBlock(schema, policies) {
  const blocks = policies.map((policy) => {
    const table = protectedTableName(policy);
    if (policy.rowDelete === ROW_DELETE_POLICY.LEGAL_HOLD_RETENTION) {
      return buildLegalHoldRetentionUpBlock(schema, table);
    }
    if (policy.rowMutation === ROW_MUTATION_POLICY.APPEND_ONLY) {
      return buildStrictAppendOnlyUpBlock(schema, table);
    }
    return buildLifecycleDeleteGuardUpBlock(schema, table);
  });
  return `\n\n        ${UP_MARKER}${blocks.join('')}`;
}

function buildDownBlock(schema, policies) {
  const reverses = policies.map((policy) => {
    const table = protectedTableName(policy);
    if (policy.rowDelete === ROW_DELETE_POLICY.LEGAL_HOLD_RETENTION) {
      return `        await queryRunner.query(\`DROP TRIGGER IF EXISTS trg_${table}_prevent_update ON "${schema}"."${table}";\`);
        await queryRunner.query(\`DROP TRIGGER IF EXISTS trg_${table}_prevent_legal_hold_delete ON "${schema}"."${table}";\`);
        await queryRunner.query(\`DROP FUNCTION IF EXISTS "${schema}".${table}_prevent_update();\`);
        await queryRunner.query(\`DROP FUNCTION IF EXISTS "${schema}".${table}_prevent_legal_hold_delete();\`);`;
    }
    if (policy.rowMutation === ROW_MUTATION_POLICY.APPEND_ONLY) {
      const fn = `${table}_prevent_update_or_delete`;
      return `        await queryRunner.query(\`DROP TRIGGER IF EXISTS trg_${table}_prevent_update ON "${schema}"."${table}";\`);
        await queryRunner.query(\`DROP FUNCTION IF EXISTS "${schema}".${fn}();\`);`;
    }
    return `        await queryRunner.query(\`DROP TRIGGER IF EXISTS trg_${table}_prevent_delete ON "${schema}"."${table}";\`);
        await queryRunner.query(\`DROP FUNCTION IF EXISTS "${schema}".${table}_prevent_delete();\`);`;
  });
  return `\n        ${DOWN_MARKER}\n${reverses.join('\n')}\n`;
}

function applyRowGuards({ svc, schema, migDir }) {
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

  const policies = rowGuardTablePoliciesForSchema(schema);
  const presentPolicies = policies.filter((policy) =>
    new RegExp(`CREATE TABLE "${schema}"\\."${protectedTableName(policy)}"`).test(src),
  );
  if (presentPolicies.length === 0) {
    console.log(`[skip] ${svc}: baseline creates no SSoT row-guarded tables`);
    return;
  }

  // Insert up() block before the closing brace of up()
  const upRe =
    /(public\s+async\s+up\s*\(\s*queryRunner\s*:\s*QueryRunner\s*\)\s*:\s*Promise<\s*void\s*>\s*\{[\s\S]*?)(\n\s*\}\s*\n\s*public\s+async\s+down)/m;
  if (!upRe.test(src)) {
    console.error(`[fail] ${svc}: could not find up() method block`);
    return;
  }
  src = src.replace(upRe, `$1${buildUpBlock(schema, presentPolicies)}$2`);

  // Prepend down() block
  const downRe =
    /(public\s+async\s+down\s*\(\s*queryRunner\s*:\s*QueryRunner\s*\)\s*:\s*Promise<\s*void\s*>\s*\{)(\s*\n)/m;
  if (!downRe.test(src)) {
    console.error(`[fail] ${svc}: could not find down() method block`);
    return;
  }
  src = src.replace(downRe, `$1${buildDownBlock(schema, presentPolicies)}`);

  writeFileSync(path, src, 'utf8');
  console.log(
    `[ok]   ${svc}: row guards on [${presentPolicies.map(protectedTableName).join(', ')}]`,
  );
}

for (const location of BASELINE_LOCATIONS) {
  applyRowGuards(location);
}
