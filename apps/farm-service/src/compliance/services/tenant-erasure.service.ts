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
 *   - Cross-service orchestration. Farm publishes service-scoped
 *     `TenantDataErased` proof only. The platform orchestrator emits
 *     final `TenantErased` after every target service succeeds.
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
import { createHash, randomBytes, randomUUID } from 'crypto';
import { DataSource, EntityManager, EntityMetadata } from 'typeorm';
import { OutboxPublisher } from '@platform/outbox';
import {
  createBaseEvent,
  TenantDataErasedEvent,
  TenantDataErasureFailedEvent,
  TenantErasureBlockedEvent,
  TenantErasureRequestedEvent,
} from '@platform/event-contracts';
import {
  LegalHoldActiveError,
  LegalHoldService,
} from '@aquaculture/backend-common/compliance';
import { queryRowsNormalized } from '@aquaculture/backend-common/database';

import { TenantErasureAuditEntity } from '../entities/tenant-erasure-audit.entity';

export interface ErasureTicket {
  operationId: string;
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
  matchedRecordCount: number;
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
  state: 'PURGED' | 'ALREADY_PURGED' | 'BLOCKED' | 'FAILED';
}

/** 5-minute window between initiate() and confirm(). */
const TICKET_TTL_MS = 5 * 60 * 1000;
const FARM_ERASURE_PROOF_LEDGER_SCHEMA = 'farm';
const FARM_ERASURE_PROOF_LEDGER_TABLE = 'tenant_erasure_target_proofs';
const FARM_OUTBOX_TABLE = 'outbox_events';

interface TenantErasureStoredProofRow {
  readonly operationId: string;
  readonly tenantId: string;
  readonly eventId: string;
  readonly proofHash: string;
  readonly erasedAt: Date | string;
  readonly dryRun: boolean;
  readonly matchedRecordCount: number | string;
  readonly erasedRecordCount: number | string;
}

interface CountRow {
  readonly count: string;
}

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
    private readonly outboxPublisher: OutboxPublisher,
    private readonly legalHoldService: LegalHoldService,
  ) {}

  /**
   * Step 1 — create a pending erasure ticket. Returns the plain
   * token ONCE to the caller; the service keeps it in memory
   * until step 2 or expiry.
   */
  initiate(tenantId: string, requestedBy: string): ErasureTicket {
    const now = new Date();
    const ticket: ErasureTicket = {
      operationId: randomUUID(),
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
   * branch; no second cascade fires; no second TenantDataErased
   * proof is emitted.
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
    await this.legalHoldService.assertNoHold(tenantId, 'tenant');

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

    const result = await this.executeErasure(
      tenantId,
      ticket.requestedBy,
      ticket.operationId,
    );
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
   * Event-driven entrypoint used by the platform erasure orchestrator.
   * The manual two-step confirm flow above remains available for local
   * farm-only operations, but cross-service GDPR erasure is owned by
   * admin-api's TenantErasureRequested operation ledger.
   */
  async eraseFromTenantErasureRequest(
    event: TenantErasureRequestedEvent,
  ): Promise<ErasureResult> {
    const storedProof = await this.readStoredProof(event);
    if (storedProof) {
      return this.emitStoredProof(event, storedProof);
    }

    try {
      await this.legalHoldService.assertNoHold(event.tenantId, 'tenant');
    } catch (error) {
      if (error instanceof LegalHoldActiveError) {
        await this.emitBlocked(event, error);
        return this.emptyEventResult(event, 'BLOCKED');
      }
      await this.emitFailure(event, error, true);
      return this.emptyEventResult(event, 'FAILED');
    }

    try {
      const replay = await this.lookupExistingErasure(event.tenantId);
      if (replay) {
        await this.emitReplayProof(event, replay);
        return replay;
      }

      const result = await this.executeErasure(
        event.tenantId,
        event.requestedBy,
        event.operationId,
        event.dryRun,
      );
      this.logger.warn(
        `Orchestrated erasure COMPLETED for tenant ${event.tenantId.slice(0, 8)}... — ` +
          `${result.totalDeleted} rows deleted.`,
      );
      return result;
    } catch (error) {
      await this.emitFailure(event, error, true);
      return this.emptyEventResult(event, 'FAILED');
    }
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
   * `TenantDataErased` proof is never emitted — the orchestrator
   * withholds the final `TenantErased` proof until every target has
   * committed its own data-erasure proof.
   */
  private async executeErasure(
    tenantId: string,
    requestedBy: string,
    operationId: string,
    dryRun = false,
  ): Promise<ErasureResult> {
    const entities = this.resolveTenantScopedEntities();
    const sorted = this.topologicallySort(entities);

    return this.dataSource.transaction(async (mgr) => {
      await this.lockOperation(mgr, operationId);
      const existingProof = await this.readStoredProofByIds(
        mgr,
        operationId,
        tenantId,
      );
      if (existingProof) {
        return {
          tenantId,
          confirmedAt: this.isoFromRow(existingProof.erasedAt),
          deletedRowsByTable: {},
          totalDeleted: this.numberFromRow(
            existingProof.erasedRecordCount,
            'erasedRecordCount',
          ),
          matchedRecordCount: this.numberFromRow(
            existingProof.matchedRecordCount,
            'matchedRecordCount',
          ),
          auditRowsAnonymised: 0,
          state: 'ALREADY_PURGED' as const,
        };
      }

      const deleted: Record<string, number> = {};
      let matchedRecordCount = 0;
      let totalDeleted = 0;

      for (const meta of sorted) {
        if (meta.tableName === 'farm_audit_logs') {
          // Audit logs are NOT deleted — they are anonymised below
          // so the compliance trail survives an erasure without
          // identifying the data subject.
          continue;
        }
        try {
          const matched = await this.countTenantRows(mgr, meta, tenantId);
          matchedRecordCount += matched;
          const erased = dryRun
            ? 0
            : await this.deleteTenantRows(mgr, meta, tenantId);
          if (matched > 0 || erased > 0) {
            deleted[meta.tableName] = erased;
            totalDeleted += erased;
          }
        } catch (err) {
          this.logger.error(
            `Erasure DELETE failed for ${meta.tableName}: ${(err as Error).message}`,
          );
          throw err;
        }
      }

      const matchedAuditRows = await this.countAuditLogs(tenantId, mgr);
      matchedRecordCount += matchedAuditRows;
      const auditRowsAnonymised = dryRun
        ? 0
        : await this.anonymiseAuditLogs(tenantId, mgr);
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
      if (!dryRun) {
        await mgr.insert(TenantErasureAuditEntity, {
          tenantId,
          confirmedAt: new Date(confirmedAt),
          requestedBy,
          totalDeleted,
          auditRowsAnonymised,
          tableCount,
          deletedRowsByTable: deleted,
        });
      }

      // Emit service-scoped proof to the transactional outbox INSIDE
      // the same transaction. Farm is one target in the platform
      // erasure roster; only the orchestrator may emit the final
      // TenantErased proof after every target succeeds.
      const erasedEvent: TenantDataErasedEvent = {
        ...createBaseEvent<TenantDataErasedEvent>('TenantDataErased', tenantId, {
          aggregateId: tenantId,
          aggregateType: 'Tenant',
        }),
        timestamp: confirmedAt,
        userId: requestedBy,
        operationId,
        targetService: 'farm-service',
        erasedAt: confirmedAt,
        dryRun,
        matchedRecordCount,
        erasedRecordCount: totalDeleted,
        proofHash: this.createServiceProofHash({
          tenantId,
          operationId,
          confirmedAt,
          dryRun,
          matchedRecordCount,
          totalDeleted,
          auditRowsAnonymised,
          tableCount,
        }),
      };
      await this.recordProofLedger(mgr, erasedEvent);
      await this.outboxPublisher.enqueue(erasedEvent, mgr, {
        aggregateId: tenantId,
        idempotencyKey: `tenant-erasure:${operationId}:farm-service`,
      });

      return {
        tenantId,
        confirmedAt,
        deletedRowsByTable: deleted,
        totalDeleted,
        matchedRecordCount,
        auditRowsAnonymised,
        state: 'PURGED' as const,
      };
    });
  }

  private async emitReplayProof(
    event: TenantErasureRequestedEvent,
    replay: ErasureResult,
  ): Promise<void> {
    await this.dataSource.transaction(async (mgr) => {
      const erasedEvent: TenantDataErasedEvent = {
        ...createBaseEvent<TenantDataErasedEvent>('TenantDataErased', event.tenantId, {
          aggregateId: event.tenantId,
          aggregateType: 'Tenant',
        }),
        timestamp: replay.confirmedAt,
        userId: event.requestedBy,
        operationId: event.operationId,
        targetService: 'farm-service',
        erasedAt: replay.confirmedAt,
        dryRun: false,
        matchedRecordCount: replay.matchedRecordCount,
        erasedRecordCount: replay.totalDeleted,
        proofHash: this.createServiceProofHash({
          tenantId: event.tenantId,
          operationId: event.operationId,
          confirmedAt: replay.confirmedAt,
          dryRun: false,
          matchedRecordCount: replay.matchedRecordCount,
          totalDeleted: replay.totalDeleted,
          auditRowsAnonymised: replay.auditRowsAnonymised,
          tableCount: Object.keys(replay.deletedRowsByTable).length,
        }),
      };
      await this.recordProofLedger(mgr, erasedEvent);
      await this.outboxPublisher.enqueue(erasedEvent, mgr, {
        aggregateId: event.tenantId,
        idempotencyKey: `tenant-erasure:${event.operationId}:farm-service`,
      });
    });
  }

  private async readStoredProof(
    event: TenantErasureRequestedEvent,
  ): Promise<TenantErasureStoredProofRow | null> {
    return this.readStoredProofByIds(
      this.dataSource,
      event.operationId,
      event.tenantId,
    );
  }

  private async readStoredProofByIds(
    queryable: Pick<EntityManager | DataSource, 'query'>,
    operationId: string,
    tenantId: string,
  ): Promise<TenantErasureStoredProofRow | null> {
    const rows = queryRowsNormalized<TenantErasureStoredProofRow>(
      await queryable.query(
        `
          SELECT
            "operationId",
            "tenantId",
            "eventId",
            "proofHash",
            "erasedAt",
            "dryRun",
            "matchedRecordCount",
            "erasedRecordCount"
          FROM "${FARM_ERASURE_PROOF_LEDGER_SCHEMA}"."${FARM_ERASURE_PROOF_LEDGER_TABLE}"
          WHERE "operationId" = $1
            AND "tenantId" = $2
            AND "targetService" = 'farm-service'
          LIMIT 1
        `,
        [operationId, tenantId],
      ),
    );
    return rows[0] ?? null;
  }

  private async emitStoredProof(
    event: TenantErasureRequestedEvent,
    storedProof: TenantErasureStoredProofRow,
  ): Promise<ErasureResult> {
    return this.dataSource.transaction(async (mgr) => {
      const idempotencyKey = `tenant-erasure:${event.operationId}:farm-service`;
      const alreadyQueued = await this.hasOutboxRow(
        mgr,
        event.tenantId,
        idempotencyKey,
      );
      if (!alreadyQueued) {
        await this.outboxPublisher.enqueue(
          this.storedProofToEvent(event, storedProof),
          mgr,
          {
            aggregateId: event.tenantId,
            idempotencyKey,
          },
        );
      }
      const matchedRecordCount = this.numberFromRow(
        storedProof.matchedRecordCount,
        'matchedRecordCount',
      );
      const erasedRecordCount = this.numberFromRow(
        storedProof.erasedRecordCount,
        'erasedRecordCount',
      );
      return {
        tenantId: event.tenantId,
        confirmedAt: this.isoFromRow(storedProof.erasedAt),
        deletedRowsByTable: {},
        totalDeleted: erasedRecordCount,
        matchedRecordCount,
        auditRowsAnonymised: 0,
        state: 'ALREADY_PURGED' as const,
      };
    });
  }

  private storedProofToEvent(
    event: TenantErasureRequestedEvent,
    storedProof: TenantErasureStoredProofRow,
  ): TenantDataErasedEvent {
    const erasedAt = this.isoFromRow(storedProof.erasedAt);
    return {
      eventId: storedProof.eventId as TenantDataErasedEvent['eventId'],
      eventType: 'TenantDataErased',
      timestamp: erasedAt,
      tenantId: event.tenantId,
      version: 1,
      aggregateId: event.tenantId,
      aggregateType: 'Tenant',
      userId: event.requestedBy,
      operationId: event.operationId,
      targetService: 'farm-service',
      erasedAt,
      dryRun: storedProof.dryRun,
      matchedRecordCount: this.numberFromRow(
        storedProof.matchedRecordCount,
        'matchedRecordCount',
      ),
      erasedRecordCount: this.numberFromRow(
        storedProof.erasedRecordCount,
        'erasedRecordCount',
      ),
      proofHash: storedProof.proofHash,
    };
  }

  private async recordProofLedger(
    mgr: EntityManager,
    event: TenantDataErasedEvent,
  ): Promise<void> {
    await mgr.query(
      `
        INSERT INTO "${FARM_ERASURE_PROOF_LEDGER_SCHEMA}"."${FARM_ERASURE_PROOF_LEDGER_TABLE}" (
          "operationId",
          "tenantId",
          "targetService",
          "eventId",
          "proofHash",
          "erasedAt",
          "dryRun",
          "matchedRecordCount",
          "erasedRecordCount"
        ) VALUES ($1, $2, 'farm-service', $3, $4, $5, $6, $7, $8)
        ON CONFLICT ("operationId", "targetService") DO NOTHING
      `,
      [
        event.operationId,
        event.tenantId,
        event.eventId,
        event.proofHash,
        event.erasedAt,
        event.dryRun,
        event.matchedRecordCount,
        event.erasedRecordCount,
      ],
    );
  }

  private async hasOutboxRow(
    mgr: EntityManager,
    tenantId: string,
    idempotencyKey: string,
  ): Promise<boolean> {
    const rows = queryRowsNormalized<CountRow>(
      await mgr.query(
        `
          SELECT COUNT(*)::text AS count
          FROM "${FARM_ERASURE_PROOF_LEDGER_SCHEMA}"."${FARM_OUTBOX_TABLE}"
          WHERE "tenantId" = $1
            AND "idempotencyKey" = $2
        `,
        [tenantId, idempotencyKey],
      ),
    );
    return Number.parseInt(rows[0]?.count ?? '0', 10) > 0;
  }

  private async lockOperation(
    mgr: EntityManager,
    operationId: string,
  ): Promise<void> {
    await mgr.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
      `tenant-erasure:${operationId}:farm-service`,
    ]);
  }

  private async emitBlocked(
    event: TenantErasureRequestedEvent,
    error: LegalHoldActiveError,
  ): Promise<void> {
    await this.dataSource.transaction(async (mgr) => {
      const blockedAt = new Date().toISOString();
      const blockedEvent: TenantErasureBlockedEvent = {
        ...createBaseEvent<TenantErasureBlockedEvent>(
          'TenantErasureBlocked',
          event.tenantId,
          {
            aggregateId: event.tenantId,
            aggregateType: 'Tenant',
          },
        ),
        timestamp: blockedAt,
        userId: event.requestedBy,
        operationId: event.operationId,
        blockedAt,
        blockedByService: 'farm-service',
        reason: error.message,
        legalMatterId: error.legalMatterId,
      };
      await this.outboxPublisher.enqueue(blockedEvent, mgr, {
        aggregateId: event.tenantId,
        idempotencyKey: `tenant-erasure:${event.operationId}:farm-service:blocked`,
      });
    });
  }

  private async emitFailure(
    event: TenantErasureRequestedEvent,
    error: unknown,
    retryable: boolean,
  ): Promise<void> {
    await this.dataSource.transaction(async (mgr) => {
      const failedAt = new Date().toISOString();
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failureEvent: TenantDataErasureFailedEvent = {
        ...createBaseEvent<TenantDataErasureFailedEvent>(
          'TenantDataErasureFailed',
          event.tenantId,
          {
            aggregateId: event.tenantId,
            aggregateType: 'Tenant',
          },
        ),
        timestamp: failedAt,
        userId: event.requestedBy,
        operationId: event.operationId,
        targetService: 'farm-service',
        failedAt,
        errorCode: error instanceof Error ? error.name : 'TenantErasureError',
        errorMessage,
        retryable,
      };
      await this.outboxPublisher.enqueue(failureEvent, mgr, {
        aggregateId: event.tenantId,
        idempotencyKey: `tenant-erasure:${event.operationId}:farm-service:failed`,
      });
    });
  }

  private emptyEventResult(
    event: TenantErasureRequestedEvent,
    state: 'BLOCKED' | 'FAILED',
  ): ErasureResult {
    return {
      tenantId: event.tenantId,
      confirmedAt: new Date().toISOString(),
      deletedRowsByTable: {},
      totalDeleted: 0,
      matchedRecordCount: 0,
      auditRowsAnonymised: 0,
      state,
    };
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
      matchedRecordCount: row.totalDeleted + row.auditRowsAnonymised,
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

  private async countTenantRows(
    mgr: EntityManager,
    meta: EntityMetadata,
    tenantId: string,
  ): Promise<number> {
    const row = await mgr
      .createQueryBuilder()
      .select('COUNT(*)', 'count')
      .from(meta.target, 'row')
      .where('"tenantId" = :tenantId', { tenantId })
      .getRawOne<CountRow>();
    return Number.parseInt(row?.count ?? '0', 10);
  }

  private async deleteTenantRows(
    mgr: EntityManager,
    meta: EntityMetadata,
    tenantId: string,
  ): Promise<number> {
    const result = await mgr
      .createQueryBuilder()
      .delete()
      .from(meta.target)
      .where('"tenantId" = :tenantId', { tenantId })
      .execute();
    return result.affected ?? 0;
  }

  private async countAuditLogs(
    tenantId: string,
    mgr: EntityManager,
  ): Promise<number> {
    const rows = queryRowsNormalized<CountRow>(
      await mgr.query(
        `SELECT COUNT(*)::text AS count
           FROM farm.farm_audit_logs
          WHERE "tenantId" = $1
            AND "userId" IS NOT NULL`,
        [tenantId],
      ),
    );
    return Number.parseInt(rows[0]?.count ?? '0', 10);
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

  private createServiceProofHash(args: {
    tenantId: string;
    operationId: string;
    confirmedAt: string;
    dryRun: boolean;
    matchedRecordCount: number;
    totalDeleted: number;
    auditRowsAnonymised: number;
    tableCount: number;
  }): string {
    const material = [
      'farm-service',
      args.tenantId,
      args.operationId,
      args.confirmedAt,
      String(args.dryRun),
      String(args.matchedRecordCount),
      String(args.totalDeleted),
      String(args.auditRowsAnonymised),
      String(args.tableCount),
    ].join('|');
    return `sha256:${createHash('sha256').update(material).digest('hex')}`;
  }

  private numberFromRow(value: number | string, field: string): number {
    const parsed = typeof value === 'number' ? value : Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Farm tenant erasure proof ledger ${field} is not numeric`);
    }
    return parsed;
  }

  private isoFromRow(value: Date | string): string {
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }
}
