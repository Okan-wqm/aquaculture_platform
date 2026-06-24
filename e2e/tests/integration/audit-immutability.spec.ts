/**
 * Integration test — `shared.audit_logs` immutability + legal-hold delete-block
 *
 * # Why this test exists
 *
 * Migration `1782000000000-AuditLogImmutability` originally installed two
 * BEFORE triggers on the audit table that make rows append-only and block
 * deletion of legally-held rows. Migration `1787200000000-RealignSharedAuditLogsSchema`
 * silently dropped both triggers + the `legalHold` column when it
 * `DROP TABLE ... CASCADE`-rebuilt the table with a new column shape.
 * Migration `1787400000000-RestoreSharedAuditLogsImmutability` restores
 * all three artefacts. This integration test is the live-database
 * confirmation that the artefacts are present and behave correctly.
 *
 * Failure here in CI signals one of:
 *   - The restoration migration did not run on the test DB.
 *   - A future migration silently dropped or modified the protections.
 *   - PostgreSQL trigger semantics changed (extremely unlikely; would
 *     also break every other trigger-using test).
 *
 * # What it checks
 *
 *   1. `legalHold` column exists with the expected type/default.
 *   2. Both triggers exist on `shared.audit_logs` and fire BEFORE the
 *      relevant statement.
 *   3. UPDATE of any audit row is rejected with the expected SQLSTATE.
 *   4. DELETE of a row with legalHold=true is rejected.
 *   5. DELETE of a row with legalHold=false succeeds (operational
 *      retention sweeps still work for un-held rows).
 *
 * # Why integration not unit
 *
 * The protection is a database-level concern. A unit test would mock
 * the DB and prove only that the code I wrote is the code I wrote —
 * not that the DB enforces it. The whole point of triggers is that
 * they outlive any application bug; testing must therefore exercise
 * the real DB.
 *
 * Closes: docs/reviews/audit-trail-completeness-auditor/2026-04-28-core-platform-review.md#AUDITTRAIL-CRITICAL-001
 * Closes: docs/reviews/database-reviewer/2026-04-28-core-platform-review.md#DBR-CRITICAL-001
 */

import { TestDatabase } from '../../helpers/db.helper';

interface ColumnRow {
  data_type: string;
  is_nullable: string;
  column_default: string | null;
  [k: string]: unknown;
}

interface TriggerRow {
  trigger_name: string;
  event_manipulation: string;
  action_timing: string;
  [k: string]: unknown;
}

interface AuditRow {
  id: string;
  legalHold: boolean;
  [k: string]: unknown;
}

describe('shared.audit_logs immutability + legal-hold delete-block', () => {
  let db: TestDatabase;

  // Each test inserts a fresh row and cleans up via the legalHold=false path.
  // Generated UUIDs avoid collision and let teardown target only this test's rows.
  const insertedIds: string[] = [];

  beforeAll(() => {
    db = new TestDatabase();
  });

  afterAll(async () => {
    // Best-effort cleanup. Rows with legalHold=true are intentionally
    // un-deletable, so leave them and tag them with a known marker prefix
    // (already done via the test's payload) — operator cleanup runbook
    // covers post-test hold-row purge under a legal-team waiver.
    if (insertedIds.length > 0) {
      try {
        await db.query(
          `DELETE FROM shared.audit_logs
           WHERE id = ANY($1::uuid[])
             AND "legalHold" = false`,
          [insertedIds],
        );
      } catch {
        // Cleanup failure is non-fatal — leave rows for operator purge.
      }
    }
    await db.close();
  });

  it('legalHold column exists on shared.audit_logs with expected shape', async () => {
    const result = await db.query<ColumnRow>(
      `SELECT data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'shared'
         AND table_name   = 'audit_logs'
         AND column_name  = 'legalHold'`,
    );
    expect(result.rowCount).toBe(1);
    const row = result.rows[0];
    // boolean type, NOT NULL, default false — mirrors migration intent.
    expect(row.data_type).toBe('boolean');
    expect(row.is_nullable).toBe('NO');
    expect(row.column_default).toMatch(/^false/);
  });

  it('both immutability triggers exist on shared.audit_logs', async () => {
    const result = await db.query<TriggerRow>(
      `SELECT trigger_name, event_manipulation, action_timing
       FROM information_schema.triggers
       WHERE event_object_schema = 'shared'
         AND event_object_table  = 'audit_logs'
         AND trigger_name IN (
           'trg_audit_logs_prevent_update',
           'trg_audit_logs_prevent_legal_hold_delete'
         )
       ORDER BY trigger_name`,
    );
    // information_schema.triggers returns one row per trigger × event,
    // so two triggers = two rows.
    expect(result.rowCount).toBe(2);
    const byName = Object.fromEntries(result.rows.map((r) => [r.trigger_name, r]));
    expect(byName.trg_audit_logs_prevent_update.event_manipulation).toBe('UPDATE');
    expect(byName.trg_audit_logs_prevent_update.action_timing).toBe('BEFORE');
    expect(byName.trg_audit_logs_prevent_legal_hold_delete.event_manipulation).toBe('DELETE');
    expect(byName.trg_audit_logs_prevent_legal_hold_delete.action_timing).toBe('BEFORE');
  });

  it('UPDATE on any audit row raises an exception (rows are immutable)', async () => {
    const insertResult = await db.query<AuditRow>(
      `INSERT INTO shared.audit_logs (action, resource, "tenantId", severity)
       VALUES ('test.audit_immutability.update_blocked',
               'AuditImmutabilityIntegrationTest',
               '00000000-0000-0000-0000-000000000001',
               'info')
       RETURNING id, "legalHold"`,
    );
    const id = insertResult.rows[0].id;
    insertedIds.push(id);

    await expect(
      db.query(`UPDATE shared.audit_logs SET action = 'tampered' WHERE id = $1`, [id]),
    ).rejects.toThrow(/immutable|UPDATE is not permitted/i);
  });

  it('DELETE on a row with legalHold=true raises an exception', async () => {
    const insertResult = await db.query<AuditRow>(
      `INSERT INTO shared.audit_logs (action, resource, "tenantId", severity, "legalHold")
       VALUES ('test.audit_immutability.delete_blocked',
               'AuditImmutabilityIntegrationTest',
               '00000000-0000-0000-0000-000000000002',
               'info',
               true)
       RETURNING id, "legalHold"`,
    );
    const id = insertResult.rows[0].id;
    insertedIds.push(id);
    expect(insertResult.rows[0].legalHold).toBe(true);

    await expect(db.query(`DELETE FROM shared.audit_logs WHERE id = $1`, [id])).rejects.toThrow(
      /legal hold|Cannot delete/i,
    );
  });

  it('DELETE on a row with legalHold=false succeeds (retention sweep still works)', async () => {
    const insertResult = await db.query<AuditRow>(
      `INSERT INTO shared.audit_logs (action, resource, "tenantId", severity, "legalHold")
       VALUES ('test.audit_immutability.delete_allowed',
               'AuditImmutabilityIntegrationTest',
               '00000000-0000-0000-0000-000000000003',
               'info',
               false)
       RETURNING id, "legalHold"`,
    );
    const id = insertResult.rows[0].id;
    // Not added to insertedIds because we delete it here.
    expect(insertResult.rows[0].legalHold).toBe(false);

    const deleteResult = await db.query(
      `DELETE FROM shared.audit_logs WHERE id = $1 RETURNING id`,
      [id],
    );
    expect(deleteResult.rowCount).toBe(1);
  });
});
