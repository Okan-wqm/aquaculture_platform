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
 * Audit tables addressed (the APPEND_ONLY_TABLES SSoT in
 * libs/backend-common/src/constants/protected-tables.ts is authoritative;
 * tests/invariants/impersonation-sessions-operational.spec.ts holds this list
 * in lockstep with it):
 *   admin.audit_logs                  (admin-api-service)
 *   auth.audit_logs                   (auth-service)
 *   farm.farm_audit_logs              (farm-service)
 *   hr.payroll_audit                  (hr-service)
 *   ai.tool_execution_audit           (ai-service)
 *   alert.alert_audit_log             (alert-engine)
 *   messaging.compliance_audit_log    (messaging-service)
 *
 * Usage: node scripts/migration/apply-audit-immutability.mjs
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const TARGETS = [
  // impersonation_sessions removed (ADMIN-CRITICAL-013 / APA-288): it is an
  // OPERATIONAL lifecycle table (LIFECYCLE_GUARDED_TABLES), not an append-only
  // ledger. Re-injecting trg_impersonation_sessions_prevent_update here would
  // resurrect the trigger that deadlocked every session-lifecycle mutation.
  { svc: 'admin-api-service', schema: 'admin', migDir: 'src/migrations', tables: ['audit_logs'] },
  { svc: 'auth-service', schema: 'auth', migDir: 'src/migrations', tables: ['audit_logs'] },
  { svc: 'farm-service', schema: 'farm', migDir: 'src/database/migrations', tables: ['farm_audit_logs'] },
  { svc: 'hr-service', schema: 'hr', migDir: 'src/database/migrations', tables: ['payroll_audit'] },
  { svc: 'ai-service', schema: 'ai', migDir: 'src/database/migrations', tables: ['tool_execution_audit'] },
  { svc: 'alert-engine', schema: 'alert', migDir: 'src/database/migrations', tables: ['alert_audit_log'] },
  { svc: 'messaging-service', schema: 'messaging', migDir: 'src/migrations', tables: ['compliance_audit_log'] },
  { svc: 'sensor-service', schema: 'sensor', migDir: 'src/database/migrations', tables: ['sensor_audit_logs'] },
];

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
