/**
 * VerifiedTenantPipe — the one place a client-supplied tenant id becomes a
 * verified tenant identity (ADMIN-CRITICAL-009).
 *
 * `@TenantParam(...)` extracts the raw value from the route param, query
 * string or body and hands it here together with the request method and the
 * route's stated tolerance. The pipe:
 *   - rejects a missing value unless the route said `optional` (then `undefined`);
 *   - rejects anything that is not a UUID;
 *   - resolves the id through the platform's `TENANT_ACTIVE_CHECK` port
 *     (`auth.tenants` is the SSoT, D14) and refuses an unknown tenant with 404;
 *   - refuses a tenant whose lifecycle status the route does not admit: a
 *     mutation admits ACTIVE only unless the route lists its statuses (a
 *     lifecycle route says `allow: 'any'`); a read admits every existing
 *     tenant, because operators must be able to look at a suspended one.
 *
 * The handler receives a plain id string it can trust — the resolution ran
 * before the handler, in the parameter pipeline, so there is no way to reach
 * the handler with an unverified tenant.
 */
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  type PipeTransform,
} from '@nestjs/common';
import { TenantStatus } from '@platform/event-contracts';

import {
  TENANT_ACTIVE_CHECK,
  type TenantActiveCheck,
} from '../middleware/effective-tenant.middleware';

export type TenantParamSource = 'param' | 'query' | 'body';

/** The lifecycle statuses a route admits. Default: ACTIVE for mutations, every status for reads. */
export type TenantParamAllow = readonly TenantStatus[] | 'any';

/** What `@TenantParam` hands to the pipe: the raw value plus the route's stated tolerance. */
export interface TenantParamRequest {
  readonly raw: unknown;
  readonly source: TenantParamSource;
  readonly key: string;
  readonly optional: boolean;
  readonly allow: TenantParamAllow | undefined;
  readonly method: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const TENANT_PARAM_MUTATION_DEFAULT_ALLOW: readonly TenantStatus[] = [TenantStatus.ACTIVE];

export function isTenantParamRequest(value: unknown): value is TenantParamRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    'raw' in value &&
    'source' in value &&
    'key' in value &&
    'optional' in value &&
    'method' in value
  );
}

@Injectable()
export class VerifiedTenantPipe
  implements PipeTransform<TenantParamRequest, Promise<string | undefined>>
{
  constructor(@Inject(TENANT_ACTIVE_CHECK) private readonly tenants: TenantActiveCheck) {}

  async transform(value: TenantParamRequest): Promise<string | undefined> {
    if (!isTenantParamRequest(value)) {
      throw new Error('VerifiedTenantPipe must be applied through @TenantParam()');
    }
    const raw = value.raw;
    if (raw === undefined || raw === null || raw === '') {
      if (value.optional) return undefined;
      throw new BadRequestException(`${value.key} is required`);
    }
    if (typeof raw !== 'string' || !UUID.test(raw)) {
      throw new BadRequestException(`${value.key} must be a tenant UUID`);
    }
    const tenant = await this.tenants.lookupTenant(raw);
    if (!tenant) {
      throw new NotFoundException(`Tenant ${raw} not found`);
    }
    const allow =
      value.allow ??
      (READ_METHODS.has(value.method.toUpperCase()) ? 'any' : TENANT_PARAM_MUTATION_DEFAULT_ALLOW);
    if (allow !== 'any' && !allow.includes(tenant.status)) {
      throw new ConflictException(
        `Tenant ${raw} is ${tenant.status}; this operation requires ${allow.join(' or ')}`,
      );
    }
    return raw;
  }
}
