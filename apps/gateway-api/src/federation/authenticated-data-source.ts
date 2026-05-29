import { RemoteGraphQLDataSource } from '@apollo/gateway';
import {
  GatewayGraphQLRequestContext,
  GatewayGraphQLResponse,
} from '@apollo/server-gateway-interface';
import type { GraphQLDataSourceProcessOptions } from '@apollo/gateway/dist/datasources/types';
import type { ResponsePath } from '@apollo/query-planner';
import { buildSignedInternalHeaders } from '@aquaculture/backend-common/http';
import {
  VERIFIED_USER_ASSERTION_HEADER,
  generateVerifiedUserAssertion,
} from '@aquaculture/backend-common/utils';
import { JwtPayload } from '../guards/auth.guard';

export interface RequestHeaders {
  authorization?: string;
  cookie?: string;
  'x-tenant-id'?: string;
  'x-correlation-id'?: string;
  traceparent?: string;
  'x-trace-id'?: string;
  'x-span-id'?: string;
  'x-parent-span-id'?: string;
  'x-act-as-tenant'?: string;
  [key: string]: string | string[] | undefined;
}

export interface RequestWithUser {
  headers: RequestHeaders;
  user?: JwtPayload;
  cookies?: Record<string, string>;
}

export interface GatewayContext {
  req: RequestWithUser;
  res: import('express').Response;
}

type MutableHeaderSet = {
  set: (key: string, value: string) => void;
};

export type GatewaySubgraphRequest = {
  http?: {
    headers: MutableHeaderSet;
    method?: string;
    url?: string;
  };
  [key: string]: unknown;
};

const TENANT_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUPER_ADMIN_ROLES = new Set(['SUPER_ADMIN', 'super_admin', 'platform_admin']);

type RemoteFetcher = RemoteGraphQLDataSource<GatewayContext>['fetcher'];
type FetcherInit = NonNullable<Parameters<RemoteFetcher>[1]>;

function normalizeFetcherHeaders(headers: FetcherInit['headers']): Record<string, string> {
  const normalized: Record<string, string> = {};
  if (!headers) {
    return normalized;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      normalized[key] = String(value);
    }
    return normalized;
  }
  if (typeof (headers as { forEach?: unknown }).forEach === 'function') {
    (
      headers as unknown as {
        forEach: (callback: (value: string, key: string) => void) => void;
      }
    ).forEach((value, key) => {
      normalized[key] = value;
    });
    return normalized;
  }
  return { ...(headers as Record<string, string>) };
}

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === lower);
  return key ? headers[key] : undefined;
}

function setHeader(headers: Record<string, string>, name: string, value: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      delete headers[key];
    }
  }
  headers[name] = value;
}

function deleteHeader(headers: Record<string, string>, name: string): void {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      delete headers[key];
    }
  }
}

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isSuperAdmin(user: JwtPayload | undefined): boolean {
  return (user?.roles ?? []).some((role) => SUPER_ADMIN_ROLES.has(role));
}

function bodyForServiceIdentitySigning(body: FetcherInit['body']): string | Buffer {
  if (body === undefined || body === null) {
    return '';
  }
  if (typeof body === 'string' || Buffer.isBuffer(body)) {
    return body;
  }
  return String(body);
}

/**
 * Custom data source that forwards trusted user context and signs every
 * subgraph request with the same v2 service-identity contract enforced by
 * ServiceIdentityGuard in downstream services.
 */
export class AuthenticatedDataSource extends RemoteGraphQLDataSource<GatewayContext> {
  private readonly secret?: string;
  private readonly userAssertionSecret?: string;
  private readonly assertionAudience: string;

  constructor(config: {
    url?: string;
    secret?: string;
    userAssertionSecret?: string;
    assertionAudience?: string;
    fetcher?: RemoteFetcher;
  }) {
    const dataSourceConfig: Partial<RemoteGraphQLDataSource<GatewayContext>> = {
      url: config.url,
    };
    if (config.fetcher) {
      dataSourceConfig.fetcher = config.fetcher;
    }

    super(dataSourceConfig);
    this.secret = config.secret;
    this.userAssertionSecret = config.userAssertionSecret;
    this.assertionAudience = config.assertionAudience ?? 'farm-service';
    this.fetcher = this.withServiceIdentitySigning(this.fetcher);
  }

  private withServiceIdentitySigning(upstream: RemoteFetcher): RemoteFetcher {
    if (typeof upstream !== 'function') {
      throw new TypeError(
        'Apollo subgraph fetcher is unavailable; service identity signing cannot run.',
      );
    }

    // Apollo serializes the final subgraph body after willSendRequest(); sign at
    // the fetch boundary so the HMAC binds the exact bytes sent on the wire.
    return async (url, init): ReturnType<RemoteFetcher> => {
      const requestInit = init ?? {};
      if (this.secret) {
        const headers = normalizeFetcherHeaders(requestInit.headers);
        const userAssertion = getHeader(headers, VERIFIED_USER_ASSERTION_HEADER);
        const tenantId = getHeader(headers, 'x-tenant-id') ?? '';
        const signedTenantId = userAssertion && TENANT_UUID_RE.test(tenantId) ? tenantId : '';
        if (!signedTenantId) {
          deleteHeader(headers, 'x-tenant-id');
        }
        const subgraphUrl = new URL(String(url), 'http://subgraph.local');
        const identityHeaders = buildSignedInternalHeaders({
          serviceName: 'gateway-api',
          tenantId: signedTenantId,
          method: requestInit.method ?? 'POST',
          path: subgraphUrl.pathname,
          body: bodyForServiceIdentitySigning(requestInit.body),
          userAssertion,
          secret: this.secret,
        });
        for (const [key, value] of Object.entries(identityHeaders)) {
          setHeader(headers, key, value);
        }
        requestInit.headers = headers;
      }
      return upstream(url, requestInit);
    };
  }

  override willSendRequest(params: GraphQLDataSourceProcessOptions<GatewayContext>): void {
    const { request, context } = params;
    const subgraphRequest = request as GatewaySubgraphRequest;

    if (!context || !('req' in context)) {
      return;
    }

    const req = (context as GatewayContext).req;
    const httpRequest = subgraphRequest.http;

    if (!httpRequest) {
      return;
    }

    const authorization = req.headers.authorization;
    if (authorization) {
      httpRequest.headers.set('authorization', authorization);
    }

    const cookie = req.headers.cookie;
    if (cookie) {
      httpRequest.headers.set('cookie', cookie);
    }

    const user = req.user;
    let resolvedTenantId = user?.tenantId;
    const actAsTenant = firstHeaderValue(req.headers['x-act-as-tenant'])?.trim();
    if (user && isSuperAdmin(user) && actAsTenant && TENANT_UUID_RE.test(actAsTenant)) {
      resolvedTenantId = actAsTenant;
    }
    if (
      resolvedTenantId &&
      typeof resolvedTenantId === 'string' &&
      resolvedTenantId.length > 0 &&
      TENANT_UUID_RE.test(resolvedTenantId)
    ) {
      httpRequest.headers.set('x-tenant-id', resolvedTenantId);
    }

    if (user && this.userAssertionSecret) {
      httpRequest.headers.set(
        VERIFIED_USER_ASSERTION_HEADER,
        generateVerifiedUserAssertion({
          user,
          secret: this.userAssertionSecret,
          audience: this.assertionAudience,
          effectiveTenantId: resolvedTenantId,
        }),
      );
    }

    const correlationId = req.headers['x-correlation-id'];
    if (correlationId) {
      httpRequest.headers.set('x-correlation-id', correlationId);
    }

    const traceparent = req.headers.traceparent;
    if (traceparent) {
      httpRequest.headers.set('traceparent', traceparent);
    }

    const traceId = req.headers['x-trace-id'];
    if (traceId) {
      httpRequest.headers.set('x-trace-id', traceId);
    }

    const spanId = req.headers['x-span-id'];
    if (spanId) {
      httpRequest.headers.set('x-span-id', spanId);
    }

    const parentSpanId = req.headers['x-parent-span-id'];
    if (parentSpanId) {
      httpRequest.headers.set('x-parent-span-id', parentSpanId);
    }

    if (user) {
      httpRequest.headers.set('x-user-id', user.sub);
      httpRequest.headers.set('x-user-roles', JSON.stringify(user.roles ?? []));
      httpRequest.headers.set('x-user-payload', JSON.stringify(user));
    }
  }

  override didReceiveResponse(
    requestContext: Required<
      Pick<GatewayGraphQLRequestContext<GatewayContext>, 'request' | 'response' | 'context'>
    > & {
      pathInIncomingRequest?: ResponsePath;
    },
  ): GatewayGraphQLResponse {
    const { response, context } = requestContext;
    if (context && 'res' in context) {
      const res = (context as GatewayContext).res;
      const setCookieHeader = response.http?.headers?.get('set-cookie');
      if (setCookieHeader) {
        res.append('set-cookie', setCookieHeader);
      }
    }
    return response;
  }
}
