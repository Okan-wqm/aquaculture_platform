import { Injectable, Logger } from '@nestjs/common';
import {
  respondTenantBound,
  type TenantBoundResponderDeps,
  type TenantBoundSubject,
} from '@aquaculture/backend-common/nats';
import type { TenantBoundReply, TenantBoundRequest } from '@platform/event-contracts';

import { FARM_AI_OWNERS } from './farm-ai-owners';
import { FarmTenantScopes } from './farm-tenant-scopes';

/**
 * farm-service's responder skeleton for every AI-facing request subject
 * (K10 / PR-T1, MT-HIGH-062).
 *
 * WHAT: `respondTenantBound` wired to farm's tenant boundary and owner
 * registry. A responder hands it the subject's guard and handler; the handler
 * receives the tenant-free request and the `TenantScope`, which is the only
 * data handle it gets. Responders inject this class and the query bus —
 * never a DataSource or FarmTenantScopes.
 */
@Injectable()
export class FarmAiResponder {
  private readonly deps: TenantBoundResponderDeps;

  constructor(scopes: FarmTenantScopes) {
    this.deps = {
      logger: new Logger(FarmAiResponder.name),
      owners: FARM_AI_OWNERS,
      openScope: (tenantId, access, fn) =>
        access === 'write' ? scopes.write(tenantId, fn) : scopes.read(tenantId, fn),
    };
  }

  respond<TRequest extends TenantBoundRequest, TData>(
    spec: TenantBoundSubject<TRequest, TData>,
    payload: unknown,
  ): Promise<TenantBoundReply<TData>> {
    return respondTenantBound(this.deps, spec, payload);
  }
}
