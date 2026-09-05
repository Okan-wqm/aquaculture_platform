// Minimal HTTP router over node:http — method + path templates with `:params`.
//
// WHY: the console has ~30 endpoints and zero runtime dependencies; a table of
// routes matched by a compiled regex is all the dispatch it needs, and owning it
// keeps error rendering, body limits and JSON responses in one place.
// WHAT: compileRoute/matchRoute, RequestContext, sendJson, readJsonBody (64 KiB
// cap), and `dispatch` which resolves the route or raises 404/405.

import type { IncomingMessage, ServerResponse } from 'node:http';

import type { ServerConfig } from './config.ts';
import type { Principal } from './principal.ts';
import { HttpError } from './errors.ts';

export type HttpMethod = 'GET' | 'POST';

export interface RequestContext {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly config: ServerConfig;
  /** Who the server authenticated for this request; never taken from the request itself. */
  readonly principal: Principal;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly path: string;
}

export type RouteHandler = (ctx: RequestContext) => Promise<void>;

export interface Route {
  readonly method: HttpMethod;
  readonly pattern: string;
  readonly handler: RouteHandler;
}

interface CompiledRoute extends Route {
  readonly regex: RegExp;
  readonly paramNames: ReadonlyArray<string>;
}

export const MAX_BODY_BYTES = 64 * 1024;

export function compileRoute(route: Route): CompiledRoute {
  const paramNames: string[] = [];
  const source = route.pattern
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        paramNames.push(segment.slice(1));
        return '([^/]+)';
      }
      return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { ...route, regex: new RegExp(`^${source}$`), paramNames };
}

export interface RouteMatch {
  readonly route: CompiledRoute;
  readonly params: Readonly<Record<string, string>>;
}

export function matchRoute(routes: ReadonlyArray<CompiledRoute>, method: string, path: string): RouteMatch | 'method_not_allowed' | null {
  let pathMatched = false;
  for (const route of routes) {
    const match = route.regex.exec(path);
    if (match === null) continue;
    pathMatched = true;
    if (route.method !== method) continue;
    const params: Record<string, string> = {};
    route.paramNames.forEach((name, index) => {
      params[name] = decodeURIComponent(match[index + 1] ?? '');
    });
    return { route, params };
  }
  return pathMatched ? 'method_not_allowed' : null;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

export async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk instanceof Buffer ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large');
    chunks.push(buffer);
  }
  if (total === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'body_not_json');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'body_not_object');
  }
  return parsed as Record<string, unknown>;
}

export function clampLimit(query: URLSearchParams, fallback: number, max: number): number {
  const raw = query.get('limit');
  if (raw === null || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new HttpError(400, 'limit_invalid');
  return Math.min(parsed, max);
}

export async function dispatch(routes: ReadonlyArray<CompiledRoute>, ctx: Omit<RequestContext, 'params'>): Promise<boolean> {
  const method = ctx.req.method ?? 'GET';
  const match = matchRoute(routes, method, ctx.path);
  if (match === null) return false;
  if (match === 'method_not_allowed') throw new HttpError(405, 'method_not_allowed');
  await match.route.handler({ ...ctx, params: match.params });
  return true;
}
