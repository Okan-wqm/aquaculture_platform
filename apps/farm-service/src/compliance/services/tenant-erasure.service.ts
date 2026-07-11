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
import {
  DataSource,
  EntityManager,
  EntityMetadata,
  ObjectLiteral,
  QueryDeepPartialEntity,
} from 'typeorm';
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
import {
  queryRowsNormalized,
  runInTenantTransaction,
} from '@aquaculture/backend-common/database';

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
   * Per-table count of rows RETAINED under the GDPR Art 17(3)(b)
   * legal-obligation carve-out (COMPLIANCE-HIGH-003) — government-filed
   * regulatory records kept, not deleted, with their PII columns
   * anonymised in place. `matchedRecordCount` includes these rows;
   * `deletedRowsByTable` / `totalDeleted` do NOT (they were never
   * deleted). The gap between matched and deleted is exactly the
   * retained set — the honest, auditable evidence that the controller
   * kept the legally-required records.
   */
  retainedRowsByTable: Record<string, number>;
  /** How many retained rows actually had a PII column hashed. */
  retainedRowsAnonymised: number;
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
const FARM_SOURCE_SCHEMA = 'farm';
const FARM_ERASURE_PROOF_LEDGER_SCHEMA = 'farm';
const FARM_ERASURE_PROOF_LEDGER_TABLE = 'tenant_erasure_target_proofs';
const FARM_ERASURE_AUDIT_TABLE = 'tenant_erasure_audit';
const FARM_OUTBOX_TABLE = 'outbox_events';

/**
 * The cross-tenant `farm.farm_audit_logs` ledger is RETAINED (never
 * hard-deleted) and its identifying columns anonymised in place by the
 * dedicated `anonymiseAuditLogs` path — it lives in the `farm` schema
 * and additionally redacts `userName`, so it cannot share the per-tenant
 * anonymise routine below. Naming it here keeps the complete
 * "never hard-deleted" set in ONE place so no table is silently deleted
 * (data lost) or silently skipped (PII left behind).
 */
const CROSS_TENANT_ANONYMISED_TABLE = 'farm_audit_logs';

/**
 * COMPLIANCE-HIGH-003 — GDPR Art 17(3)(b) legal-obligation carve-out.
 *
 * Government-filed regulatory records are RETAINED, never hard-deleted,
 * when a tenant is erased: Norwegian aquaculture law (Mattilsynet REST
 * filings, Fiskeridirektoratet FD-0001 biomass filings) mandates their
 * retention independently of the tenant relationship, and the migrations
 * that create them (`CreateRegulatoryReports`, biomass_reports) declare
 * "never drop — this is the legal audit trail" in their `down()`.
 *
 * The row survives the cascade; only its operator-identifying UUID
 * columns are anonymised in place (stable SHA-256 16-char prefix,
 * byte-identical to the `farm_audit_logs` treatment) so no direct
 * personal identifier remains — honouring Art 17 for the personal data
 * while preserving the legally-required record. This map is the SSoT
 * for that policy: per-tenant table name → the user-reference columns to
 * hash. A table listed here is skipped by the DELETE pass and routed
 * through `anonymiseRetainedRecords` instead.
 */
const STATUTORY_RETENTION_POLICY: ReadonlyMap<string, readonly string[]> =
  new Map<string, readonly string[]>([
    ['regulatory_reports', ['submittedBy']],
    ['biomass_reports', ['generatedBy', 'submittedBy', 'confirmedBy']],
  ]);

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

interface TenantErasureAuditRow {
  readonly tenantId: string;
  readonly confirmedAt: Date | string;
  readonly deletedRowsByTable: Record<string, number> | null;
  readonly totalDeleted: number | string;
  readonly auditRowsAnonymised: number | string;
  readonly retainedRowsByTable: Record<string, number> | null;
  readonly retainedRowsAnonymised: number | string;
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
        `${result.auditRowsAnonymised} audit rows anonymised; ` +
        `${this.sumValues(result.retainedRowsByTable)} rows retained under ` +
        `Art 17(3)(b) across ${Object.keys(result.retainedRowsByTable).length} ` +
        `regulatory tables (${result.retainedRowsAnonymised} anonymised).`,
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
   * enqueue) runs inside a single `runInTenantTransaction()` for the
   * `farm` source schema. That helper pins the transaction-local
   * `search_path` to `tenant_<uuid>` and ASSERTS `current_schema()`
   * + the RLS GUC resolve to this tenant BEFORE any DELETE runs — so
   * a destructive cascade can never execute against the source `farm`
   * schema or another tenant on a stale pooled connection (fail-closed
   * `TenantContextError`). The per-tenant DELETE/COUNT statements run
   * UNqualified so search_path routes them into the tenant schema; the
   * cross-tenant infrastructure rows (farm_audit_logs anonymise, the
   * tenant_erasure_audit row, the proof ledger, the outbox) stay
   * schema-qualified to `farm` and are therefore unaffected by the
   * pinned search_path.
   *
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

    return runInTenantTransaction(
      this.dataSource,
      FARM_SOURCE_SCHEMA,
      tenantId,
      async (queryRunner) => {
        const mgr = queryRunner.manager;
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
            retainedRowsByTable: {},
            retainedRowsAnonymised: 0,
            state: 'ALREADY_PURGED' as const,
          };
        }

        const deleted: Record<string, number> = {};
        const retained: Record<string, number> = {};
        let matchedRecordCount = 0;
        let totalDeleted = 0;
        let retainedRowsAnonymised = 0;

        for (const meta of sorted) {
          if (meta.tableName === CROSS_TENANT_ANONYMISED_TABLE) {
            // Audit logs are NOT deleted — they are anonymised below
            // so the compliance trail survives an erasure without
            // identifying the data subject.
            continue;
          }

          const retentionColumns = STATUTORY_RETENTION_POLICY.get(
            meta.tableName,
          );
          if (retentionColumns) {
            // GDPR Art 17(3)(b): government-filed regulatory record —
            // retained, not deleted. Count it (it was matched), then
            // anonymise its operator-identifying columns in place.
            try {
              const matched = await this.countTenantRows(mgr, meta, tenantId);
              if (matched > 0) {
                matchedRecordCount += matched;
                retained[meta.tableName] = matched;
                retainedRowsAnonymised += dryRun
                  ? 0
                  : await this.anonymiseRetainedRecords(
                      mgr,
                      meta,
                      tenantId,
                      retentionColumns,
                    );
              }
            } catch (err) {
              this.logger.error(
                `Erasure retention-anonymise failed for ${meta.tableName}: ` +
                  `${(err as Error).message}`,
              );
              throw err;
            }
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
            retainedRowsByTable: retained,
            retainedRowsAnonymised,
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
          retainedRowsByTable: retained,
          retainedRowsAnonymised,
          state: 'PURGED' as const,
        };
      },
    );
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
        retainedRowsByTable: {},
        retainedRowsAnonymised: 0,
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
      retainedRowsByTable: {},
      retainedRowsAnonymised: 0,
      state,
    };
  }

  /**
   * Look up an existing erasure-audit row to support the
   * idempotency contract on `confirm()`. Returns the
   * reconstructed ErasureResult tagged `state: 'ALREADY_PURGED'`
   * on hit, or null on miss.
   *
   * # Why a schema-qualified raw read (NOT a tenant-pinned read)
   *
   * `farm.tenant_erasure_audit` is CROSS-TENANT infrastructure —
   * it is in farm's `MODULE_SCHEMAS[].infrastructureTables` and the
   * entity declares `schema: 'farm'`. The row records that a whole
   * TENANT was erased, so routing the lookup through the tenant
   * boundary would be circular (the tenant schema is exactly what
   * the row attests was emptied). The read is explicitly
   * `"farm"."tenant_erasure_audit"` qualified and filtered BY
   * `tenantId`, so it resolves against the cross-tenant table
   * regardless of the connection's search_path and never touches a
   * per-tenant schema. A bare repository handle would route through
   * the same connection but offers no isolation benefit here and is
   * banned platform-wide, so we issue the qualified query directly.
   *
   * Reads outside the cascade transaction — a separate read-only
   * query is fine because the audit row is immutable (the
   * trigger forbids UPDATE/DELETE), so we can never see a
   * mid-mutation snapshot.
   */
  private async lookupExistingErasure(
    tenantId: string,
  ): Promise<ErasureResult | null> {
    const rows = queryRowsNormalized<TenantErasureAuditRow>(
      await this.dataSource.query(
        `
          SELECT
            "tenantId",
            "confirmedAt",
            "deletedRowsByTable",
            "totalDeleted",
            "auditRowsAnonymised",
            "retainedRowsByTable",
            "retainedRowsAnonymised"
          FROM "${FARM_ERASURE_PROOF_LEDGER_SCHEMA}"."${FARM_ERASURE_AUDIT_TABLE}"
          WHERE "tenantId" = $1
          LIMIT 1
        `,
        [tenantId],
      ),
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    const totalDeleted = this.numberFromRow(row.totalDeleted, 'totalDeleted');
    const auditRowsAnonymised = this.numberFromRow(
      row.auditRowsAnonymised,
      'auditRowsAnonymised',
    );
    const retainedRowsByTable = row.retainedRowsByTable ?? {};
    const retainedRowsAnonymised = this.numberFromRow(
      row.retainedRowsAnonymised,
      'retainedRowsAnonymised',
    );
    return {
      tenantId: row.tenantId,
      confirmedAt: this.isoFromRow(row.confirmedAt),
      deletedRowsByTable: row.deletedRowsByTable ?? {},
      totalDeleted,
      // Reconstruct the original matched count byte-identically: deleted
      // rows + anonymised audit rows + retained (matched-but-kept) rows.
      matchedRecordCount:
        totalDeleted + auditRowsAnonymised + this.sumValues(retainedRowsByTable),
      auditRowsAnonymised,
      retainedRowsByTable,
      retainedRowsAnonymised,
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
   * Anonymise the operator-identifying columns on a statutory-retention
   * table in place (COMPLIANCE-HIGH-003). The row is RETAINED under the
   * GDPR Art 17(3)(b) legal-obligation carve-out; only the direct
   * personal identifiers (the user-reference UUID columns) are destroyed
   * by overwriting them with a stable SHA-256 16-char prefix — the exact
   * expression `anonymiseAuditLogs` uses, so a hashed id is byte-identical
   * whichever table carried it.
   *
   * Runs UNqualified through `meta.target` so the transaction-pinned
   * tenant search_path routes the UPDATE into `tenant_<uuid>` (these are
   * per-tenant tables). Only rows that still carry at least one non-null
   * identifier are touched, so the affected count reflects real PII
   * removed rather than rows that were already clean.
   */
  private async anonymiseRetainedRecords(
    mgr: EntityManager,
    meta: EntityMetadata,
    tenantId: string,
    columns: readonly string[],
  ): Promise<number> {
    const assignments: Record<string, () => string> = {};
    for (const column of columns) {
      assignments[column] = () =>
        `'hashed:' || left(encode(digest("${column}"::text, 'sha256'), 'hex'), 16)`;
    }
    const anyIdentifierPresent = columns
      .map((column) => `"${column}" IS NOT NULL`)
      .join(' OR ');
    const result = await mgr
      .createQueryBuilder()
      .update(meta.target)
      .set(assignments as QueryDeepPartialEntity<ObjectLiteral>)
      .where(`"tenantId" = :tenantId AND (${anyIdentifierPresent})`, {
        tenantId,
      })
      .execute();
    return result.affected ?? 0;
  }

  private sumValues(counts: Record<string, number>): number {
    return Object.values(counts).reduce((total, value) => total + value, 0);
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
