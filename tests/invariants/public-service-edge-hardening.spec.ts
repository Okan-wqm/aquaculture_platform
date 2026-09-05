/**
 * INVARIANT — the internet edge is derived from nginx, never listed by hand,
 * and every edge boots hardened (ADR-0006, SEC-CRITICAL-056).
 *
 * # What went wrong before
 *
 * Production has two ingresses: `infrastructure/nginx/droplet.conf` proxies
 * GraphQL/upload/marine to gateway-api, the `/api/` catch-all to
 * admin-api-service, device provisioning to sensor-service and the Stripe
 * webhook to billing-service. The kernel's edge controls were mounted on
 * gateway-api alone: `strip-internal-headers-mounted.spec.ts` excluded
 * admin-api behind a `// Future:` comment, `access-log-middleware-mounted
 * .spec.ts` called the gateway "the single external ingress", and
 * `TRUST_PROXY` was unset on admin-api, sensor-service and billing-service,
 * so `req.ip` was the nginx bridge address and every per-IP rate-limit bucket
 * was one global bucket (AUTH-010). The defect class was a hand-maintained
 * list of edges. This spec replaces both predecessors and has no such list.
 *
 * # What this spec enforces
 *
 *   1. The public set is PARSED from nginx (`set $var host` + `proxy_pass
 *      http://$var:port`) and intersected with the Nest services that boot
 *      through `bootstrapService`. No name is written here.
 *   2. Every Nest service declares `serviceVisibility` (the compiler already
 *      demands it) and the declaration equals what nginx says.
 *   3. `docker-compose.droplet.yml` states the edge: public services carry a
 *      literal `TRUST_PROXY` and `CORS_ORIGINS`; internal services carry
 *      neither; no Nest service publishes a host port beyond loopback.
 *   4. The factory mounts the bundle for public services and nowhere else;
 *      public services import `AccessLogModule.forRoot()`; no service mounts
 *      `AccessLogMiddleware` itself, so one row per edge request holds.
 *   5. Every Nest service mounts `StripInternalHeadersMiddleware` from the
 *      canonical barrel before `UserContextMiddleware` (SEC-CRITICAL-002) —
 *      all of them, no exemption list.
 *   6. The dead CSRF layer (AUTH-017) stays deleted on both sides.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import * as yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');
const NGINX_CONF = 'infrastructure/nginx/droplet.conf';
const DROPLET_COMPOSE = 'docker-compose.droplet.yml';
const FACTORY = 'libs/backend-common/src/bootstrap/create-service-app.ts';
const BOOTSTRAP_CALL = 'bootstrapService(AppModule';

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** Drop block + line comments so docstring mentions do not register as code. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

function gitLsFiles(pathspecs: string[]): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', ...pathspecs], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean);
}

/** `git grep -l`; exit status 1 means "no match", which is the answer we want. */
function gitGrepFiles(patterns: string[], pathspecs: string[]): string[] {
  try {
    return execFileSync(
      'git',
      ['-C', REPO_ROOT, 'grep', '-l', ...patterns.flatMap((p) => ['-e', p]), '--', ...pathspecs],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    if (status === 1) return [];
    throw err;
  }
}

/** Every Nest service: an `apps/<svc>/src/main.ts` that boots through the factory. */
function nestServices(): string[] {
  return gitLsFiles(['apps/*/src/main.ts'])
    .map((path) => /^apps\/([^/]+)\/src\/main\.ts$/.exec(path)?.[1])
    .filter((svc): svc is string => svc !== undefined)
    .filter((svc) => read(`apps/${svc}/src/main.ts`).includes(BOOTSTRAP_CALL))
    .sort();
}

/**
 * Hosts nginx proxies to. droplet.conf uses the variable form
 * (`set $backend_x host; proxy_pass http://$backend_x:3000;`) so Docker DNS
 * re-resolves per request; the parser follows exactly that shape.
 */
function nginxProxiedHosts(): Set<string> {
  const conf = read(NGINX_CONF);
  const variables = new Map<string, string>();
  for (const match of conf.matchAll(/^\s*set\s+\$(\w+)\s+([A-Za-z0-9_.-]+);/gm)) {
    const [, name, host] = match;
    if (name && host) variables.set(name, host);
  }
  const hosts = new Set<string>();
  for (const match of conf.matchAll(/proxy_pass\s+https?:\/\/\$(\w+):\d+/g)) {
    const host = match[1] ? variables.get(match[1]) : undefined;
    if (host) hosts.add(host);
  }
  return hosts;
}

interface ComposePort {
  host_ip?: string;
}

interface ComposeService {
  environment?: Record<string, unknown> | string[];
  ports?: Array<string | number | ComposePort>;
}

interface ComposeDocument {
  services?: Record<string, ComposeService>;
}

function composeService(doc: ComposeDocument, svc: string): ComposeService {
  const service = doc.services?.[svc];
  if (!service) throw new Error(`${DROPLET_COMPOSE} has no service ${svc}`);
  return service;
}

function composeEnvironment(doc: ComposeDocument, svc: string): Record<string, string> {
  const { environment } = composeService(doc, svc);
  if (!environment || Array.isArray(environment)) {
    throw new Error(`${svc}.environment must be a mapping`);
  }
  return Object.fromEntries(Object.entries(environment).map(([k, v]) => [k, String(v)]));
}

interface StripAnalysis {
  hasImport: boolean;
  importsFromCanonical: boolean;
  hasApplyMount: boolean;
  mountedBeforeUserContext: boolean;
}

function analyzeStripMount(svc: string): StripAnalysis {
  const stripped = stripComments(read(`apps/${svc}/src/app.module.ts`));
  const M = 'StripInternalHeadersMiddleware';
  const configureStart = stripped.indexOf('configure(consumer');
  const stripFirst = configureStart === -1 ? -1 : stripped.indexOf(M, configureStart);
  const userFirst =
    configureStart === -1 ? -1 : stripped.indexOf('UserContextMiddleware', configureStart);
  return {
    hasImport: new RegExp(`import\\s+\\{[^}]*\\b${M}\\b[^}]*\\}`).test(stripped),
    importsFromCanonical: new RegExp(
      `import\\s+\\{[^}]*\\b${M}\\b[^}]*\\}\\s+from\\s+['"]@aquaculture\\/backend-common\\/middleware['"]`,
    ).test(stripped),
    hasApplyMount: new RegExp(`\\.apply\\([\\s\\S]*?\\b${M}\\b`).test(stripped),
    // Strip must be the first identity-bearing middleware: before UserContext
    // when the service parses user payloads, trivially satisfied otherwise.
    mountedBeforeUserContext: stripFirst !== -1 && (userFirst === -1 || stripFirst < userFirst),
  };
}

describe('INVARIANT: the internet edge is derived from nginx and every edge boots hardened (ADR-0006)', () => {
  const services = nestServices();
  const proxied = nginxProxiedHosts();
  const publicServices = services.filter((svc) => proxied.has(svc));
  const internalServices = services.filter((svc) => !proxied.has(svc));

  it('the parser sees the fleet and the edge (sanity, not a list)', () => {
    expect(services.length).toBeGreaterThanOrEqual(10);
    // gateway-api terminates GraphQL for every browser; if the parser cannot
    // see it, the parser is broken and every assertion below is vacuous.
    expect(publicServices).toContain('gateway-api');
    expect(publicServices.length).toBeGreaterThanOrEqual(2);
    expect(internalServices.length).toBeGreaterThanOrEqual(1);
  });

  it.each(services)('%s declares exactly the visibility nginx gives it', (svc) => {
    const main = stripComments(read(`apps/${svc}/src/main.ts`));
    const declared = /serviceVisibility:\s*'(public|internal)'/.exec(main)?.[1];
    expect(declared).toBe(proxied.has(svc) ? 'public' : 'internal');
  });

  it('the factory requires the declaration and mounts the bundle only for public services', () => {
    const factory = read(FACTORY);
    expect(factory).toMatch(/^\s*serviceVisibility: ServiceVisibility;/m);
    expect(factory).not.toMatch(/serviceVisibility\?:/);
    expect(factory).not.toMatch(/serviceVisibility\s*=\s*'public'/);
    expect(factory).toMatch(
      /if \(serviceVisibility === 'public'\) \{\s*mountEdgeHardening\(app, serviceName, logger\);/,
    );
    expect(factory).toMatch(/resolveTrustProxy\(\{/);
    expect(existsSync(join(REPO_ROOT, 'libs/backend-common/src/bootstrap/edge-hardening.ts'))).toBe(
      true,
    );
  });

  describe('docker-compose.droplet.yml states the derived edge', () => {
    const compose = yaml.load(read(DROPLET_COMPOSE)) as ComposeDocument;

    it.each(publicServices)('%s trusts the nginx hop as a literal, not an interpolation', (svc) => {
      expect(['true', '1']).toContain(composeEnvironment(compose, svc)['TRUST_PROXY']);
    });

    it.each(publicServices)('%s states its browser origins', (svc) => {
      const origins = composeEnvironment(compose, svc)['CORS_ORIGINS'];
      expect(origins).toBeDefined();
      expect(origins?.trim()).not.toBe('');
    });

    it.each(internalServices)('%s carries no edge configuration', (svc) => {
      const env = composeEnvironment(compose, svc);
      expect(env['TRUST_PROXY']).toBeUndefined();
      expect(env['CORS_ORIGINS']).toBeUndefined();
    });

    it.each(services)(
      '%s publishes no host port beyond loopback — nginx is the only ingress',
      (svc) => {
        for (const port of composeService(compose, svc).ports ?? []) {
          if (typeof port === 'object') {
            expect(port.host_ip).toBe('127.0.0.1');
          } else {
            expect(String(port)).toMatch(/^127\.0\.0\.1:/);
          }
        }
      },
    );
  });

  describe('exactly one access-log writer per edge request (AUDITTRAIL-HIGH-004)', () => {
    it.each(publicServices)(
      '%s imports AccessLogModule.forRoot() so the factory can mount the access log',
      (svc) => {
        expect(stripComments(read(`apps/${svc}/src/app.module.ts`))).toMatch(
          /AccessLogModule\.forRoot\(\)/,
        );
      },
    );

    it.each(services)(
      '%s does not mount AccessLogMiddleware itself — the factory owns that mount',
      (svc) => {
        expect(stripComments(read(`apps/${svc}/src/app.module.ts`))).not.toMatch(
          /\bAccessLogMiddleware\b/,
        );
      },
    );

    it('shared.access_logs is bound to the retention kernel by entity, not by string (ADR-0012)', () => {
      const retention = read('apps/admin-api-service/src/retention/retention-bootstrap.module.ts');
      expect(retention).toMatch(/entity:\s*AccessLogEntity/);
      expect(retention).toMatch(/timestampProperty:\s*'createdAt'/);
      expect(retention).toMatch(/id:\s*'shared\.access_logs\.90d'/);
    });
  });

  describe('every service strips forged internal headers before reading user context (SEC-CRITICAL-002)', () => {
    it.each(services)(
      '%s mounts StripInternalHeadersMiddleware from the canonical barrel before UserContextMiddleware',
      (svc) => {
        const analysis = analyzeStripMount(svc);
        expect(analysis.hasImport).toBe(true);
        expect(analysis.importsFromCanonical).toBe(true);
        expect(analysis.hasApplyMount).toBe(true);
        expect(analysis.mountedBeforeUserContext).toBe(true);
      },
    );

    it('the canonical middleware lives at libs/backend-common/src/middleware', () => {
      expect(
        gitLsFiles(['libs/backend-common/src/middleware/strip-internal-headers.middleware.ts']),
      ).toEqual(['libs/backend-common/src/middleware/strip-internal-headers.middleware.ts']);
    });
  });

  describe('the dead CSRF layer stays deleted (AUTH-017)', () => {
    it('no service carries a CSRF middleware and no client reads an XSRF cookie', () => {
      expect(gitLsFiles(['apps/*/src/**/csrf.middleware.ts'])).toEqual([]);
      expect(
        gitGrepFiles(
          ['CsrfMiddleware', 'XSRF-TOKEN', 'X-CSRF-Token'],
          ['apps', 'libs', 'web', 'platform'],
        ),
      ).toEqual([]);
    });
  });
});
