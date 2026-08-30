import { Module, OnModuleInit } from '@nestjs/common';
import {
  RetentionEnforcementService,
  registerRetentionPolicy,
} from '@aquaculture/backend-common/database';

/**
 * AdminApiRetentionBootstrapModule — registers retention policies for
 * audit tables owned by admin-api. Mirrors the canonical pattern
 * established by `apps/observability-service/src/retention/
 * retention-bootstrap.module.ts`.
 *
 * # Why
 *
 * Pre-fix `shared.audit_logs` (cross-service canonical audit) and
 * `admin.audit_logs` (SUPER_ADMIN cross-tenant audit) had NO retention
 * policy registration anywhere. Rows accumulated forever — uncontrolled
 * growth is an integrity risk (storage exhaustion, query slowdown) and a
 * compliance flag (no documented disposal cycle). COMPLIANCE-MEDIUM-001
 * captured the gap.
 *
 * # Architectural choice
 *
 * One policy per table, registered on module init. The single
 * `RetentionEnforcementService` cron (03:00 UTC daily) iterates every
 * registered policy. Adding a new policy is a one-line
 * `registerRetentionPolicy({...})` call here — no new service, no new
 * cron, no new spec file.
 *
 * # Why 7 years
 *
 * SOC 2 CC4 audit-window + proof-preservation = 5-7y; SOX § 802 = 7y;
 * PCI-DSS § 10.7 multi-year forensic floor. Build-time constant — the
 * legalHold predicate (`NOT "legalHold"`) ensures held rows are NEVER
 * touched even if an operator sets the env-var override low.
 *
 * # Defense-in-depth layering
 *
 *   1. Application-side WHERE filter on `legalHold = false` (this module).
 *   2. DB-level BEFORE DELETE trigger
 *      `trg_audit_logs_prevent_legal_hold_delete` — RAISES if step 1 ever
 *      regresses, surfacing the bug fail-loud instead of silently
 *      destroying held rows.
 *
 * Closes: docs/reviews/compliance-expert/2026-04-28-core-platform-review.md#COMPLIANCE-MEDIUM-001
 */
@Module({
  providers: [RetentionEnforcementService],
  exports: [RetentionEnforcementService],
})
export class AdminApiRetentionBootstrapModule implements OnModuleInit {
  onModuleInit(): void {
    registerRetentionPolicy({
      id: 'shared.audit_logs.7y',
      ownerTag: 'soc2-cc4',
      schema: 'shared',
      tableName: 'audit_logs',
      timestampColumn: 'created_at',
      retentionDays: 7 * 365,
      // Legal-hold semantics: NEVER delete a row flagged for litigation
      // preservation. The enforcer applies the legalHoldClause as a
      // SUPPRESSION predicate — the generated SQL becomes
      // `DELETE ... AND NOT ("legalHold" = true)`, i.e.
      // `DELETE ... AND "legalHold" = false`. The DB-level BEFORE DELETE
      // trigger (trg_audit_logs_prevent_legal_hold_delete from the W0.D
      // restoration migration) is defense-in-depth — relying on it alone
      // would convert a single held row in the cutoff set into a whole-
      // batch RAISE EXCEPTION, leaving thousands of un-held expired rows
      // in place. WHERE-clause filter is the primary path; trigger fails
      // fast on regression.
      legalHoldClause: '"legalHold" = true',
    });

    registerRetentionPolicy({
      id: 'admin.audit_logs.7y',
      ownerTag: 'soc2-cc4',
      schema: 'admin',
      tableName: 'audit_logs',
      timestampColumn: 'createdAt',
      retentionDays: 7 * 365,
      legalHoldClause: '"legalHold" = true',
    });

    // AUDITTRAIL-HIGH-004: the low-level HTTP access stream. Unlike the two
    // semantic-action audit_logs above (7y SOC 2 CC4 evidence), access_logs is
    // a request-level observability stream with a 90-day forensic horizon (see
    // AccessLogEntity docstring) and no legal-hold semantics — so no
    // legalHoldClause. Now that AccessLogMiddleware is mounted at the gateway
    // (one row per request), this policy prevents the previously-empty table
    // from growing without bound. Same shared entity + created_at column name
    // as shared.audit_logs above.
    registerRetentionPolicy({
      id: 'shared.access_logs.90d',
      ownerTag: 'access-log-observability',
      schema: 'shared',
      tableName: 'access_logs',
      timestampColumn: 'created_at',
      retentionDays: 90,
    });
  }
}
