import type { ClientProxy } from '@nestjs/microservices';
import { SecurityEventService } from '@aquaculture/backend-common/security';
import type { TenantBoundReplyError } from '@platform/event-contracts';

import type { ToolExecutionContext } from '../../../tools/core/tool.interface';
import { TenantBoundNatsClient } from '../../tenant-bound-nats.client';
import { TenantBoundaryViolationReporter } from '../../tenant-boundary-violation.reporter';
import { buildHumanTurnContext, type HumanTurnContextInput } from '../../tool-context.factory';

/**
 * Test fixtures for the AI tenant boundary (K10 / MT-HIGH-062). Specs build
 * contexts through the SAME factory production uses, so a test cannot hold a
 * context whose tenant was not minted from a (test) trusted request.
 */

/** The tenant a test execution is bound to. */
export const TENANT_A = '11111111-1111-4111-8111-111111111111';
/** Another tenant — its data must never reach a TENANT_A execution. */
export const TENANT_B = '99999999-9999-4999-8999-999999999999';

/** A human-turn tool context bound to TENANT_A unless overridden. */
export function humanToolContext(
  overrides: Partial<HumanTurnContextInput> = {},
): ToolExecutionContext {
  return buildHumanTurnContext({
    tenantId: TENANT_A,
    userId: 'u-1',
    userRoles: ['MODULE_USER'],
    correlationId: 'corr-1',
    persona: 'operator-v1',
    personaTier: 'operator',
    offeredToolNames: [],
    actuationPolicy: 'confirm_required',
    ...overrides,
  });
}

/** A violation reporter wired to a bus-less SecurityEventService (publishing is a no-op). */
export function silentViolationReporter(): TenantBoundaryViolationReporter {
  return new TenantBoundaryViolationReporter(new SecurityEventService());
}

/** The real TenantBoundNatsClient over a test transport (`{ send }` double). */
export function tenantBoundClient(
  transport: Pick<ClientProxy, 'send'>,
  reporter: TenantBoundaryViolationReporter = silentViolationReporter(),
): TenantBoundNatsClient {
  return new TenantBoundNatsClient(transport, reporter);
}

/** A tenant-bound ok reply, served for TENANT_A unless another tenant is named. */
export function boundReply<T>(
  data: T,
  tenantId: string = TENANT_A,
): { ok: true; tenantId: string; data: T } {
  return { ok: true, tenantId, data };
}

/** A tenant-bound failure reply, served for TENANT_A unless another tenant is named. */
export function boundFailure(
  error: TenantBoundReplyError,
  tenantId: string = TENANT_A,
): { ok: false; tenantId: string; error: TenantBoundReplyError } {
  return { ok: false, tenantId, error };
}
