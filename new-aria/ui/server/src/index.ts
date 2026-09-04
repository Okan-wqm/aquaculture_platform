// new-aria operator console — HTTP entrypoint.
//
// WHY: one process serves the SPA and the API on one origin; it reads ARIA's
// ledgers under ARIA_TOOLS_DIR and asks the kernel CLI for every action.
// WHAT: config → authorizer + routes → node:http server; `/api/*` goes through
// auth and the router, everything else is the static SPA; errors render as the
// ApiError contract; SIGTERM/SIGINT close the listener.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { API_PREFIX } from '../../shared/api-contract.ts';
import { JobTable } from './actions.ts';
import { Authorizer } from './auth.ts';
import { ConfigError, loadConfig } from './config.ts';
import type { ServerConfig } from './config.ts';
import { HttpError, toApiError } from './errors.ts';
import { log, redactHeaders } from './log.ts';
import { dispatch, sendJson } from './router.ts';
import { buildRoutes } from './routes.ts';
import { serveStatic } from './static.ts';

export function createConsoleServer(config: ServerConfig): ReturnType<typeof createServer> {
  const authorizer = new Authorizer(config.token);
  const routes = buildRoutes(config, new JobTable());

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const startedAt = process.hrtime.bigint();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const remote = req.socket.remoteAddress ?? 'unknown';
    try {
      if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) {
        const verdict = authorizer.authorize(path, req.headers.authorization, remote);
        if (verdict.kind === 'rate_limited') {
          res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
          throw new HttpError(429, 'too_many_failed_authentications');
        }
        if (verdict.kind === 'unauthorized') {
          res.setHeader('WWW-Authenticate', 'Bearer realm="new-aria"');
          throw new HttpError(401, 'unauthorized');
        }
        const routed = await dispatch(routes, { req, res, config, query: url.searchParams, path });
        if (!routed) throw new HttpError(404, 'not_found');
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(config.staticDir, path, res);
      } else {
        throw new HttpError(405, 'method_not_allowed');
      }
    } catch (error) {
      const { status, body } = toApiError(error);
      if (status >= 500) log('error', 'request failed', { path, status, error: body.detail ?? body.error });
      if (!res.headersSent) sendJson(res, status, body);
      else res.end();
    } finally {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      log('info', 'request', { method: req.method, path, status: res.statusCode, elapsedMs: Math.round(elapsedMs), remote, headers: redactHeaders({ 'user-agent': req.headers['user-agent'] }) });
    }
  };

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log('error', 'unhandled request error', { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    });
  });
}

function main(): void {
  let config: ServerConfig;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      log('error', 'configuration refused', { variable: error.variable, detail: error.message });
      process.exit(2);
    }
    throw error;
  }
  const server = createConsoleServer(config);
  server.listen(config.port, config.host, () => {
    log('info', 'console listening', { host: config.host, port: config.port, toolsDir: config.toolsDir, actionsEnabled: config.allowActions, version: config.version });
  });
  const shutdown = (signal: string): void => {
    log('info', 'shutting down', { signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
