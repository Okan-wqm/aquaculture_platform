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
import { applyDecorators, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { ApiPropertyOptional, ApiQuery } from '@nestjs/swagger';
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
): ParameterDecorator => {
  const key = options.key ?? 'tenantId';
  const optional = options.optional ?? false;
  const extractAndVerify = RawTenantParam(
    { source, key, optional, allow: options.allow },
    VerifiedTenantPipe,
  );

  // A `param`-sourced id is already in the contract: the route path carries
  // `:tenantId`, and the swagger plugin derives a path parameter from the
  // template. A `body`-sourced one is declared by {@link TenantIdCarrier} on
  // the DTO. A QUERY-sourced one was in neither.
  if (source !== 'query') return extractAndVerify;

  /**
   * ADMIN-HIGH-149: contribute the query parameter to the OpenAPI document.
   *
   * The `@nestjs/swagger` plugin reads `@Query()` and nothing else, so every
   * `@TenantParam('query')` route documented NO tenant parameter — while
   * `VerifiedTenantPipe` rejected any request that omitted it with
   * `BadRequestException('tenantId is required')`. A generated client had no
   * way to know the one parameter it had to send, and the admin panel proved
   * the consequence twice: `MessagingCompliancePage` (ADMIN-CRITICAL-147) and
   * `MessagingAuditPage` (ADMIN-CRITICAL-150) each shipped calls that could
   * only ever 400, and each rendered a placeholder in place of the answer.
   *
   * Declaring it here rather than at the call sites is the point: it holds for
   * all 132 of them and for every route added after this.
   *
   * A parameter decorator cannot be composed with a method decorator through
   * `applyDecorators`, so `ApiQuery` is applied to the owning method directly
   * — the documented way to have a parameter decorator contribute route-level
   * metadata.
   */
  return (target: object, propertyKey: string | symbol | undefined, parameterIndex: number) => {
    extractAndVerify(target, propertyKey, parameterIndex);
    if (propertyKey === undefined) return;
    const descriptor = Object.getOwnPropertyDescriptor(target, propertyKey);
    if (!descriptor) return;
    ApiQuery({
      name: key,
      required: !optional,
      type: String,
      format: 'uuid',
      description:
        'Tenant id. Resolved and verified against `auth.tenants` before the handler runs' +
        (optional ? '; omit to act across tenants.' : '; the request is refused without it.'),
    })(target, propertyKey, descriptor);
  };
};

/**
 * Whitelists the body key `@TenantParam('body')` reads, without making it
 * readable: declare the property as `readonly tenantId?: undefined`.
 *
 * The TypeScript type is `undefined` so a handler cannot use the client's
 * value, but the WIRE contract does carry a tenant id, so the property is also
 * described to OpenAPI as an optional uuid string (CONTRACT-CRITICAL-003).
 * Without that the generated document would either omit the key a client must
 * send, or fail generation on the `undefined` type.
 */
export const TenantIdCarrier = (): PropertyDecorator =>
  applyDecorators(
    Allow(),
    ApiPropertyOptional({
      type: String,
      format: 'uuid',
      description:
        'Tenant id. Resolved and verified server-side before the handler runs; the value a handler uses never comes from this key.',
    }),
  );
