import { RemoteGraphQLDataSource } from '@apollo/gateway';
import {
  GatewayGraphQLRequestContext,
  GatewayGraphQLResponse,
} from '@apollo/server-gateway-interface';
import type { GraphQLDataSourceProcessOptions } from '@apollo/gateway/dist/datasources/types';
import type { ResponsePath } from '@apollo/query-planner';
import { buildSignedInternalHeaders } from '@aquaculture/backend-common/http';
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

const TENANT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Apollo Gateway serializes the subgraph POST body after willSendRequest()
 * runs, so the body is not available as request.http.body at signing time.
 * This mirrors RemoteGraphQLDataSource.sendRequest(): strip the transport
 * envelope (`http`) and JSON.stringify the remaining GraphQL request.
 */
export function serializeApolloSubgraphBodyForSigning(
  request: GatewaySubgraphRequest,
): string {
  const { http: _http, ...requestWithoutHttp } = request;
  void _http;
  return JSON.stringify(requestWithoutHttp);
}

/**
 * Custom data source that forwards trusted user context and signs every
 * subgraph request with the same v2 service-identity contract enforced by
 * ServiceIdentityGuard in downstream services.
 */
export class AuthenticatedDataSource extends RemoteGraphQLDataSource<GatewayContext> {
  private readonly secret?: string;

  constructor(config: { url?: string; secret?: string }) {
    super({ url: config.url });
    this.secret = config.secret;
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

    let resolvedTenantId = req.user?.tenantId;
    if (!resolvedTenantId) {
      const headerVal = req.headers['x-tenant-id'];
      const candidate = Array.isArray(headerVal) ? headerVal[0] : headerVal;
      if (typeof candidate === 'string') {
        resolvedTenantId = candidate.trim();
      }
    }
    if (
      resolvedTenantId &&
      typeof resolvedTenantId === 'string' &&
      resolvedTenantId.length > 0 &&
      TENANT_UUID_RE.test(resolvedTenantId)
    ) {
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
      httpRequest.headers.set('x-user-id', user.sub);
      httpRequest.headers.set('x-user-roles', JSON.stringify(user.roles ?? []));
      httpRequest.headers.set('x-user-payload', JSON.stringify(user));
    }

    if (this.secret) {
      const signedTenantId = TENANT_UUID_RE.test(resolvedTenantId ?? '')
        ? (resolvedTenantId as string)
        : '';
      const subgraphUrl = new URL(httpRequest.url ?? '/graphql', 'http://subgraph.local');
      const identityHeaders = buildSignedInternalHeaders({
        serviceName: 'gateway-api',
        tenantId: signedTenantId,
        method: httpRequest.method ?? 'POST',
        path: subgraphUrl.pathname,
        body: serializeApolloSubgraphBodyForSigning(subgraphRequest),
        secret: this.secret,
      });
      for (const [key, value] of Object.entries(identityHeaders)) {
        httpRequest.headers.set(key, value);
      }
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
