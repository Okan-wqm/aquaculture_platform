import { Module, OnModuleInit } from '@nestjs/common';
import { AccessLogEntity, AuditLogEntity } from '@aquaculture/backend-common/audit';
import {
  RetentionEnforcementService,
  registerRetentionPolicy,
} from '@aquaculture/backend-common/database';

import { AuditLog } from '../audit/audit.entity';
import {
  DatabaseMetric,
  SlowQueryLog,
} from '../database-management/entities/database-management.entity';
import {
  CacheEntrySnapshot,
  CapturedApiCall,
  CapturedQuery,
} from '../impersonation/entities/debug-session.entity';
import { ActivityLog } from '../security/entities/security.entity';
import { ErrorGroup, ErrorOccurrence } from '../system-management/entities/error-tracking.entity';
import {
  BackgroundJob,
  JobExecutionLog,
  JobStatus,
} from '../system-management/entities/job-queue.entity';
import {
  PerformanceMetric,
  PerformanceSnapshot,
} from '../system-management/entities/performance-metric.entity';

/**
 * AdminApiRetentionBootstrapModule — the ONE place admin-api states how long
 * each of its append-only streams is kept (ADR-0012).
 *
 * # Why one registry
 *
 * Until 2026-09-05 admin-api ran three retention engines. The canonical
 * registry below named `shared.audit_logs` and `shared.access_logs` by a
 * column called `created_at`; the physical column is `"createdAt"`, so the
 * SOC 2 seven-year and ninety-day disposals raised inside the enforcer and
 * were swallowed — they never ran once. A second engine
 * (`audit-trail.service.ts applyRetentionPolicies`) read operator-editable
 * rows from `admin.retention_policies` at the same 03:00 and deleted
 * `activity_logs` with no legal-hold predicate and no lower bound on the
 * number an operator could type. Eight more services carried their own
 * `@Cron` disposal with hard-coded windows, no legal hold and no heartbeat.
 *
 * Every window now lives here, bound to the ENTITY and one of its
 * PROPERTIES. The registry derives schema, table and physical column from
 * the entity's decorator metadata, so a wrong column cannot compile and a
 * wrong table cannot register. An entity that declares a `legalHold`
 * column must name it, so held rows are never disposed.
 *
 * # Windows
 *
 * - 7 years for audit ledgers: SOC 2 CC4 audit window + proof
 *   preservation (5-7y); SOX §802 (7y); PCI-DSS §10.7 forensic floor.
 * - 90 days for the HTTP access stream and error occurrences: a forensic
 *   horizon, not a compliance record (AUDITTRAIL-HIGH-004).
 * - 30 days for operational metrics and finished jobs; 7 days for cancelled
 *   jobs and debug captures: operational residue with no evidentiary value.
 *
 * Changing a window is a code review, not a settings screen: retention is a
 * compliance commitment, and a screen that let an operator type `-1` into
 * the field that deletes the security ledger was the CRITICAL this replaces.
 *
 * Closes: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#DATA-CRITICAL-013
 */
const SEVEN_YEARS = 7 * 365;

@Module({
  providers: [RetentionEnforcementService],
  exports: [RetentionEnforcementService],
})
export class AdminApiRetentionBootstrapModule implements OnModuleInit {
  onModuleInit(): void {
    // ── Audit ledgers (legal hold mandatory) ──
    registerRetentionPolicy({
      id: 'shared.audit_logs.7y',
      ownerTag: 'soc2-cc4',
      entity: AuditLogEntity,
      timestampProperty: 'createdAt',
      legalHoldProperty: 'legalHold',
      retentionDays: SEVEN_YEARS,
    });
    registerRetentionPolicy({
      id: 'admin.audit_logs.7y',
      ownerTag: 'soc2-cc4',
      entity: AuditLog,
      timestampProperty: 'createdAt',
      legalHoldProperty: 'legalHold',
      retentionDays: SEVEN_YEARS,
    });
    // admin.activity_logs is the SUPER_ADMIN activity ledger. It carries no
    // legalHold column yet (ADR-0008 adds one and the WORM triggers); the
    // moment it does, this registration fails to boot until it names it.
    registerRetentionPolicy({
      id: 'admin.activity_logs.7y',
      ownerTag: 'soc2-cc4',
      entity: ActivityLog,
      timestampProperty: 'createdAt',
      retentionDays: SEVEN_YEARS,
    });

    // ── Request-level observability stream (AUDITTRAIL-HIGH-004) ──
    registerRetentionPolicy({
      id: 'shared.access_logs.90d',
      ownerTag: 'access-log-observability',
      entity: AccessLogEntity,
      timestampProperty: 'createdAt',
      retentionDays: 90,
    });

    // ── Error tracking ──
    registerRetentionPolicy({
      id: 'admin.error_occurrences.90d',
      ownerTag: 'ops-error-tracking',
      entity: ErrorOccurrence,
      timestampProperty: 'timestamp',
      retentionDays: 90,
    });
    // A group not seen for 90 days has no occurrences left after the policy
    // above; disposing it by lastSeenAt is the former "delete empty groups"
    // step expressed as a window instead of a join.
    registerRetentionPolicy({
      id: 'admin.error_groups.90d',
      ownerTag: 'ops-error-tracking',
      entity: ErrorGroup,
      timestampProperty: 'lastSeenAt',
      retentionDays: 90,
    });

    // ── Database + performance metrics ──
    registerRetentionPolicy({
      id: 'admin.database_metrics.30d',
      ownerTag: 'ops-db-monitoring',
      entity: DatabaseMetric,
      timestampProperty: 'recordedAt',
      retentionDays: 30,
    });
    registerRetentionPolicy({
      id: 'admin.slow_query_logs.30d',
      ownerTag: 'ops-db-monitoring',
      entity: SlowQueryLog,
      timestampProperty: 'recordedAt',
      retentionDays: 30,
    });
    registerRetentionPolicy({
      id: 'admin.performance_metrics.30d',
      ownerTag: 'ops-performance',
      entity: PerformanceMetric,
      timestampProperty: 'timestamp',
      retentionDays: 30,
    });
    registerRetentionPolicy({
      id: 'admin.performance_snapshots.30d',
      ownerTag: 'ops-performance',
      entity: PerformanceSnapshot,
      timestampProperty: 'timestamp',
      retentionDays: 30,
    });

    // ── Job queue ──
    registerRetentionPolicy({
      id: 'admin.background_jobs.completed.30d',
      ownerTag: 'ops-job-queue',
      entity: BackgroundJob,
      timestampProperty: 'completedAt',
      retentionDays: 30,
      where: { status: JobStatus.COMPLETED },
    });
    registerRetentionPolicy({
      id: 'admin.background_jobs.cancelled.7d',
      ownerTag: 'ops-job-queue',
      entity: BackgroundJob,
      timestampProperty: 'updatedAt',
      retentionDays: 7,
      where: { status: JobStatus.CANCELLED },
    });
    registerRetentionPolicy({
      id: 'admin.job_execution_logs.30d',
      ownerTag: 'ops-job-queue',
      entity: JobExecutionLog,
      timestampProperty: 'timestamp',
      retentionDays: 30,
    });

    // ── Debug captures (raw tenant SQL and request bodies; ADR-0007 deletes
    //    the module — until then their residue is bounded here) ──
    registerRetentionPolicy({
      id: 'admin.captured_queries.7d',
      ownerTag: 'debug-tools',
      entity: CapturedQuery,
      timestampProperty: 'timestamp',
      retentionDays: 7,
    });
    registerRetentionPolicy({
      id: 'admin.captured_api_calls.7d',
      ownerTag: 'debug-tools',
      entity: CapturedApiCall,
      timestampProperty: 'timestamp',
      retentionDays: 7,
    });
    registerRetentionPolicy({
      id: 'admin.cache_entries_snapshot.7d',
      ownerTag: 'debug-tools',
      entity: CacheEntrySnapshot,
      timestampProperty: 'capturedAt',
      retentionDays: 7,
    });
  }
}
