/**
 * `@TenantParam(source, options?)` — a handler receives a VERIFIED tenant id,
 * never a transport value (ADMIN-CRITICAL-009).
 *
 *   @Get(':tenantId/invoices')
 *   list(@TenantParam('param') tenantId: string) {}          // any existing tenant (read)
 *
 *   @Post(':tenantId/invoices')
 *   create(@TenantParam('param') tenantId: string) {}        // ACTIVE tenants only (mutation)
 *
 *   @Patch(':id/activate')
 *   activate(@TenantParam('param', { key: 'id', allow: 'any' }) id: string) {}
 *
 *   @Get()
 *   search(@TenantParam('query', { optional: true }) tenantId?: string) {}
 *
 * A BODY-sourced tenant id still has to be whitelisted for the platform's
 * `forbidNonWhitelisted` ValidationPipe, so the DTO declares the carrier key
 * with {@link TenantIdCarrier} and the type `undefined`:
 *
 *   class CreateTicketDto { @TenantIdCarrier() readonly tenantId?: undefined; ... }
 *
 * The body passes validation, but `dto.tenantId` is typed `undefined` — it
 * cannot be passed where a tenant id is expected, and `as string` on it is a
 * compile error. The verified value arrives only through @TenantParam('body').
 *
 * The decorator only extracts; {@link VerifiedTenantPipe} resolves the id
 * against `auth.tenants` and applies the route's tolerance. The pipe is
 * attached here, so a handler cannot take a tenant id through this decorator
 * without the verification — and the platform's lint rule
 * (`no-unverified-tenant-param`) refuses the raw `@Param('tenantId')` /
 * `@Query('tenantId')` / DTO `tenantId` alternatives on the admin surface.
 */
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { Allow } from 'class-validator';

import {
  VerifiedTenantPipe,
  type TenantParamAllow,
  type TenantParamRequest,
  type TenantParamSource,
} from '../tenant/verified-tenant.pipe';

export interface TenantParamOptions {
  /** The param / query / body key holding the tenant id. Default `tenantId`. */
  readonly key?: string;
  /** Resolve to `undefined` when the value is absent instead of rejecting. Default false. */
  readonly optional?: boolean;
  /**
   * Lifecycle statuses the route admits. Default: ACTIVE for a mutation,
   * every status for a read. Lifecycle routes (suspend, activate, erase,
   * provisioning) state `'any'` or the exact statuses they act on.
   */
  readonly allow?: TenantParamAllow;
}

interface TenantParamSpec {
  readonly source: TenantParamSource;
  readonly key: string;
  readonly optional: boolean;
  readonly allow: TenantParamAllow | undefined;
}

interface HttpRequestLike {
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
}

function extract(request: HttpRequestLike, spec: TenantParamSpec): unknown {
  if (spec.source === 'param') return request.params?.[spec.key];
  if (spec.source === 'query') return request.query?.[spec.key];
  const body = request.body;
  if (typeof body !== 'object' || body === null) return undefined;
  return (body as Record<string, unknown>)[spec.key];
}

const RawTenantParam = createParamDecorator(
  (spec: TenantParamSpec, ctx: ExecutionContext): TenantParamRequest => {
    const request = ctx.switchToHttp().getRequest<HttpRequestLike>();
    return {
      raw: extract(request, spec),
      source: spec.source,
      key: spec.key,
      optional: spec.optional,
      allow: spec.allow,
      method: request.method ?? 'GET',
    };
  },
);

export const TenantParam = (
  source: TenantParamSource,
  options: TenantParamOptions = {},
): ParameterDecorator =>
  RawTenantParam(
    {
      source,
      key: options.key ?? 'tenantId',
      optional: options.optional ?? false,
      allow: options.allow,
    },
    VerifiedTenantPipe,
  );

/**
 * Whitelists the body key `@TenantParam('body')` reads, without making it
 * readable: declare the property as `readonly tenantId?: undefined`.
 */
export const TenantIdCarrier = (): PropertyDecorator => Allow();
