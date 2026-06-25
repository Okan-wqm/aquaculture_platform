import { createHash } from 'crypto';

import { RemoteGraphQLDataSource } from '@apollo/gateway';
import type { GraphQLDataSourceProcessOptions } from '@apollo/gateway/dist/datasources/types';
import type { ResponsePath } from '@apollo/query-planner';
import {
  GatewayGraphQLRequestContext,
  GatewayGraphQLResponse,
} from '@apollo/server-gateway-interface';
import { buildGatewayVerifiedUserAssertion, buildSignedInternalHeaders } from '@aquaculture/backend-common/http';

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
  [key: string]: string | string[] | undefined;
}

export interface RequestWithUser {
  headers: RequestHeaders;
  user?: JwtPayload;
  cookies?: Record<string, string>;
  /**
   * The single resolved, authority-validated effective tenant for this request,
   * set by EffectiveTenantMiddleware (tenant-context SSoT). For a regular user
   * this equals the JWT tenantId; for a SUPER_ADMIN it is the validated act-as
   * target. This — NOT the raw JWT tenantId — is what gets signed into the
   * verified user-assertion below.
   */
  effectiveTenantId?: string;
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
  private readonly serviceAudience?: string;

  constructor(config: { url?: string; secret?: string; serviceAudience?: string; fetcher?: RemoteFetcher }) {
    const dataSourceConfig: Partial<RemoteGraphQLDataSource<GatewayContext>> = {
      url: config.url,
    };
    if (config.fetcher) {
      dataSourceConfig.fetcher = config.fetcher;
    }

    super(dataSourceConfig);
    this.secret = config.secret;
    this.serviceAudience = config.serviceAudience;
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
      const headers = normalizeFetcherHeaders(requestInit.headers);
      const tenantId = getHeader(headers, 'x-tenant-id') ?? '';
      const signedTenantId = TENANT_UUID_RE.test(tenantId) ? tenantId : '';
      const subgraphUrl = new URL(String(url), 'http://subgraph.local');
      const assertion = getHeader(headers, 'x-verified-user-assertion');
      const contentType = getHeader(headers, 'content-type') ?? '';
      const identityHeaders = buildSignedInternalHeaders({
        serviceName: 'gateway-api',
        tenantId: signedTenantId,
        method: requestInit.method ?? 'POST',
        path: subgraphUrl.pathname,
        query: subgraphUrl.search,
        contentType,
        assertionHash: assertion
          ? createHash('sha256').update(assertion).digest('hex')
          : undefined,
        audience: this.serviceAudience ?? subgraphUrl.hostname,
        body: bodyForServiceIdentitySigning(requestInit.body),
        secret: this.secret,
      });
      for (const [key, value] of Object.entries(identityHeaders)) {
        setHeader(headers, key, value);
      }
      requestInit.headers = headers;
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

    // Forward the gateway-RESOLVED effective tenant (SSoT) — for a SUPER_ADMIN
    // acting-as a tenant this is the validated act-as target, not the (null) JWT
    // tenantId. Subgraphs cross-check this against the signed assertion below.
    const resolvedTenantId = req.effectiveTenantId ?? req.user?.tenantId;
    if (resolvedTenantId && TENANT_UUID_RE.test(resolvedTenantId)) {
      httpRequest.headers.set('x-tenant-id', resolvedTenantId);
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

    const user = req.user;
    if (user) {
      httpRequest.headers.set(
        'x-verified-user-assertion',
        buildGatewayVerifiedUserAssertion({
          subject: user.sub,
          tenantId: user.tenantId,
          // SSoT: sign the gateway-RESOLVED effective tenant (validated act-as
          // for SUPER_ADMIN; JWT tenantId for regular users). Keeping
          // `tenantId` as the home/source tenant for audit. This is bound into
          // the HMAC so it cannot be spoofed and survives header-stripping.
          effectiveTenantId: req.effectiveTenantId ?? user.tenantId,
          roles: user.roles ?? [],
          email: user.email,
          mfaVerified: (user as JwtPayload & { mfaVerified?: boolean }).mfaVerified,
          // SEC-HIGH-051 / SEC-HIGH-052: thread the object-level authorization
          // claims into the HMAC-bound assertion so farm/hr resolvers can
          // enforce site + mobile-feature gates on the production gateway path.
          assignedSiteIds: user.assignedSiteIds,
          mobileFeatures: user.mobileFeatures,
          // SSOT-C-13: thread the plan tier ordinal so farm/sensor resolvers can
          // enforce per-plan resource quotas on the production gateway path.
          planLevel: (user as JwtPayload & { planLevel?: number }).planLevel,
        }),
      );
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
