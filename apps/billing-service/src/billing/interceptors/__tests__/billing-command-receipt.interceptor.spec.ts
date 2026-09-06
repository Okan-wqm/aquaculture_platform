/**
 * Admin billing commands execute AT MOST ONCE (ADR-0014, BILLING-CRITICAL-003).
 *
 * `BillingAdminCommandMeta` carried only an `actorId`. admin-panel's own
 * `apiFetch` retries 502/503/504 three times, and a billing NATS timeout is
 * mapped to 502 — so a refund whose reply was lost arrived at billing again as
 * a brand-new request, and nothing on the consumer side could tell.
 *
 * The sharpest case is a refund. `RefundPaymentHandler` derives its Stripe
 * idempotency key from STATE:
 *
 *     `refund:${payment.id}:${alreadyRefunded}:${thisRefund}`
 *
 * so the retry of a refund that already committed carries a DIFFERENT key —
 * `refund:p1:0:5000` the first time, `refund:p1:5000:5000` the second — and
 * Stripe issues a second real refund. The handler's own double-refund guard
 * does not catch it: 50 + 50 <= 100 passes.
 */
import { BypassRlsService } from '@aquaculture/backend-common/database';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import type {
  BillingAdminCommandResult,
  BillingAdminRefundPaymentCommand,
} from '@platform/event-contracts';
import { DataSource } from 'typeorm';
import { firstValueFrom, of } from 'rxjs';

import { BillingAdminNatsHandler } from '../../handlers/billing-admin-nats.handler';
import { BillingCommandReceiptService } from '../../services/billing-command-receipt.service';
import {
  BillingCommandReceiptInterceptor,
  NON_MUTATING_BILLING_COMMAND,
  OWNS_BILLING_COMMAND_RECEIPT,
} from '../billing-command-receipt.interceptor';

const TENANT = '22222222-2222-4222-8222-222222222222';
const PAYMENT_ID = '33333333-3333-4333-8333-333333333333';
const ACTOR = '44444444-4444-4444-8444-444444444444';

interface StoredReceipt {
  id: string;
  tenantId: string | null;
  commandType: string;
  idempotencyKey: string;
  payloadHash: string;
  status: 'STARTED' | 'SUCCEEDED' | 'FAILED';
  resultSummary: BillingAdminCommandResult | null;
  correlationId: string | null;
}

/**
 * An in-memory `billing.command_receipts` that honours the table's real key:
 * one live row per (tenantId, commandType, idempotencyKey).
 */
function receiptTable(): { rows: StoredReceipt[]; query: jest.Mock } {
  const rows: StoredReceipt[] = [];
  let seq = 0;

  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (/INSERT INTO billing\.command_receipts/i.test(sql)) {
      const [tenantId, commandType, idempotencyKey, payloadHash, , correlationId] = params;
      const clash = rows.find(
        (r) =>
          r.tenantId === tenantId &&
          r.commandType === commandType &&
          r.idempotencyKey === idempotencyKey,
      );
      if (clash) return [];
      const row: StoredReceipt = {
        id: `receipt-${++seq}`,
        tenantId: tenantId as string | null,
        commandType: String(commandType),
        idempotencyKey: String(idempotencyKey),
        payloadHash: String(payloadHash),
        status: 'STARTED',
        resultSummary: null,
        correlationId: (correlationId as string | null) ?? null,
      };
      rows.push(row);
      return [{ id: row.id }];
    }
    if (/SELECT[\s\S]*FROM billing\.command_receipts/i.test(sql)) {
      const [tenantId, commandType, idempotencyKey] = params;
      const found = rows.find(
        (r) =>
          r.tenantId === tenantId &&
          r.commandType === commandType &&
          r.idempotencyKey === idempotencyKey,
      );
      return found ? [found] : [];
    }
    if (/UPDATE billing\.command_receipts/i.test(sql)) {
      const row = rows.find((r) => r.id === params[0]);
      if (!row) return [];
      if (/SET status = 'SUCCEEDED'/.test(sql)) {
        row.status = 'SUCCEEDED';
        row.resultSummary = JSON.parse(String(params[2])) as BillingAdminCommandResult;
        return [];
      }
      if (/SET status = 'FAILED'/.test(sql)) {
        row.status = 'FAILED';
        return [];
      }
      if (/SET status = 'STARTED'/.test(sql)) {
        if (row.status !== 'FAILED') return [];
        row.status = 'STARTED';
        row.resultSummary = null;
        return [{ id: row.id }];
      }
    }
    return [];
  });

  return { rows, query };
}

function build(): {
  interceptor: BillingCommandReceiptInterceptor;
  rows: StoredReceipt[];
} {
  const { rows, query } = receiptTable();
  // A real (never connected) DataSource, so the receipt service is exercised
  // through the type it actually depends on rather than a shape cast into it.
  const dataSource = new DataSource({ type: 'postgres', entities: [] });
  jest
    .spyOn(dataSource, 'query')
    .mockImplementation((sql: string, params?: unknown[]) => query(sql, params ?? []));
  return {
    interceptor: new BillingCommandReceiptInterceptor(
      new BillingCommandReceiptService(dataSource),
      // The real bypass: it enters an AsyncLocalStorage frame and runs the
      // callback, which is exactly what the interceptor relies on.
      new BypassRlsService(),
      new Reflector(),
    ),
    rows,
  };
}

/**
 * One named function per command name, reused across calls so a test can put
 * marker metadata on the very function `context.getHandler()` returns — the
 * same target `@NonMutatingBillingCommand()` writes to.
 */
const commandHandlers = new Map<string, () => void>();
function handlerFor(name: string): () => void {
  const existing = commandHandlers.get(name);
  if (existing) return existing;
  const created = { [name]: (): undefined => undefined }[name]!;
  commandHandlers.set(name, created);
  return created;
}

/** A real Nest RPC execution context over the command payload. */
function contextFor(name: string, command: unknown): ExecutionContext {
  const context = new ExecutionContextHost([command], BillingAdminNatsHandler, handlerFor(name));
  context.setType('rpc');
  return context;
}

function callHandler(work: jest.Mock): CallHandler {
  return { handle: () => of(work()) };
}

function refundCommand(amount = 50): BillingAdminRefundPaymentCommand {
  return {
    actorId: ACTOR,
    idempotencyKey: 'operator-request-1:refund-payment:p1',
    correlationId: 'corr-1',
    input: { paymentId: PAYMENT_ID, amount, reason: 'Customer request' },
  };
}

const refundReply: BillingAdminCommandResult = {
  success: true,
  ...({ payment: { id: PAYMENT_ID, tenantId: TENANT, status: 'partially_refunded' } } as object),
};

describe('BillingCommandReceiptInterceptor (ADR-0014)', () => {
  it('runs the work ONCE when the same command arrives twice, and replays the first reply', async () => {
    const { interceptor } = build();
    const work = jest.fn().mockReturnValue(refundReply);
    const command = refundCommand();

    const first = await firstValueFrom(
      interceptor.intercept(contextFor('refundPayment', command), callHandler(work)),
    );
    const second = await firstValueFrom(
      interceptor.intercept(contextFor('refundPayment', command), callHandler(work)),
    );

    // RefundPaymentHandler derives its Stripe key from the already-refunded
    // total, so a second execution issues a second REAL refund.
    expect(work).toHaveBeenCalledTimes(1);
    expect(first).toEqual(refundReply);
    expect(second).toEqual(refundReply);
  });

  it('refuses the same idempotency key carrying a different payload', async () => {
    const { interceptor } = build();
    const work = jest.fn().mockReturnValue(refundReply);

    await firstValueFrom(
      interceptor.intercept(contextFor('refundPayment', refundCommand(50)), callHandler(work)),
    );
    const conflicting = await firstValueFrom(
      interceptor.intercept(contextFor('refundPayment', refundCommand(500)), callHandler(work)),
    );

    // Answering with the FIRST refund's result would be a lie about what happened.
    expect(work).toHaveBeenCalledTimes(1);
    expect(conflicting).toMatchObject({ success: false, errorCode: 'CONFLICT' });
  });

  it('lets a retry RE-EXECUTE after a refusal, so a transient error is not cached for ever', async () => {
    const { interceptor } = build();
    const work = jest
      .fn()
      .mockReturnValueOnce({
        success: false,
        errorCode: 'INTERNAL_ERROR',
        error: 'stripe unreachable',
      })
      .mockReturnValueOnce(refundReply);
    const command = refundCommand();

    const failed = await firstValueFrom(
      interceptor.intercept(contextFor('refundPayment', command), callHandler(work)),
    );
    const retried = await firstValueFrom(
      interceptor.intercept(contextFor('refundPayment', command), callHandler(work)),
    );

    expect(failed).toMatchObject({ success: false });
    expect(retried).toEqual(refundReply);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('refuses while a receipt is still STARTED, because the outcome is unknown', async () => {
    const { interceptor, rows } = build();
    const work = jest.fn().mockReturnValue(refundReply);
    const command = refundCommand();

    await firstValueFrom(
      interceptor.intercept(contextFor('refundPayment', command), callHandler(work)),
    );
    // Simulate the process dying between the work committing and the receipt
    // being settled.
    rows[0]!.status = 'STARTED';

    const blocked = await firstValueFrom(
      interceptor.intercept(contextFor('refundPayment', command), callHandler(work)),
    );

    expect(work).toHaveBeenCalledTimes(1);
    expect(blocked).toMatchObject({ success: false, errorCode: 'CONFLICT' });
  });

  it('keys the receipt on the command NAME, so two commands under one request key stay apart', async () => {
    const { interceptor, rows } = build();
    const work = jest.fn().mockReturnValue({ success: true });
    const meta = { actorId: ACTOR, idempotencyKey: 'request-1', correlationId: 'corr-1' };

    await firstValueFrom(
      interceptor.intercept(
        contextFor('cancelSubscription', { ...meta, tenantId: TENANT }),
        callHandler(work),
      ),
    );
    await firstValueFrom(
      interceptor.intercept(
        contextFor('extendSubscriptionTrial', { ...meta, tenantId: TENANT, additionalDays: 14 }),
        callHandler(work),
      ),
    );

    expect(work).toHaveBeenCalledTimes(2);
    expect(rows.map((r) => r.commandType)).toEqual([
      'cancelSubscription',
      'extendSubscriptionTrial',
    ]);
    expect(rows.every((r) => r.tenantId === TENANT)).toBe(true);
  });

  it('refuses a command that arrives without the ADR-0014 meta instead of executing it', async () => {
    const { interceptor } = build();
    const work = jest.fn().mockReturnValue({ success: true });

    const refused = await firstValueFrom(
      interceptor.intercept(
        contextFor('cancelSubscription', { actorId: ACTOR, tenantId: TENANT }),
        callHandler(work),
      ),
    );

    expect(work).not.toHaveBeenCalled();
    expect(refused).toMatchObject({ success: false, errorCode: 'VALIDATION_ERROR' });
  });

  it('does not receipt a non-mutating command — a quote asked twice must recompute', async () => {
    const { interceptor, rows } = build();
    Reflect.defineMetadata(NON_MUTATING_BILLING_COMMAND, true, handlerFor('quoteModuleSelection'));
    const work = jest.fn().mockReturnValue({ success: true, quote: { total: '10' } });
    const command = { actorId: ACTOR, idempotencyKey: 'k', correlationId: 'c' };

    await firstValueFrom(
      interceptor.intercept(contextFor('quoteModuleSelection', command), callHandler(work)),
    );
    await firstValueFrom(
      interceptor.intercept(contextFor('quoteModuleSelection', command), callHandler(work)),
    );

    expect(work).toHaveBeenCalledTimes(2);
    expect(rows).toHaveLength(0);
  });

  it('leaves a command that writes its own atomic receipt alone', async () => {
    const { interceptor, rows } = build();
    Reflect.defineMetadata(
      OWNS_BILLING_COMMAND_RECEIPT,
      true,
      handlerFor('provisionTenantSubscription'),
    );
    const work = jest.fn().mockReturnValue({ success: true });

    await firstValueFrom(
      interceptor.intercept(
        contextFor('provisionTenantSubscription', {
          actorId: ACTOR,
          idempotencyKey: 'k',
          correlationId: 'c',
          tenantId: TENANT,
        }),
        callHandler(work),
      ),
    );

    expect(work).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(0);
  });
});
