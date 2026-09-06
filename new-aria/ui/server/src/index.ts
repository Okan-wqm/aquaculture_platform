// new-aria operator console — HTTP entrypoint.
//
// WHY: one process serves the SPA and the API on one origin; it reads ARIA's
// ledgers under ARIA_TOOLS_DIR and asks the kernel CLI for every action.
// WHAT: config → legal adapter registration + ledger key + principals →
// authorizer + routes → node:http server; `/api/*` goes through auth, resolves
// the principal and the router, everything else is the static SPA; errors
// render as the ApiError contract; SIGTERM/SIGINT close the listener. The
// request log names no case, document or person: a case id is a client, and
// stdout is not a custody record — the access ledger is.

import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { API_PREFIX } from '../../shared/api-contract.ts';
import { JobTable, runKernel } from './actions.ts';
import { Authorizer } from './auth.ts';
import type { PrincipalResolver } from './auth.ts';
import { ConfigError, loadConfig } from './config.ts';
import type { ServerConfig } from './config.ts';
import { HttpError, toApiError } from './errors.ts';
import type { LedgerSigner } from './ledger.ts';
import { loadOrCreateSigner } from './ledger.ts';
import type { LegalReadinessHolder } from './legal-readiness.ts';
import { registerLegalAdapter } from './legal-readiness.ts';
import { listCaseIds, reconcileIntake } from './legal-intake.ts';
import { log, maskLegalPath, redactHeaders } from './log.ts';
import { ANONYMOUS_PRINCIPAL, TOKEN_HOLDER_PRINCIPAL } from './principal.ts';
import type { PrincipalDirectory } from './principals.ts';
import { loadOrCreatePrincipals, tokenDigest } from './principals.ts';
import { dispatch, sendJson } from './router.ts';
import { buildRoutes } from './routes.ts';
import { acquireInstallationLock, installationStoragePaths } from './installation-lock.ts';
import type { InstallationLock } from './installation-lock.ts';
import { serveStatic } from './static.ts';

/** Every credential this console accepts, each resolving to one principal. */
function resolverFor(principals: PrincipalDirectory | null): PrincipalResolver {
  return principals === null ? () => null : (token) => { principals.reload(); return principals.resolve(token); };
}

export function createConsoleServer(config: ServerConfig, readiness: LegalReadinessHolder, lease: InstallationLock): ReturnType<typeof createServer> {
  for (const path of installationStoragePaths(config)) lease.assertOwns(path);
  const resolvePrincipal = resolverFor(readiness.principals);
  const authorizer = new Authorizer(resolvePrincipal);
  const routes = buildRoutes(config, new JobTable(lease), readiness, resolvePrincipal, lease);

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const startedAt = process.hrtime.bigint();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const remote = req.socket.remoteAddress ?? 'unknown';
    try {
      if (path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)) {
        for (const storagePath of installationStoragePaths(config)) lease.assertOwns(storagePath);
        const verdict = authorizer.authorize(path, req.headers.authorization, remote);
        if (verdict.kind === 'rate_limited') {
          res.setHeader('Retry-After', String(verdict.retryAfterSeconds));
          throw new HttpError(429, 'too_many_failed_authentications');
        }
        if (verdict.kind === 'unauthorized') {
          res.setHeader('WWW-Authenticate', 'Bearer realm="new-aria"');
          throw new HttpError(401, 'unauthorized');
        }
        // The principal is what the credential proved and nothing more; a
        // public route acts as nobody.
        const principal = verdict.kind === 'ok' ? verdict.principal : ANONYMOUS_PRINCIPAL;
        const routed = await dispatch(routes, { req, res, config, principal, query: url.searchParams, path });
        if (!routed) throw new HttpError(404, 'not_found');
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        await serveStatic(config.staticDir, path, res);
      } else {
        throw new HttpError(405, 'method_not_allowed');
      }
    } catch (error) {
      const { status, body } = toApiError(error);
      // A 5xx detail may quote a path inside a case directory; the code is enough for stdout.
      if (status >= 500) log('error', 'request failed', { path: maskLegalPath(path), status, error: body.error });
      if (!res.headersSent) sendJson(res, status, body);
      else res.end();
    } finally {
      const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      log('info', 'request', { method: req.method, path: maskLegalPath(path), status: res.statusCode, elapsedMs: Math.round(elapsedMs), remote, headers: redactHeaders({ 'user-agent': req.headers['user-agent'] }) });
    }
  };

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      log('error', 'unhandled request error', { error: error instanceof Error ? error.message : String(error) });
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
    });
  });
}

/**
 * Registers the legal adapter, loads (or creates) the ledger signing key and
 * loads (or seeds) the principals file before the console listens, so the
 * first request already sees the kernel's answer, the first receipt can be
 * signed, and the first person who logs in is a known principal. A refusal
 * is logged and reported on /health; it never stops the read-only console
 * from serving, and without a key the intake routes refuse rather than write
 * an unsigned receipt. A broken principals file stops the console: an identity
 * store that half-loads is worse than none.
 */
export async function prepareLegalReadiness(config: ServerConfig, lease: InstallationLock): Promise<LegalReadinessHolder> {
  for (const path of installationStoragePaths(config)) lease.assertOwns(path);
  const boot = await registerLegalAdapter(config, (cfg, argv, timeoutMs) => runKernel(cfg, argv, timeoutMs, lease));
  log(boot.adapter === 'registered' || boot.adapter === 'not_applicable' ? 'info' : 'error', 'legal adapter readiness', { adapter: boot.adapter, toolId: boot.toolId, detail: boot.detail });
  let signer: LedgerSigner | null = null;
  let signerDetail: string | null = null;
  try {
    signer = loadOrCreateSigner(config.ledgerKeyFile);
    log('info', 'ledger signing key', { keyId: signer.keyId, path: config.ledgerKeyFile });
  } catch (error) {
    signerDetail = `ledger key at ${config.ledgerKeyFile} could not be loaded or created: ${error instanceof Error ? error.message : String(error)}`;
    log('error', 'ledger signing key unavailable', { detail: signerDetail });
  }
  let principals: PrincipalDirectory | null = null;
  if (config.principalsFile !== null) {
    const seed = config.token === null ? null : { id: TOKEN_HOLDER_PRINCIPAL.id, displayName: TOKEN_HOLDER_PRINCIPAL.displayName, tokenSha256: tokenDigest(config.token) };
    principals = loadOrCreatePrincipals(config.principalsFile, seed, new Date().toISOString());
    log('info', 'principals loaded', { path: config.principalsFile, count: principals.list().length });
  }
  // Complete interrupted receipt-backed publication before any request or job
  // can observe the archive. Invalid custody state prevents startup.
  if (signer !== null) {
    for (const caseId of await listCaseIds(config.legalCasesDir)) {
      await reconcileIntake(config.legalCasesDir, caseId, signer);
    }
  }
  return { boot, signer, signerDetail, principals };
}

async function main(): Promise<void> {
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
  const lease = acquireInstallationLock(installationStoragePaths(config));
  let readiness: LegalReadinessHolder;
  try {
    readiness = await prepareLegalReadiness(config, lease);
  } catch (error) {
    if (error instanceof ConfigError) {
      log('error', 'configuration refused', { variable: error.variable, detail: error.message });
      process.exit(2);
    }
    throw error;
  }
  const server = createConsoleServer(config, readiness, lease);
  server.listen(config.port, config.host, () => {
    log('info', 'console listening', { host: config.host, port: config.port, toolsDir: config.toolsDir, actionsEnabled: config.allowActions, identity: 'principals_file', version: config.version });
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
  main().catch((error: unknown) => {
    log('error', 'console failed to start', { error: error instanceof Error ? error.message : String(error) });
    process.exit(1);
  });
}
