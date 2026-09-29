import type { AiPersonaTier } from '@aquaculture/shared-contracts';

import type { ActuationPolicy, ToolExecutionContext } from '../tools/core/tool.interface';
import { TenantBinding } from './tenant-binding';

/**
 * The ONLY place a tool execution context is built, and therefore the only
 * place a {@link TenantBinding} is minted (K10 / PR-T1, MT-HIGH-062;
 * tests/invariants/ai-tenant-boundary.spec.ts allows `fromTrustedRequest` in
 * this file alone).
 *
 * WHY one factory with one function per trusted entry point: each entry point
 * receives its tenant from a different trusted source, and each builds a
 * differently-authorized context. Keeping all three here means the tenant is
 * always taken from the entry point's validated request, and plan PR-A1a can
 * turn the result into a human | service union in one file.
 *
 * INVARIANT: no parameter here comes from model output; if violated → the
 * model could choose the tenant its tools read.
 */

/** A human chat turn (request.ai.chat — gateway JWT or messaging bridge). */
export interface HumanTurnContextInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly userRoles: string[];
  readonly correlationId: string;
  readonly persona: string;
  readonly personaTier: AiPersonaTier | null;
  readonly offeredToolNames: readonly string[];
  readonly actuationPolicy: ActuationPolicy;
}

export function buildHumanTurnContext(input: HumanTurnContextInput): ToolExecutionContext {
  return {
    tenant: TenantBinding.fromTrustedRequest(input.tenantId),
    userId: input.userId,
    userRoles: input.userRoles,
    correlationId: input.correlationId,
    persona: input.persona,
    personaTier: input.personaTier,
    offeredToolNames: input.offeredToolNames,
    actuationPolicy: input.actuationPolicy,
  };
}

/**
 * A human-confirmed proposal (request.ai.executeAction — messaging after its
 * membership check). Runs the STORED tool as the ORIGINAL requester; the
 * confirmation is the authorization the confirm_required policy waited for.
 */
export interface ConfirmedProposalContextInput {
  readonly tenantId: string;
  readonly requestedBy: string;
  readonly requesterRoles: string[];
  readonly correlationId: string;
  readonly persona: string;
  readonly personaTier: AiPersonaTier;
  readonly toolName: string;
}

export function buildConfirmedProposalContext(
  input: ConfirmedProposalContextInput,
): ToolExecutionContext {
  return {
    tenant: TenantBinding.fromTrustedRequest(input.tenantId),
    userId: input.requestedBy,
    userRoles: input.requesterRoles,
    correlationId: input.correlationId,
    persona: input.persona,
    personaTier: input.personaTier,
    // RBAC-MEDIUM-016: the stored row itself is the grant; nothing else may run under it.
    offeredToolNames: [input.toolName],
    actuationPolicy: 'allowed',
  };
}

/**
 * A trusted platform service driving read-only tools (e.g.
 * request.ai.sensor.detectChannels from sensor-service, mTLS CN identity).
 * No persona, no user RBAC; the grant list is the sole authority and the
 * executor refuses actuation for service principals.
 */
export interface ServicePrincipalContextInput {
  readonly tenantId: string;
  readonly serviceName: string;
  readonly grantedToolNames: string[];
  readonly correlationId: string;
}

export function buildServicePrincipalContext(
  input: ServicePrincipalContextInput,
): ToolExecutionContext {
  return {
    tenant: TenantBinding.fromTrustedRequest(input.tenantId),
    // A service identity, deliberately NOT a user UUID.
    userId: `service:${input.serviceName}`,
    userRoles: [],
    correlationId: input.correlationId,
    persona: 'service',
    personaTier: null,
    offeredToolNames: [],
    // Fail-closed: a service principal never actuates.
    actuationPolicy: 'blocked',
    servicePrincipal: { name: input.serviceName, grantedToolNames: input.grantedToolNames },
  };
}
