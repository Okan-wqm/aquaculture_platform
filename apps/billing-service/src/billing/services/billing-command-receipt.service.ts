import * as crypto from 'crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { BillingAdminCommandResult } from '@platform/event-contracts';
import { DataSource } from 'typeorm';

/**
 * Who a receipt belongs to.
 *
 * `tenantId` is null for the platform-scoped catalogue commands (plans,
 * discount codes, module prices). The unique index is `NULLS NOT DISTINCT`, so
 * those rows are still exactly one-per-identity — no sentinel UUID pretends
 * they belong to a tenant.
 */
export interface BillingCommandIdentity {
  tenantId: string | null;
  commandType: string;
  idempotencyKey: string;
  actorId: string | null;
  correlationId: string;
}

interface ReceiptRow {
  id: string;
  payloadHash: string;
  status: 'STARTED' | 'SUCCEEDED' | 'FAILED';
  resultSummary: BillingAdminCommandResult | null;
}

/** The receipt's own refusals, in the shape every admin billing reply has. */
const IN_FLIGHT = (identity: BillingCommandIdentity): BillingAdminCommandResult => ({
  success: false,
  errorCode: 'CONFLICT',
  error:
    `A ${identity.commandType} with idempotency key "${identity.idempotencyKey}" is already ` +
    'in flight. Its outcome is not yet known, so re-running it could move money twice. ' +
    'Wait for it to finish, or — if its process died — supersede its billing.command_receipts ' +
    'row to release the key.',
});

const KEY_REUSED = (identity: BillingCommandIdentity): BillingAdminCommandResult => ({
  success: false,
  errorCode: 'CONFLICT',
  error:
    `Idempotency key "${identity.idempotencyKey}" was already used for a different ` +
    `${identity.commandType} payload. Answering with the first command's result would be a ` +
    'lie about what happened; send the new operation under its own key.',
});

/**
 * At-most-once execution for admin billing commands (ADR-0014).
 *
 * A NATS request-reply times out at 15s and is retried — by the operator, or
 * by the client. Before this existed nothing on the consumer side could tell
 * the retry from a new request. `RefundPaymentHandler` derives its Stripe
 * idempotency key from the ALREADY-REFUNDED total, so the retry of a refund
 * that had committed carried a different key and Stripe issued a second real
 * refund; the handler's own `refund <= refundable` guard passes for 50 + 50 on
 * a $100 payment.
 *
 * The receipt is claimed BEFORE the work and settled after:
 *
 *  - claim wins            → execute, then record SUCCEEDED (with the reply) or
 *                            FAILED (when the reply says `success: false`)
 *  - existing SUCCEEDED    → REPLAY the stored reply; the work does not run
 *  - existing FAILED       → the refusal was transient as far as we know, so
 *                            the key is reclaimed and the work runs again
 *  - existing STARTED      → indeterminate; refuse (fail closed)
 *  - payload hash differs  → the caller reused a key for different work; refuse
 *
 * The stored reply is the WIRE form. Every admin billing reply crosses NATS as
 * JSON, so replaying `resultSummary` hands the caller byte-for-byte what the
 * first attempt returned.
 */
@Injectable()
export class BillingCommandReceiptService {
  private readonly logger = new Logger(BillingCommandReceiptService.name);

  constructor(private readonly dataSource: DataSource) {}

  async runOnce(
    identity: BillingCommandIdentity,
    payload: unknown,
    execute: () => Promise<BillingAdminCommandResult>,
  ): Promise<BillingAdminCommandResult> {
    const payloadHash = this.hashPayload(payload);
    const claimed = await this.claim(identity, payloadHash);

    if (!claimed) {
      const existing = await this.load(identity);
      if (!existing) {
        // The row that blocked the claim is gone (superseded between the two
        // statements). Re-running the claim would race the same way, so the
        // honest answer is "retry", not a silent second execution.
        return IN_FLIGHT(identity);
      }
      if (existing.payloadHash !== payloadHash) {
        return KEY_REUSED(identity);
      }
      if (existing.status === 'SUCCEEDED') {
        this.logger.log(
          `Replaying ${identity.commandType} receipt ${existing.id} ` +
            `(idempotencyKey=${identity.idempotencyKey}, correlationId=${identity.correlationId})`,
        );
        return existing.resultSummary ?? { success: true };
      }
      if (existing.status === 'STARTED') {
        return IN_FLIGHT(identity);
      }
      if (!(await this.reclaim(existing.id, identity))) {
        return IN_FLIGHT(identity);
      }
      return this.settle(existing.id, execute);
    }

    return this.settle(claimed, execute);
  }

  /** sha256 over a key-order-independent rendering — the caller's field order must not change identity. */
  hashPayload(value: unknown): string {
    return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
  }

  private async settle(
    receiptId: string,
    execute: () => Promise<BillingAdminCommandResult>,
  ): Promise<BillingAdminCommandResult> {
    let result: BillingAdminCommandResult;
    try {
      result = await execute();
    } catch (err) {
      await this.markFailed(
        receiptId,
        'INTERNAL_ERROR',
        err instanceof Error ? err.message : String(err),
      );
      throw err;
    }

    if (result.success) {
      await this.dataSource.query(
        `UPDATE billing.command_receipts
            SET status = 'SUCCEEDED',
                "resultHash" = $2,
                "resultSummary" = $3::jsonb,
                "errorCode" = NULL,
                error = NULL,
                "completedAt" = NOW(),
                "updatedAt" = NOW()
          WHERE id = $1`,
        [receiptId, this.hashPayload(result), JSON.stringify(result)],
      );
      return result;
    }

    // A refusal is recorded FAILED, not SUCCEEDED: the operator's retry of a
    // transient error must RE-EXECUTE rather than be handed a cached failure
    // for ever.
    await this.markFailed(
      receiptId,
      result.errorCode ?? 'INTERNAL_ERROR',
      result.error ?? 'Command refused',
    );
    return result;
  }

  private async markFailed(receiptId: string, errorCode: string, error: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE billing.command_receipts
          SET status = 'FAILED',
              "errorCode" = $2,
              error = $3,
              "completedAt" = NOW(),
              "updatedAt" = NOW()
        WHERE id = $1`,
      [receiptId, errorCode.slice(0, 80), error],
    );
  }

  /** @returns the new receipt id, or null when one already exists for this identity. */
  private async claim(
    identity: BillingCommandIdentity,
    payloadHash: string,
  ): Promise<string | null> {
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `INSERT INTO billing.command_receipts (
         "tenantId", "commandType", "idempotencyKey", "payloadHash",
         status, "entityType", "actorId", "correlationId", "createdAt", "updatedAt"
       ) VALUES ($1, $2, $3, $4, 'STARTED', 'billing_command', $5, $6, NOW(), NOW())
       ON CONFLICT ("tenantId", "commandType", "idempotencyKey")
         WHERE "supersededAt" IS NULL
         DO NOTHING
       RETURNING id`,
      [
        identity.tenantId,
        identity.commandType,
        identity.idempotencyKey,
        payloadHash,
        identity.actorId,
        identity.correlationId,
      ],
    );
    return rows[0]?.id ?? null;
  }

  private async load(identity: BillingCommandIdentity): Promise<ReceiptRow | null> {
    const rows = await this.dataSource.query<ReceiptRow[]>(
      `SELECT id, "payloadHash", status, "resultSummary"
         FROM billing.command_receipts
        WHERE "tenantId" IS NOT DISTINCT FROM $1
          AND "commandType" = $2
          AND "idempotencyKey" = $3
          AND "supersededAt" IS NULL`,
      [identity.tenantId, identity.commandType, identity.idempotencyKey],
    );
    return rows[0] ?? null;
  }

  /** Take a FAILED receipt back to STARTED. Conditional, so two retries cannot both win. */
  private async reclaim(receiptId: string, identity: BillingCommandIdentity): Promise<boolean> {
    const rows = await this.dataSource.query<Array<{ id: string }>>(
      `UPDATE billing.command_receipts
          SET status = 'STARTED',
              "resultHash" = NULL,
              "resultSummary" = NULL,
              "errorCode" = NULL,
              error = NULL,
              "completedAt" = NULL,
              "correlationId" = $2,
              "updatedAt" = NOW()
        WHERE id = $1
          AND status = 'FAILED'
          AND "supersededAt" IS NULL
        RETURNING id`,
      [receiptId, identity.correlationId],
    );
    return rows.length > 0;
  }
}

/** Key-order-independent JSON rendering, so `{a,b}` and `{b,a}` hash alike. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
