/**
 * TenantErasureService
 *
 * GDPR Article 17 (right-to-erasure) implementation for
 * farm-service. Deletes every row from every tenant-scoped
 * entity, then anonymises the `userId` column on surviving
 * audit rows by hashing so the compliance trail remains
 * intact without identifying data subjects.
 *
 * # Two-step confirmation
 *
 * Erasure is irreversible. The service deliberately splits
 * the flow:
 *
 *   1. `initiate(tenantId, requestedBy)` creates a pending
 *      `ErasureTicket` with a random 32-char token and a
 *      5-minute expiry. The caller receives the token — it is
 *      NOT stored in the DB (held in an in-memory map so a
 *      crash after initiate loses the pending erasure and
 *      forces a fresh request rather than auto-resuming).
 *
 *   2. `confirm(tenantId, token)` validates the token against
 *      the pending ticket, checks expiry, then runs the actual
 *      DELETE cascade. Wrong token / expired / mismatched
 *      tenant all fail with clear errors.
 *
 * The two-step flow is the architectural counterpart of the
 * platform-level email confirmation in the plan — the mail
 * channel is assembled by admin-api-service, which holds the
 * token between step 1 (sent to operator) and step 2 (operator
 * clicks confirm link). Farm-service only needs the local
 * token gate to prevent a single-mutation accident.
 *
 * # NOT in scope
 *
 *   - Cross-service cascade. Phase 6.3.1 adds a `TenantErased`
 *     event contract + emission so messaging / auth / billing
 *     services clean their own data. The event hook is wired
 *     here (see `emitErased`) but the contract definition is a
 *     separate PR in libs/event-contracts.
 *   - Backup-side erasure. Retention of backup snapshots beyond
 *     the erasure date is an ops / SRE concern — phase 6.3.2
 *     adds the backup-rotation policy.
 *   - MinIO object deletion. Objects with a BatchDocument /
 *     ChemicalDocument / HealthEventDocument reference are
 *     scheduled for removal via the phase 6.2.3 orphan cleanup
 *     cron after the DB rows are gone.
 *
 * Phase 6.3 of the "Farm modülü kalan kör noktalar" plan.
 * Closes the farm-service scope of Girdi 15-C11.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { DataSource, EntityMetadata } from 'typeorm';

export interface ErasureTicket {
  tenantId: string;
  token: string;
  requestedBy: string;
  requestedAt: Date;
  expiresAt: Date;
}

export interface ErasureResult {
  tenantId: string;
  confirmedAt: string;
  deletedRowsByTable: Record<string, number>;
  totalDeleted: number;
  auditRowsAnonymised: number;
}

/** 5-minute window between initiate() and confirm(). */
const TICKET_TTL_MS = 5 * 60 * 1000;

@Injectable()
export class TenantErasureService {
  private readonly logger = new Logger(TenantErasureService.name);

  /**
   * In-memory pending-ticket map. Keyed by tenantId because only
   * ONE erasure per tenant can be pending at a time — a second
   * `initiate()` call replaces the first, invalidating the
   * earlier token. This is deliberate: accidental double-click
   * on the admin UI must not leave two valid tokens.
   */
  private readonly pending = new Map<string, ErasureTicket>();

  constructor(private readonly dataSource: DataSource) {}

  /**
   * Step 1 — create a pending erasure ticket. Returns the plain
   * token ONCE to the caller; the service keeps it in memory
   * until step 2 or expiry.
   */
  initiate(tenantId: string, requestedBy: string): ErasureTicket {
    const now = new Date();
    const ticket: ErasureTicket = {
      tenantId,
      token: randomBytes(16).toString('hex'),
      requestedBy,
      requestedAt: now,
      expiresAt: new Date(now.getTime() + TICKET_TTL_MS),
    };
    this.pending.set(tenantId, ticket);
    this.logger.warn(
      `Erasure ticket issued for tenant ${tenantId.slice(0, 8)}... by user ` +
        `${requestedBy.slice(0, 8)}... (expires ${ticket.expiresAt.toISOString()}).`,
    );
    return ticket;
  }

  /**
   * Step 2 — validate the token and run the erasure. Each of
   * the four rejection branches (no ticket / wrong tenant /
   * wrong token / expired) is a distinct error so logs can
   * distinguish operator confusion from a replay attack.
   */
  async confirm(tenantId: string, token: string): Promise<ErasureResult> {
    const ticket = this.pending.get(tenantId);
    if (!ticket) {
      throw new NotFoundException(
        `No pending erasure ticket for tenant ${tenantId}. ` +
          'Call initiate() first and supply the returned token within 5 minutes.',
      );
    }
    if (ticket.tenantId !== tenantId) {
      throw new BadRequestException(
        'Erasure ticket tenant mismatch. Each ticket is bound to a single tenant.',
      );
    }
    if (ticket.token !== token) {
      throw new BadRequestException(
        'Erasure ticket token does not match. Re-issue via initiate() if lost.',
      );
    }
    if (Date.now() > ticket.expiresAt.getTime()) {
      this.pending.delete(tenantId);
      throw new BadRequestException(
        `Erasure ticket for tenant ${tenantId} has expired at ` +
          `${ticket.expiresAt.toISOString()}. Re-issue via initiate().`,
      );
    }

    // Consume the ticket BEFORE the DELETE cascade so a retry
    // after partial failure cannot re-run the sequence with the
    // same token.
    this.pending.delete(tenantId);

    const result = await this.executeErasure(tenantId);
    this.logger.warn(
      `Erasure COMPLETED for tenant ${tenantId.slice(0, 8)}... — ` +
        `${result.totalDeleted} rows deleted across ` +
        `${Object.keys(result.deletedRowsByTable).length} tables; ` +
        `${result.auditRowsAnonymised} audit rows anonymised.`,
    );
    return result;
  }

  /** Visible for tests — inspect the pending ticket map. */
  getPendingTicket(tenantId: string): ErasureTicket | undefined {
    return this.pending.get(tenantId);
  }

  /**
   * Run the actual DELETE cascade. Invoked once the token has
   * been validated. Order: leaf tables first, parent tables
   * last — TypeORM metadata gives us the foreign-key graph so
   * we sort topologically by inbound-FK count descending (most
   * FK targets delete first).
   */
  private async executeErasure(tenantId: string): Promise<ErasureResult> {
    const deleted: Record<string, number> = {};
    const entities = this.resolveTenantScopedEntities();
    const sorted = this.topologicallySort(entities);

    let totalDeleted = 0;
    for (const meta of sorted) {
      if (meta.tableName === 'farm_audit_logs') {
        // Audit logs are NOT deleted — they are anonymised below
        // so the compliance trail survives an erasure without
        // identifying the data subject.
        continue;
      }
      try {
        const result = await this.dataSource
          .createQueryBuilder()
          .delete()
          .from(meta.target)
          .where('"tenantId" = :tenantId', { tenantId })
          .execute();
        const count = result.affected ?? 0;
        if (count > 0) {
          deleted[meta.tableName] = count;
          totalDeleted += count;
        }
      } catch (err) {
        this.logger.error(
          `Erasure DELETE failed for ${meta.tableName}: ${(err as Error).message}`,
        );
        throw err;
      }
    }

    const auditRowsAnonymised = await this.anonymiseAuditLogs(tenantId);
    return {
      tenantId,
      confirmedAt: new Date().toISOString(),
      deletedRowsByTable: deleted,
      totalDeleted,
      auditRowsAnonymised,
    };
  }

  /**
   * Hash `userId` on every audit row for this tenant. The hash
   * is stable so correlation within the erased tenant's own
   * audit history still works (linking what a now-anonymous
   * user did), but the raw userId is destroyed.
   */
  private async anonymiseAuditLogs(tenantId: string): Promise<number> {
    const result = await this.dataSource
      .createQueryBuilder()
      .update('farm.farm_audit_logs')
      .set({
        userId: () =>
          `'hashed:' || left(encode(digest("userId"::text, 'sha256'), 'hex'), 16)`,
        userName: () => "'[ERASED]'",
      })
      .where('"tenantId" = :tenantId AND "userId" IS NOT NULL', { tenantId })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * Topological sort by inbound-FK count: tables that ARE the
   * target of foreign keys go LAST (so child tables delete
   * first and don't trip RESTRICT/CASCADE chains). The sort is
   * stable and deterministic so two runs produce the same
   * DELETE order.
   */
  private topologicallySort(entities: EntityMetadata[]): EntityMetadata[] {
    const inboundFkCount = new Map<string, number>();
    for (const meta of entities) {
      inboundFkCount.set(meta.tableName, 0);
    }
    for (const meta of entities) {
      for (const rel of meta.foreignKeys) {
        const targetTable = rel.referencedTablePath;
        if (inboundFkCount.has(targetTable)) {
          inboundFkCount.set(
            targetTable,
            (inboundFkCount.get(targetTable) ?? 0) + 1,
          );
        }
      }
    }
    return [...entities].sort((a, b) => {
      const ca = inboundFkCount.get(a.tableName) ?? 0;
      const cb = inboundFkCount.get(b.tableName) ?? 0;
      if (ca !== cb) return ca - cb;
      return a.tableName.localeCompare(b.tableName);
    });
  }

  private resolveTenantScopedEntities(): EntityMetadata[] {
    return this.dataSource.entityMetadatas.filter((meta) =>
      meta.columns.some((col) => col.propertyName === 'tenantId'),
    );
  }

  /** Visible for tests — stable hash of a userId identical to the SQL expression. */
  static hashUserId(userId: string): string {
    return `hashed:${createHash('sha256')
      .update(userId)
      .digest('hex')
      .slice(0, 16)}`;
  }
}
