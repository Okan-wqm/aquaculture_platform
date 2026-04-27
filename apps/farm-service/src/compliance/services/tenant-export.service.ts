/**
 * TenantExportService
 *
 * GDPR Article 15 (right-of-access) implementation for
 * farm-service. Walks every TypeORM entity that carries a
 * `tenantId` column, pulls every row for the requested tenant,
 * and returns a single JSON bundle keyed by table name.
 *
 * The service is read-only; the erasure counterpart lives in
 * `TenantErasureService` (two-step confirmation required). Both
 * services use TypeORM metadata at runtime so they discover new
 * tenant-scoped tables automatically — no hand-maintained list to
 * drift over time.
 *
 * Phase 6.3 of the "Farm modülü kalan kör noktalar" plan. Closes
 * the farm-service scope of Girdi 15-C11 (platform-wide GDPR
 * tenant export / erasure — COMPLIANCE-CRITICAL-001).
 *
 * # Scope
 *
 *   - Only entities declared in the farm-service DataSource.
 *   - Only entities with a `tenantId` column (JoinTable-style
 *     pivots and platform-global catalogs are skipped).
 *   - Audit log redaction is re-applied to the exported
 *     `changes` column: the redaction that already ran on write
 *     (phase 2.5) is replayed defensively so an export never
 *     re-surfaces PII a later policy tightening would have
 *     stripped.
 *
 * # NOT in scope
 *
 *   - Cross-service (auth-service / billing-service / messaging-
 *     service) data. The platform-wide bundle is assembled by
 *     admin-api-service fanning out to each service's local
 *     `exportTenant` endpoint; this service contributes the
 *     farm subset.
 *   - MinIO object bundle (BatchDocument file bodies). The
 *     metadata rows are exported; the actual objects are exported
 *     by a parallel MinIO-side sweep that phase 6.3.1 adds.
 *   - Signed URL / ZIP packaging. Caller (resolver) takes the
 *     raw JSON bundle and persists it wherever the platform
 *     export pipeline routes it.
 */
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityMetadata } from 'typeorm';

import { AuditRedactionService } from '../../database/services/audit-redaction.service';

export interface TenantExportBundle {
  tenantId: string;
  exportedAt: string;
  tables: Record<string, unknown[]>;
  summary: {
    tableCount: number;
    totalRows: number;
    skippedTables: string[];
  };
}

@Injectable()
export class TenantExportService {
  private readonly logger = new Logger(TenantExportService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly redaction: AuditRedactionService,
  ) {}

  /**
   * Enumerate every tenant-scoped entity and return the full row
   * set keyed by table name. Runs as many SELECTs as there are
   * entities; on a tenant with deep history this can be >100 rows
   * × 60 tables — caller is responsible for background-jobbing
   * the call if it runs in a request context.
   */
  async exportTenant(tenantId: string): Promise<TenantExportBundle> {
    const start = Date.now();
    const tables: Record<string, unknown[]> = {};
    const skipped: string[] = [];
    let totalRows = 0;

    const tenantScoped = this.resolveTenantScopedEntities();
    for (const meta of tenantScoped) {
      const tableName = meta.tableName;
      try {
        const rows = await this.dataSource
          .getRepository(meta.target)
          .createQueryBuilder('t')
          .where('t."tenantId" = :tenantId', { tenantId })
          .getMany();

        const processed = rows.map((row) => this.postProcess(tableName, row));
        tables[tableName] = processed;
        totalRows += processed.length;
      } catch (err) {
        this.logger.warn(
          `Export for ${tableName} failed: ${(err as Error).message}. Skipping.`,
        );
        skipped.push(tableName);
      }
    }

    this.logger.log(
      `Exported tenant ${tenantId.slice(0, 8)}...: ${totalRows} rows across ` +
        `${Object.keys(tables).length} tables in ${Date.now() - start}ms` +
        (skipped.length ? `; skipped ${skipped.length}` : ''),
    );

    return {
      tenantId,
      exportedAt: new Date().toISOString(),
      tables,
      summary: {
        tableCount: Object.keys(tables).length,
        totalRows,
        skippedTables: skipped,
      },
    };
  }

  /** Visible for tests — the list of entities the export would target. */
  resolveTenantScopedEntities(): EntityMetadata[] {
    const all = this.dataSource.entityMetadatas;
    return all.filter((meta) =>
      meta.columns.some((col) => col.propertyName === 'tenantId'),
    );
  }

  /**
   * Per-table post-processing. The only universal rule today is
   * re-apply the phase-2.5 audit redaction to the `farm_audit_logs`
   * `changes` + `metadata` columns; defence-in-depth against a
   * policy tightening between write-time and export-time.
   */
  private postProcess(tableName: string, row: unknown): unknown {
    if (tableName !== 'farm_audit_logs') return row;
    if (!row || typeof row !== 'object') return row;
    const copy = { ...(row as Record<string, unknown>) };
    const changes = copy['changes'];
    const metadata = copy['metadata'];
    if (changes && typeof changes === 'object') {
      copy['changes'] = this.redaction.redactChanges(
        changes as Parameters<AuditRedactionService['redactChanges']>[0],
      );
    }
    if (metadata && typeof metadata === 'object') {
      copy['metadata'] = this.redaction.redactMetadata(
        metadata as Parameters<AuditRedactionService['redactMetadata']>[0],
      );
    }
    return copy;
  }
}
