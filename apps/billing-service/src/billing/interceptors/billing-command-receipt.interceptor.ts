import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { BillingAdminCommandResult } from '@platform/event-contracts';
import { BypassRlsService } from '@aquaculture/backend-common/database';
import { Observable, firstValueFrom, from } from 'rxjs';

import {
  BillingCommandReceiptService,
  type BillingCommandIdentity,
} from '../services/billing-command-receipt.service';

/**
 * The command computes an answer and writes nothing, so a repeat must RECOMPUTE
 * (a quote asked twice after a price change must not return the stale figure).
 */
export const NON_MUTATING_BILLING_COMMAND = 'billing:non-mutating-command';
export const NonMutatingBillingCommand = (): MethodDecorator =>
  SetMetadata(NON_MUTATING_BILLING_COMMAND, true);

/**
 * The command writes its OWN receipt inside its own transaction — a stronger
 * guarantee than this interceptor can give, because the receipt commits
 * atomically with the work instead of just before and after it. Tenant
 * provisioning is the only such command.
 */
export const OWNS_BILLING_COMMAND_RECEIPT = 'billing:owns-command-receipt';
export const OwnsBillingCommandReceipt = (): MethodDecorator =>
  SetMetadata(OWNS_BILLING_COMMAND_RECEIPT, true);

/**
 * Makes every admin billing command at-most-once (ADR-0014).
 *
 * The alternative was a `runOnce(...)` call hand-written into all 32
 * `@MessagePattern` methods across five controllers — 32 chances to forget the
 * one line that stops a refund executing twice. Here the receipt is the
 * DEFAULT and skipping it costs an explicit, greppable decorator;
 * `tests/invariants/billing-command-contract-ssot.spec.ts` fails the build if a
 * controller carrying these subjects is not bound to this interceptor.
 *
 * The RLS bypass wraps the receipt writes AND the handler, because
 * `billing.command_receipts` is RLS-protected and a NATS command carries no
 * tenant GUC. `BypassRlsService` is re-entrant, so the handler's own
 * `runAsTrustedAdminBypass` nests without a second grant.
 */
@Injectable()
export class BillingCommandReceiptInterceptor implements NestInterceptor {
  constructor(
    private readonly receipts: BillingCommandReceiptService,
    private readonly bypassRls: BypassRlsService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'rpc') {
      return next.handle();
    }
    const handler = context.getHandler();
    if (
      this.reflector.get<boolean>(NON_MUTATING_BILLING_COMMAND, handler) === true ||
      this.reflector.get<boolean>(OWNS_BILLING_COMMAND_RECEIPT, handler) === true
    ) {
      return next.handle();
    }
    return from(this.runOnce(handler.name, context.switchToRpc().getData<unknown>(), next));
  }

  private async runOnce(
    commandType: string,
    command: unknown,
    next: CallHandler,
  ): Promise<BillingAdminCommandResult> {
    if (command === null || typeof command !== 'object') {
      return refuse(`${commandType} arrived with no command payload`);
    }
    const record = command as Record<string, unknown>;
    const idempotencyKey = text(record['idempotencyKey']);
    const correlationId = text(record['correlationId']);
    if (idempotencyKey === null || correlationId === null) {
      // The sender is the platform's own admin-api; a command without the meta
      // is a deployment skew, and executing it would be exactly the unguarded
      // write ADR-0014 removed.
      return refuse(
        `${commandType} arrived without idempotencyKey/correlationId. Every admin billing ` +
          'command must carry both (ADR-0014) so a retry can be told from a new request.',
      );
    }

    const identity: BillingCommandIdentity = {
      // Resource-addressed money commands (invoice/payment ids) carry no
      // tenantId; their key is composed from the resource id by the sender, so
      // it is unique without a tenant column to scope it.
      tenantId: text(record['tenantId']),
      commandType,
      idempotencyKey,
      actorId: text(record['actorId']),
      correlationId,
    };

    // Meta travels beside the operation and must not change its identity: the
    // same refund retried by a second operator is still that one refund.
    const {
      actorId: _actor,
      idempotencyKey: _key,
      correlationId: _correlation,
      ...payload
    } = record;

    return this.bypassRls.withBypass(`billing-admin-receipt:${commandType}`, () =>
      this.receipts.runOnce(identity, payload, async () =>
        asCommandResult(commandType, await firstValueFrom(next.handle())),
      ),
    );
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function refuse(error: string): BillingAdminCommandResult {
  return { success: false, errorCode: 'VALIDATION_ERROR', error };
}

/**
 * Every admin billing reply extends `BillingAdminCommandResult`, and the
 * receipt writer branches on `success`. A reply that does not have it cannot be
 * recorded honestly, so it raises rather than being filed as a success.
 */
function asCommandResult(commandType: string, value: unknown): BillingAdminCommandResult {
  if (
    value === null ||
    typeof value !== 'object' ||
    typeof (value as { success?: unknown }).success !== 'boolean'
  ) {
    throw new Error(
      `${commandType} replied without a boolean \`success\`; its receipt cannot record what happened`,
    );
  }
  return value as BillingAdminCommandResult;
}
