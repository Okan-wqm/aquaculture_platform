/**
 * Platform-wide invariant — Infrastructure Audit-Ledger RLS SSoT (ORPHAN-MEDIUM-324).
 *
 * `INFRASTRUCTURE_AUDIT_LEDGERS` is the single source of truth for the
 * cross-tenant, append-only audit ledgers that MUST carry the canonical
 * infrastructure-ledger RLS policy (append-INSERT + system-aware SELECT, NO
 * `tenant_isolation_policy`) instead of the per-tenant policy that silently
 * drops their system-written rows.
 *
 * This spec keeps that SSoT honest by coupling it to the two adjacent SSoTs:
 *
 *   1. Every declared ledger is immutability-PROTECTED (`PROTECTED_TABLES`) —
 *      an audit ledger without immutability is a contradiction.
 *   2. Every tenant-scoped-service ledger is a declared CROSS-TENANT infra
 *      table (`MODULE_SCHEMAS[].infrastructureTables`) — a per-tenant table
 *      (in `tables`, fan-out cloned) must NOT be here; it keeps tenant RLS.
 *   3. DRIFT CATCH — any infra table whose NAME looks like an audit ledger
 *      (matches /audit/) but is absent from the SSoT fails: a newly-added
 *      cross-tenant audit ledger cannot silently ship without the policy.
 */

import {
  INFRASTRUCTURE_AUDIT_LEDGERS,
  listInfrastructureAuditLedgerQualifiedNames,
} from '../../libs/backend-common/src/database/rls/infrastructure-ledger.ssot';
import { MODULE_SCHEMAS } from '../../libs/backend-common/src/database/schema-manager.service';
import { PROTECTED_TABLES } from '../../libs/backend-common/src/constants/protected-tables';
import { tenantAwareSchemas } from '../../platform/libs/service-catalog/src';

// Tenant-scoped service schemas whose ledgers live in the source schema and are
// declared in MODULE_SCHEMAS.infrastructureTables — DERIVED from the platform
// topology SSoT, not a hand-copied subset. WHY derived: the previous literal
// `['farm','hr','alert','ai','sensor']` silently omitted `messaging` +
// `hydroponics` (both tenant-aware with cross-tenant infra tables), so the
// drift catch below never fired for a new messaging/hydroponics audit ledger
// shipped without the canonical policy — the ORPHAN-HIGH-411(c) coverage hole.
const TENANT_SCOPED_SERVICE_SCHEMAS = new Set(tenantAwareSchemas());

const IDENT_RE = /^[a-z][a-z0-9_]*$/;

describe('Infrastructure audit-ledger RLS SSoT (ORPHAN-MEDIUM-324)', () => {
  const protectedSet = new Set(PROTECTED_TABLES.map((t) => t.toLowerCase()));
  const qualifiedLedgers = listInfrastructureAuditLedgerQualifiedNames();

  it('every ledger name is a valid lowercase SQL identifier (no injection surface)', () => {
    for (const [schema, tables] of Object.entries(INFRASTRUCTURE_AUDIT_LEDGERS)) {
      expect(schema).toMatch(IDENT_RE);
      for (const table of tables) expect(table).toMatch(IDENT_RE);
    }
  });

  it('declares no duplicate qualified ledger', () => {
    expect(new Set(qualifiedLedgers).size).toBe(qualifiedLedgers.length);
  });

  it('#1 — every declared ledger is immutability-PROTECTED (PROTECTED_TABLES)', () => {
    const unprotected = qualifiedLedgers.filter((q) => !protectedSet.has(q.toLowerCase()));
    if (unprotected.length > 0) {
      throw new Error(
        `INFRASTRUCTURE_AUDIT_LEDGERS entries missing from PROTECTED_TABLES: ` +
          `${unprotected.join(', ')}. An append-only audit ledger MUST also be ` +
          `immutability-protected — add it to PROTECTED_TABLES (with the ADR + ` +
          `CODEOWNERS review that gate requires) or remove it from the RLS SSoT.`,
      );
    }
  });

  it('#2 — every tenant-scoped-service ledger is a declared cross-tenant infra table', () => {
    const problems: string[] = [];
    for (const [schema, tables] of Object.entries(INFRASTRUCTURE_AUDIT_LEDGERS)) {
      if (!TENANT_SCOPED_SERVICE_SCHEMAS.has(schema)) continue; // platform schema — N/A
      const moduleEntry = MODULE_SCHEMAS.find((m) => m.sourceSchema === schema);
      if (!moduleEntry) {
        problems.push(`${schema}: no MODULE_SCHEMAS entry with sourceSchema="${schema}"`);
        continue;
      }
      const infra = new Set(moduleEntry.infrastructureTables ?? []);
      for (const table of tables) {
        if (!infra.has(table)) {
          problems.push(
            `${schema}.${table} is in the RLS SSoT but NOT in ` +
              `MODULE_SCHEMAS["${schema}"].infrastructureTables — a per-tenant ` +
              `(fan-out cloned) table must not carry the infra-ledger policy.`,
          );
        }
      }
    }
    if (problems.length > 0) throw new Error(problems.join('\n'));
  });

  it('#3 DRIFT CATCH — every /audit/-named cross-tenant infra table is in the SSoT', () => {
    const missing: string[] = [];
    for (const moduleEntry of MODULE_SCHEMAS) {
      if (!TENANT_SCOPED_SERVICE_SCHEMAS.has(moduleEntry.sourceSchema)) continue;
      const ssotTables = new Set(INFRASTRUCTURE_AUDIT_LEDGERS[moduleEntry.sourceSchema] ?? []);
      for (const table of moduleEntry.infrastructureTables ?? []) {
        if (/audit/i.test(table) && !ssotTables.has(table)) {
          missing.push(
            `${moduleEntry.sourceSchema}.${table} is an audit-named cross-tenant ` +
              `infra table but is NOT in INFRASTRUCTURE_AUDIT_LEDGERS — a new ` +
              `cross-tenant audit ledger must be added to the SSoT (so it gets the ` +
              `append/system-read policy) or it will silently drop system-written ` +
              `rows under tenant_isolation_policy.`,
          );
        }
      }
    }
    if (missing.length > 0) throw new Error(missing.join('\n'));
  });

  it('covers the schemas the ORPHAN-MEDIUM-324 audit found AT-RISK', () => {
    // Regression anchor: the 6 AT-RISK ledgers + auth reference must stay declared.
    for (const q of [
      'auth.audit_logs',
      'shared.audit_logs',
      'farm.farm_audit_logs',
      'hr.payroll_audit',
      'alert.alert_audit_log',
      'ai.tool_execution_audit',
      'sensor.sensor_audit_logs',
    ]) {
      expect(qualifiedLedgers).toContain(q);
    }
  });
});
