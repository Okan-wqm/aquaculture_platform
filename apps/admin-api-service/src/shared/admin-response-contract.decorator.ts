import {
  isExecutableAdminResponseContract,
  isExecutableAdminManualResponseProfile,
  type AdminManualResponseProfile,
  type AdminResponseContract as ExecutableAdminResponseContract,
} from '@platform/admin-http-contracts';
import { SetMetadata } from '@nestjs/common';

const ADMIN_RESPONSE_CONTRACT_METADATA = Symbol('admin-response-contract');
const ADMIN_MANUAL_RESPONSE_METADATA = Symbol('admin-manual-response');
const ADMIN_QUERY_ENCODING_METADATA = Symbol('admin-query-encoding');
const ADMIN_ROUTE_LIFECYCLE_METADATA = Symbol('admin-route-lifecycle');

export const ADMIN_ROUTE_LIFECYCLES = Object.freeze(['ACTIVE', 'INTERNAL_GATEWAY_ONLY'] as const);

export type AdminRouteLifecycleV1 = (typeof ADMIN_ROUTE_LIFECYCLES)[number];

export type AdminQueryEncodingV1 = Readonly<Record<string, 'comma-separated' | 'repeated'>>;

/**
 * Binds a route to the executable projection that owns its public wire shape.
 * The same constant supplies the route's named TypeScript DTO and the runtime
 * allow-list used by the global response interceptor.
 */
export function AdminResponseContract<
  TContract extends ExecutableAdminResponseContract<unknown, unknown>,
>(contract: TContract): MethodDecorator {
  return SetMetadata(ADMIN_RESPONSE_CONTRACT_METADATA, contract);
}

/**
 * Declares that a route deliberately owns a non-JSON-envelope transport.
 *
 * The reason vocabulary is closed so bypasses remain compiler-inventoried
 * exceptions rather than an ungoverned boolean escape hatch.
 */
export function AdminManualResponse(profile: AdminManualResponseProfile): MethodDecorator {
  if (!isExecutableAdminManualResponseProfile(profile)) {
    throw new TypeError('AdminManualResponse requires a sealed executable manual response profile');
  }
  return SetMetadata(ADMIN_MANUAL_RESPONSE_METADATA, profile);
}

/**
 * Declares non-scalar query wire codecs at the backend handler that consumes
 * them. The compiler requires exact field equality and emits the browser
 * encoder from this metadata, so array transport semantics cannot drift into
 * frontend helpers.
 */
export function AdminQueryEncoding(encoding: AdminQueryEncodingV1): MethodDecorator {
  const normalized: Record<string, 'comma-separated' | 'repeated'> = {};
  for (const [field, codec] of Object.entries(encoding)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
      throw new TypeError(`AdminQueryEncoding field ${field} is not a canonical identifier`);
    }
    if (codec !== 'comma-separated' && codec !== 'repeated') {
      throw new TypeError(`AdminQueryEncoding field ${field} has an unsupported codec`);
    }
    normalized[field] = codec;
  }
  return SetMetadata(ADMIN_QUERY_ENCODING_METADATA, Object.freeze(normalized));
}

/** Closed route exposure coordinate consumed by codegen and the runtime guard. */
export function AdminRouteLifecycle(lifecycle: AdminRouteLifecycleV1): MethodDecorator {
  if (!(ADMIN_ROUTE_LIFECYCLES as readonly string[]).includes(lifecycle)) {
    throw new TypeError('AdminRouteLifecycle requires a closed lifecycle coordinate');
  }
  return SetMetadata(ADMIN_ROUTE_LIFECYCLE_METADATA, lifecycle);
}

function isExecutableContract(
  value: unknown,
): value is ExecutableAdminResponseContract<unknown, unknown> {
  return isExecutableAdminResponseContract(value);
}

export function responseContractFor(
  handler: object,
): ExecutableAdminResponseContract<unknown, unknown> | undefined {
  const candidate: unknown = Reflect.getMetadata(ADMIN_RESPONSE_CONTRACT_METADATA, handler);
  return isExecutableContract(candidate) ? candidate : undefined;
}

export function manualResponseProfileFor(handler: object): AdminManualResponseProfile | undefined {
  const candidate: unknown = Reflect.getMetadata(ADMIN_MANUAL_RESPONSE_METADATA, handler);
  return isExecutableAdminManualResponseProfile(candidate) ? candidate : undefined;
}

export function queryEncodingFor(handler: object): AdminQueryEncodingV1 {
  const candidate: unknown = Reflect.getMetadata(ADMIN_QUERY_ENCODING_METADATA, handler);
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return {};
  const output: Record<string, 'comma-separated' | 'repeated'> = {};
  for (const [field, codec] of Object.entries(candidate)) {
    if (codec !== 'comma-separated' && codec !== 'repeated') return {};
    output[field] = codec;
  }
  return Object.freeze(output);
}

export function routeLifecycleFor(handler: object): AdminRouteLifecycleV1 {
  const candidate: unknown = Reflect.getMetadata(ADMIN_ROUTE_LIFECYCLE_METADATA, handler);
  return (ADMIN_ROUTE_LIFECYCLES as readonly unknown[]).includes(candidate)
    ? (candidate as AdminRouteLifecycleV1)
    : 'ACTIVE';
}
