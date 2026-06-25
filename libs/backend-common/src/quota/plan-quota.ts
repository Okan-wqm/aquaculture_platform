import { ForbiddenException } from '@nestjs/common';

/**
 * Thrown when creating a resource would exceed the tenant's plan allowance.
 *
 * Extends ForbiddenException (HTTP 403) — the request is well-formed and
 * authenticated, but the tenant's subscription does not permit one more of this
 * resource. The structured payload lets clients render an "upgrade your plan"
 * prompt with the exact resource, limit and current count.
 */
export class PlanLimitExceededError extends ForbiddenException {
  constructor(
    public readonly resource: string,
    public readonly limit: number,
    public readonly current: number,
  ) {
    super({
      statusCode: 403,
      error: 'Forbidden',
      errorCode: 'BILLING_PLAN_LIMIT_EXCEEDED',
      resource,
      limit,
      current,
      message: `Plan limit reached for ${resource} (${limit}). Upgrade your plan to add more.`,
    });
  }
}

/**
 * Fail-closed plan-quota guard. Call BEFORE inserting a metered resource.
 *
 * `limit` is the canonical per-plan allowance from `resolvePlanLimits(plan)`
 * (PLAN_CATALOG SSoT). `current` is the tenant's existing count of that
 * resource. A limit of `-1` means unlimited and is always allowed. Otherwise a
 * create is rejected once `current >= limit` (so a tenant at exactly the limit
 * cannot add one more).
 *
 * Callers that have NO plan ordinal (platform SUPER_ADMIN tokens carry none)
 * must skip this check entirely rather than pass a default plan — see
 * `tenantPlanFromLevel` in @platform/event-contracts.
 */
export function assertWithinQuota(
  resource: string,
  current: number,
  limit: number,
): void {
  if (limit === -1) {
    return;
  }
  if (current >= limit) {
    throw new PlanLimitExceededError(resource, limit, current);
  }
}
