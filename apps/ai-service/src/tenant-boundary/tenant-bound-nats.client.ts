import { Inject, Injectable } from '@nestjs/common';
import type { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { verifyTenantBoundReply, type TenantBoundReplyError } from '@platform/event-contracts';

import type { TenantBoundToolContext } from '../tools/core/tool.interface';
import { TenantBinding } from './tenant-binding';
import { TenantBoundaryViolation } from './tenant-boundary-violation';
import { TenantBoundaryViolationReporter } from './tenant-boundary-violation.reporter';
import { findTenantScopedKeys } from './tenant-scoped-keys';

/**
 * DI token of the raw NATS transport. Registered only by TenantBoundaryModule
 * and injected only here: tool code has no way to name it
 * (tests/invariants/ai-tenant-boundary.spec.ts).
 */
export const AI_TENANT_BOUND_TRANSPORT = Symbol('AI_TENANT_BOUND_TRANSPORT');

/** Model-facing text for a same-tenant failure — says what to do, never what another tenant holds. */
const FAILURE_TEXT: Readonly<Record<TenantBoundReplyError, string>> = {
  INVALID_REQUEST: 'The data request was rejected as invalid; check the ids and dates you passed.',
  NOT_FOUND:
    'No record with that id exists in this farm; ask the user to confirm it or list the records first.',
  INTERNAL_ERROR: 'The data is temporarily unavailable; say so instead of estimating.',
};

/**
 * Request fields a tool may supply: anything EXCEPT the tenant. The constraint
 * makes `{ tenantId }` (or a full `XRequest` that carries one) a compile error;
 * the client also refuses any tenant/schema key at runtime, so a cast cannot
 * smuggle one through.
 */
export type TenantFreeFields = object & { readonly tenantId?: never };

/** One tenant-bound request. */
export interface TenantBoundCall<TFields extends TenantFreeFields, TData> {
  readonly subject: string;
  readonly fields: TFields;
  readonly isData: (value: unknown) => value is TData;
  readonly timeoutMs: number;
}

/**
 * The ONLY way AI tool code reaches another service (K10 / PR-T1, MT-HIGH-062).
 *
 * WHAT it guarantees, in order:
 *   1. the context's binding is genuine (not a structural copy);
 *   2. the request's tenant is the binding's tenant — the client writes it,
 *      the tool cannot (type + runtime key check);
 *   3. the reply names the tenant it served (tenant-bound envelope) and that
 *      tenant equals the binding's, checked by `verifyTenantBoundReply`
 *      BEFORE the data is looked at. A mismatch — or a reply that names no
 *      tenant at all — is reported (security event + PII-free log) and thrown
 *      as TenantBoundaryViolation, which ends the run: the data never reaches
 *      the model, the tool result, or toolCalls.
 *
 * Same-tenant failures (INVALID_REQUEST / NOT_FOUND / INTERNAL_ERROR, bad
 * shapes) are ordinary errors: BaseTool turns them into a tool error the model
 * can act on.
 */
@Injectable()
export class TenantBoundNatsClient {
  /**
   * The raw transport, held in an ES private field (V-T1a-3): a TypeScript
   * `private` is erased at runtime, so `client['transport'].send(...)` would
   * reach it and skip the tenant check. `#transport` is not reachable from
   * outside this class by any property access.
   */
  readonly #transport: Pick<ClientProxy, 'send'>;

  constructor(
    @Inject(AI_TENANT_BOUND_TRANSPORT) transport: Pick<ClientProxy, 'send'>,
    private readonly violations: TenantBoundaryViolationReporter,
  ) {
    this.#transport = transport;
  }

  async request<TFields extends TenantFreeFields, TData>(
    ctx: TenantBoundToolContext,
    call: TenantBoundCall<TFields, TData>,
  ): Promise<TData> {
    if (!TenantBinding.isGenuine(ctx.tenant)) {
      throw new TenantBoundaryViolation(call.subject, 'forged_binding');
    }
    const tenantId = ctx.tenant.tenantId;
    if (findTenantScopedKeys(call.fields).length > 0) {
      const violation = new TenantBoundaryViolation(call.subject, 'tenant_field_in_request');
      await this.report(violation, tenantId, null, ctx.correlationId);
      throw violation;
    }

    const reply: unknown = await firstValueFrom(
      this.#transport
        .send<unknown>(call.subject, { ...call.fields, tenantId })
        .pipe(timeout(call.timeoutMs)),
    );

    const verdict = verifyTenantBoundReply(reply, tenantId, call.isData);
    switch (verdict.kind) {
      case 'data':
        return verdict.data;
      case 'tenant_mismatch': {
        const violation = new TenantBoundaryViolation(call.subject, 'reply_tenant_mismatch');
        await this.report(violation, tenantId, verdict.servedTenantId, ctx.correlationId);
        throw violation;
      }
      case 'error':
        throw new Error(FAILURE_TEXT[verdict.error]);
      case 'malformed': {
        if (verdict.reason === 'contract') {
          // The reply named OUR tenant; only its data shape is wrong — an ordinary tool error.
          throw new Error(`${call.subject} reply failed the contract guard`);
        }
        // A reply that names no tenant cannot prove whose rows it carries: it is a
        // boundary violation, not a flaky reply — recorded and the run stopped.
        const violation = new TenantBoundaryViolation(call.subject, 'reply_without_tenant');
        await this.report(violation, tenantId, null, ctx.correlationId);
        throw violation;
      }
    }
  }

  private async report(
    violation: TenantBoundaryViolation,
    expectedTenantId: string,
    servedTenantId: string | null,
    correlationId: string,
  ): Promise<void> {
    await this.violations.report({ violation, expectedTenantId, servedTenantId, correlationId });
  }
}
