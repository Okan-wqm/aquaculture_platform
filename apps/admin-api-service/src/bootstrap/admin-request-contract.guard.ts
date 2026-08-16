import {
  BadRequestException,
  ForbiddenException,
  type CanActivate,
  type ExecutionContext,
  RequestMethod,
  ServiceUnavailableException,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  ADMIN_RESERVED_REQUEST_HEADER_NAMES,
  AdminHttpContractError,
  adminLogicalRoutePathFromMetadata,
  decodeAdminInboundRequestV1,
  isExecutableAdminRouteRequestContract,
  type AdminHttpMethod,
  type AdminRequestObjectContract,
  type AdminServerRequestContractCatalogV1,
} from '@platform/admin-http-contracts';

interface MutableAdminHttpRequest {
  readonly originalUrl?: unknown;
  params?: unknown;
  query?: unknown;
  headers?: unknown;
  body?: unknown;
  verifiedIdentity?: {
    readonly serviceName?: unknown;
    readonly audience?: unknown;
  };
}

type AdminRouteLifecycle = 'ACTIVE' | 'INTERNAL_GATEWAY_ONLY';

const ADMIN_METHOD_BY_NEST_REQUEST_METHOD: Readonly<Record<number, AdminHttpMethod | undefined>> =
  Object.freeze({
    [RequestMethod.GET]: 'GET',
    [RequestMethod.POST]: 'POST',
    [RequestMethod.PUT]: 'PUT',
    [RequestMethod.DELETE]: 'DELETE',
    [RequestMethod.PATCH]: 'PATCH',
    [RequestMethod.ALL]: 'ALL',
    [RequestMethod.OPTIONS]: 'OPTIONS',
    [RequestMethod.HEAD]: 'HEAD',
  });

export function adminRouteContractIdFromExecutionContext(context: ExecutionContext): string {
  const controller = context.getClass();
  const handler = context.getHandler();
  let path: string;
  try {
    path = adminLogicalRoutePathFromMetadata(
      Reflect.getMetadata(PATH_METADATA, controller),
      Reflect.getMetadata(PATH_METADATA, handler),
    );
  } catch {
    throw new ServiceUnavailableException('handler has non-canonical HTTP path metadata');
  }
  const nestMethod: unknown = Reflect.getMetadata(METHOD_METADATA, handler);
  if (typeof nestMethod !== 'number') {
    throw new ServiceUnavailableException('handler has no compile-time HTTP method metadata');
  }
  const method = ADMIN_METHOD_BY_NEST_REQUEST_METHOD[nestMethod];
  if (method === undefined) {
    throw new ServiceUnavailableException('handler uses an unsupported HTTP method metadata value');
  }
  return `${method} ${path}`;
}

function requestRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return Object.freeze(Object.create(null) as Record<string, unknown>);
  }
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, field] of Object.entries(value)) output[key.toLowerCase()] = field;
  return Object.freeze(output);
}

function declaredHeaderNames(contract: AdminRequestObjectContract): readonly string[] {
  return Object.freeze(Object.keys(contract.fields).sort());
}

function assertExactRouteHeaders(
  rawHeaders: Readonly<Record<string, unknown>>,
  routeHeaders: AdminRequestObjectContract,
): void {
  for (const header of Object.keys(rawHeaders)) {
    if (
      !ADMIN_RESERVED_REQUEST_HEADER_NAMES.has(header) &&
      !Object.prototype.hasOwnProperty.call(routeHeaders.fields, header)
    ) {
      throw new AdminHttpContractError(
        `$.request.headers.${header}`,
        'header is not declared by this route',
      );
    }
  }
}

function selectedRequestHeaders(
  rawHeaders: Readonly<Record<string, unknown>>,
  contract: AdminRequestObjectContract,
): Readonly<Record<string, unknown>> {
  const selected: Record<string, unknown> = Object.create(null);
  for (const header of declaredHeaderNames(contract)) {
    if (Object.prototype.hasOwnProperty.call(rawHeaders, header)) {
      selected[header] = rawHeaders[header];
    }
  }
  return Object.freeze(selected);
}

function canonicalTransportHeaders(
  rawHeaders: Readonly<Record<string, unknown>>,
  decodedHeaders: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const canonical: Record<string, unknown> = Object.create(null);
  for (const [header, value] of Object.entries(rawHeaders)) canonical[header] = value;
  for (const [header, value] of Object.entries(decodedHeaders)) canonical[header] = value;
  return Object.freeze(canonical);
}

function applyCanonicalRequest(
  request: MutableAdminHttpRequest,
  canonical: {
    readonly path: Readonly<Record<string, unknown>>;
    readonly query: Readonly<Record<string, unknown>>;
    readonly headers: Readonly<Record<string, unknown>>;
    readonly body?: unknown;
  },
): void {
  if (!Object.isExtensible(request)) {
    throw new ServiceUnavailableException('HTTP request object cannot accept canonical input');
  }
  Object.defineProperties(request, {
    params: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: canonical.path,
    },
    query: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: canonical.query,
    },
    headers: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: canonical.headers,
    },
    body: {
      configurable: true,
      enumerable: true,
      writable: true,
      value: canonical.body,
    },
  });
}

export function createAdminRequestContractGuard(
  catalog: AdminServerRequestContractCatalogV1,
  lifecycleCatalog: Readonly<Record<string, AdminRouteLifecycle>>,
): CanActivate {
  const routeIds = Object.keys(catalog);
  if (routeIds.length === 0 || !Object.isFrozen(catalog)) {
    throw new TypeError('admin request guard requires a non-empty immutable generated catalog');
  }
  for (const routeId of routeIds) {
    if (!isExecutableAdminRouteRequestContract(catalog[routeId])) {
      throw new TypeError(`${routeId} has no executable generated request contract`);
    }
  }
  if (
    !Object.isFrozen(lifecycleCatalog) ||
    Object.keys(lifecycleCatalog).sort().join('\u0000') !== [...routeIds].sort().join('\u0000')
  ) {
    throw new TypeError('admin route lifecycle catalog must exactly cover generated routes');
  }
  return Object.freeze({
    canActivate(context: ExecutionContext): boolean {
      if (context.getType() !== 'http') return true;
      const routeId = adminRouteContractIdFromExecutionContext(context);
      const contract = catalog[routeId];
      if (contract === undefined) {
        throw new ServiceUnavailableException(
          `admin request contract catalog has no entry for ${routeId}`,
        );
      }
      const request = context.switchToHttp().getRequest<MutableAdminHttpRequest>();
      const lifecycle = lifecycleCatalog[routeId];
      if (
        lifecycle === 'INTERNAL_GATEWAY_ONLY' &&
        (request.verifiedIdentity?.serviceName !== 'gateway-api' ||
          request.verifiedIdentity.audience !== 'admin-api-service')
      ) {
        throw new ForbiddenException('This admin route is restricted to the signed gateway');
      }
      const rawHeaders = requestRecord(request.headers);
      try {
        assertExactRouteHeaders(rawHeaders, contract.headers);
        const decoded = decodeAdminInboundRequestV1(contract, {
          path: request.params,
          query: request.query,
          headers: selectedRequestHeaders(rawHeaders, contract.headers),
          body: request.body,
        });
        applyCanonicalRequest(request, {
          path: decoded.path,
          query: decoded.query,
          headers: canonicalTransportHeaders(rawHeaders, decoded.headers),
          ...(decoded.body === undefined ? {} : { body: decoded.body }),
        });
        return true;
      } catch (error) {
        if (error instanceof AdminHttpContractError) {
          throw new BadRequestException(error.message);
        }
        throw error;
      }
    },
  });
}
