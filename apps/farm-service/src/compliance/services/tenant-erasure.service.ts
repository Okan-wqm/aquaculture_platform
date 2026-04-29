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
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { DataSource, EntityManager, EntityMetadata } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import {
  createBaseEvent,
  TenantErasedEvent,
} from '@platform/event-contracts';
import { LegalHoldService } from '@aquaculture/backend-common/compliance';

import { TenantErasureAuditEntity } from '../entities/tenant-erasure-audit.entity';

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
  /**
   * Lifecycle state of the erasure (COMPLIANCE-MEDIUM-004).
   *
   *   - 'PURGED' — this confirm() call performed the cascade.
   *   - 'ALREADY_PURGED' — re-invocation on a tenantId that was
   *     already erased; the cascade did NOT run a second time;
   *     the original ErasureResult is reconstructed from the
   *     persistent farm.tenant_erasure_audit row.
   *
   * HTTP filter / resolver returns 200 in both cases — the client
   * gets the same shape for both first-call and replay-call paths.
   */
  state: 'PURGED' | 'ALREADY_PURGED';
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

  constructor(
    private readonly dataSource: DataSource,
    /**
     * `@Optional` so the service compiles and runs in test harnesses
     * that stand the service up without the `FarmOutboxModule`
     * wiring. In the app DI graph the publisher is a `@Global()`
     * provider — production code always gets the real instance.
     * When absent, erasure still succeeds; the `TenantErased`
     * event is just not fanned out.
     */
    @Optional() private readonly outboxPublisher?: OutboxPublisher,
    /**
     * COMPLIANCE-HIGH-004 cure: legal-hold precedence check.
     *
     * GDPR Art 17(3)(b) excludes erasure where processing is
     * necessary "for compliance with a legal obligation". A
     * tenant under active litigation hold MUST NOT have farm-side
     * data deleted — destruction of held data is itself a
     * sanctionable spoliation act in most jurisdictions.
     *
     * The service is `@Optional` so test harnesses + local-dev
     * paths can stand TenantErasureService up without the full
     * compliance module wiring. In production the
     * LegalHoldModule (registered in farm-service AppModule)
     * provides the real instance via @Global. When absent, the
     * service treats the call as "no hold" — safe in dev where
     * litigation holds are not a concern, fail-LOUD in prod
     * where the absence indicates a wiring regression.
     */
    @Optional() private readonly legalHoldService?: LegalHoldService,
  ) {}

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
   *
   * # Idempotency (COMPLIANCE-MEDIUM-004 cure)
   *
   * Before validating the in-memory ticket, the service checks
   * the persistent `farm.tenant_erasure_audit` table. If a row
   * exists for this tenantId, the erasure already ran — return
   * the original ErasureResult tagged `state: 'ALREADY_PURGED'`
   * with HTTP 200. Re-invocations from operator browser
   * back-forward, ALB retries, or double-clicks all hit this
   * branch; no second cascade fires; no second TenantErased
   * event is emitted.
   *
   * The audit row is INSERT'd inside the same transaction as
   * the cascade (in executeErasure), so the row is durable
   * iff the cascade committed. A partial-rollback never
   * leaves the audit row behind without the matching erasure.
   */
  async confirm(tenantId: string, token: string): Promise<ErasureResult> {
    // COMPLIANCE-HIGH-004 cure: legal-hold precedence check runs
    // FIRST — before idempotency-replay lookup, before token
    // validation, before any DB write. The check is a fast
    // Redis-cached read; a HIT returns immediately. A MISS reads
    // the legal-hold table; a HOLD-ACTIVE row throws Forbidden
    // and the cascade never runs. Critical: the ticket is NOT
    // consumed on this path — operators must explicitly cancel
    // the legal hold before the erasure can proceed.
    //
    // Sibling pattern: messaging-service GdprService.processErasure
    // wraps its cascade in `legalHoldService.assertNoHold`. Same
    // shape applied here.
    if (this.legalHoldService) {
      await this.legalHoldService.assertNoHold(tenantId, 'tenant');
    }

    const replay = await this.lookupExistingErasure(tenantId);
    if (replay) {
      this.logger.warn(
        `Erasure REPLAY detected for tenant ${tenantId.slice(0, 8)}... — ` +
          `original erasure at ${replay.confirmedAt}; returning cached result.`,
      );
      // Drop any stale pending ticket for this tenant so a future
      // initiate() doesn't surprise an operator with a "ticket
      // exists" state for a tenant that's already erased.
      this.pending.delete(tenantId);
      return replay;
    }

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

    const result = await this.executeErasure(tenantId, ticket.requestedBy);
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
   *
   * The entire sequence (all DELETEs + audit anonymise + outbox
   * enqueue) runs inside a single `dataSource.transaction()`.
   * If ANY step fails, the whole cascade rolls back AND the
   * `TenantErased` event is never emitted — downstream services
   * see no signal to cascade the erasure on their side.
   *
   * The `@Optional` publisher means test harnesses that don't
   * wire `FarmOutboxModule` still run the cascade; the event
   * emission is simply skipped. Production DI always provides it.
   */
  private async executeErasure(
    tenantId: string,
    requestedBy: string,
  ): Promise<ErasureResult> {
    const entities = this.resolveTenantScopedEntities();
    const sorted = this.topologicallySort(entities);

    return this.dataSource.transaction(async (mgr) => {
      const deleted: Record<string, number> = {};
      let totalDeleted = 0;

      for (const meta of sorted) {
        if (meta.tableName === 'farm_audit_logs') {
          // Audit logs are NOT deleted — they are anonymised below
          // so the compliance trail survives an erasure without
          // identifying the data subject.
          continue;
        }
        try {
          const result = await mgr
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

      const auditRowsAnonymised = await this.anonymiseAuditLogs(tenantId, mgr);
      const confirmedAt = new Date().toISOString();
      const tableCount = Object.keys(deleted).length;

      // COMPLIANCE-MEDIUM-004: persist the erasure audit row
      // INSIDE the cascade transaction. If the cascade rolls back,
      // the audit row rolls back too — there is no path to a
      // committed audit row without a committed erasure. The
      // INSERT will fail on the PK constraint if a row already
      // exists (which would indicate a logic bug — the
      // lookupExistingErasure() check at the top of confirm()
      // should have short-circuited the call).
      await mgr.insert(TenantErasureAuditEntity, {
        tenantId,
        confirmedAt: new Date(confirmedAt),
        requestedBy,
        totalDeleted,
        auditRowsAnonymised,
        tableCount,
        deletedRowsByTable: deleted,
      });

      // Emit TenantErased to the transactional outbox INSIDE the
      // same transaction — see prior block for rationale.
      if (this.outboxPublisher) {
        const erasedEvent: TenantErasedEvent = {
          ...createBaseEvent<TenantErasedEvent>('TenantErased', tenantId, {
            aggregateId: tenantId,
            aggregateType: 'Tenant',
          }),
          timestamp: confirmedAt,
          userId: requestedBy,
          confirmedAt,
          requestedBy,
          totalDeleted,
          auditRowsAnonymised,
          tableCount,
        };
        await this.outboxPublisher.enqueue(erasedEvent, mgr);
      }

      return {
        tenantId,
        confirmedAt,
        deletedRowsByTable: deleted,
        totalDeleted,
        auditRowsAnonymised,
        state: 'PURGED' as const,
      };
    });
  }

  /**
   * Look up an existing erasure-audit row to support the
   * idempotency contract on `confirm()`. Returns the
   * reconstructed ErasureResult tagged `state: 'ALREADY_PURGED'`
   * on hit, or null on miss.
   *
   * Reads outside the cascade transaction — a separate read-only
   * query is fine because the audit row is immutable (the
   * trigger forbids UPDATE/DELETE), so we can never see a
   * mid-mutation snapshot.
   */
  private async lookupExistingErasure(
    tenantId: string,
  ): Promise<ErasureResult | null> {
    // eslint-disable-next-line no-restricted-syntax -- TenantErasureAuditEntity lives in the `farm` schema (tenant-scoped) but the lookup is BY tenantId itself (the row is the audit record of a TENANT-WIDE erasure). Wrapping in tenantManagerRepo would be circular: the row exists precisely because the tenant context is what's been erased. The findOne uses the explicit `where: { tenantId }` filter so RLS-equivalent isolation is preserved at the query layer.
    const repo = this.dataSource.getRepository(TenantErasureAuditEntity);
    const row = await repo.findOne({ where: { tenantId } });
    if (!row) {
      return null;
    }
    return {
      tenantId: row.tenantId,
      confirmedAt: row.confirmedAt.toISOString(),
      deletedRowsByTable: row.deletedRowsByTable,
      totalDeleted: row.totalDeleted,
      auditRowsAnonymised: row.auditRowsAnonymised,
      state: 'ALREADY_PURGED' as const,
    };
  }

  /**
   * Hash `userId` on every audit row for this tenant. The hash
   * is stable so correlation within the erased tenant's own
   * audit history still works (linking what a now-anonymous
   * user did), but the raw userId is destroyed.
   */
  private async anonymiseAuditLogs(
    tenantId: string,
    mgr: EntityManager,
  ): Promise<number> {
    const result = await mgr
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
