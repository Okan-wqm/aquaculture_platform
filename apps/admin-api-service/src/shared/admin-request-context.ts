import { randomUUID } from 'node:crypto';

import { decodeAdminRequestId } from '@platform/admin-http-contracts';
import type { Request, Response } from 'express';

export interface AdminRequestContext {
  readonly requestId: string;
  readonly routeId: string;
  readonly routePath: string;
}

const REQUEST_CONTEXTS = new WeakMap<Request, AdminRequestContext>();

function registeredRoutePath(request: Request): string {
  const registeredPath: unknown = request.route?.path;
  if (typeof registeredPath !== 'string' || !registeredPath.startsWith('/')) {
    return '/_unmatched';
  }
  const base = request.baseUrl.endsWith('/')
    ? request.baseUrl.slice(0, -1)
    : request.baseUrl;
  return `${base}${registeredPath}` || '/';
}

function requestIdFromHeader(request: Request): string | undefined {
  const header = request.headers['x-request-id'];
  if (typeof header !== 'string') return undefined;
  try {
    return decodeAdminRequestId(header);
  } catch {
    return undefined;
  }
}

export function adminRequestContext(
  request: Request,
  response?: Pick<Response, 'setHeader'>,
): AdminRequestContext {
  const existing = REQUEST_CONTEXTS.get(request);
  if (existing !== undefined) {
    response?.setHeader('X-Request-ID', existing.requestId);
    return existing;
  }

  const routePath = registeredRoutePath(request);
  const context = Object.freeze({
    requestId: requestIdFromHeader(request) ?? randomUUID(),
    routeId: `${request.method.toUpperCase()} ${routePath}`,
    routePath,
  });
  REQUEST_CONTEXTS.set(request, context);
  response?.setHeader('X-Request-ID', context.requestId);
  return context;
}
