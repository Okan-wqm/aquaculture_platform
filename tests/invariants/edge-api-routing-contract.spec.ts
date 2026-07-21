/**
 * EDGE /api ROUTING CONTRACT — SSoT parity gate (APA-252 / APA-253).
 *
 * The frontend http-client base is '/api'. The rewrite that turns '/api/*' into
 * admin-api-service '/api/v1/*' used to live ONLY in infrastructure/nginx/
 * droplet.conf. infrastructure/docker/nginx/nginx.prod.conf routed '/api/' to
 * the `gateway` upstream — which has NO admin REST proxy (the ServiceProxyService
 * that pretended to was dead code, provided by no module) — so the entire admin
 * panel 404'd on the docker-compose.prod.yml stack. There was no parity gate
 * comparing the two production stacks' /api contracts.
 *
 * The fix extracts the whole /api edge contract into ONE shared fragment
 * (infrastructure/nginx/includes/api-routing.conf) that every stack `include`s.
 * This invariant is the tier-3 gate: it asserts, structurally from each stack's
 * compose nginx volume mounts outward, that the contract is unified — the
 * Docker-backed runtime proof (curl /api/users -> 401 from admin-api instead of
 * 404 from gateway-api) is recorded separately as it needs a live stack.
 *
 * It fails-RED on the pre-change tree (the fragment did not exist; nginx.prod.conf
 * routed /api/ -> gateway; the proxy dir existed; vite had no /api proxy) and
 * passes only once the shared fragment + includes are in place.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import yaml from 'js-yaml';

const REPO_ROOT = resolve(__dirname, '..', '..');

const FRAGMENT_REL = 'infrastructure/nginx/includes/api-routing.conf';
const FRAGMENT_INCLUDE = 'include /etc/nginx/includes/api-routing.conf;';

/** Compose stacks that front the web origin and ship the admin-panel remote. */
const STACKS = ['docker-compose.prod.yml', 'docker-compose.droplet.yml'] as const;

interface ComposeService {
  volumes?: unknown;
}
interface ComposeFile {
  services?: Record<string, ComposeService | null> | null;
}

interface Mount {
  host: string;
  target: string;
  raw: string;
}

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

function mountsOf(service: ComposeService): Mount[] {
  const vols = service.volumes;
  if (!Array.isArray(vols)) return [];
  const out: Mount[] = [];
  for (const entry of vols) {
    if (typeof entry !== 'string') continue;
    const parts = entry.split(':');
    const host = parts[0];
    const target = parts[1];
    if (host && target) out.push({ host, target, raw: entry });
  }
  return out;
}

/**
 * Resolve the host-side nginx *server* conf mounted into a stack's nginx
 * container — the file carrying the `server {}` block (and thus the /api
 * routing). Prefer the conf.d default (prod) over the main nginx.conf (droplet).
 */
function resolveNginxServerConf(composeRel: string): {
  hostRel: string;
  text: string;
  mounts: Mount[];
} {
  const compose = yaml.load(read(composeRel)) as ComposeFile | null;
  const nginx = compose?.services?.nginx;
  if (!nginx) {
    throw new Error(`${composeRel}: expected an 'nginx' service`);
  }
  const mounts = mountsOf(nginx);
  const byTarget = new Map(mounts.map((m) => [m.target, m.host]));
  const serverHost =
    byTarget.get('/etc/nginx/conf.d/default.conf') ?? byTarget.get('/etc/nginx/nginx.conf');
  if (!serverHost) {
    throw new Error(`${composeRel}: nginx service mounts no server conf`);
  }
  const hostRel = serverHost.replace(/^\.\//, '');
  return { hostRel, text: read(hostRel), mounts };
}

describe('edge /api routing contract (APA-252 / APA-253)', () => {
  describe('every stack fronting the web origin consumes the shared /api fragment', () => {
    it.each(STACKS)(
      '%s nginx server conf includes the shared fragment + mounts it read-only',
      (stack) => {
        const { text, mounts } = resolveNginxServerConf(stack);

        // (1) the mounted server conf `include`s the SSoT fragment
        expect(text).toContain(FRAGMENT_INCLUDE);

        // ... and the fragment's host directory is mounted read-only at the
        // include path so the include resolves at container runtime.
        const includesMount = mounts.find((m) => m.target === '/etc/nginx/includes');
        expect(includesMount).toBeDefined();
        expect(includesMount?.host).toContain('infrastructure/nginx/includes');
        expect(includesMount?.raw.endsWith(':ro')).toBe(true);
      },
    );
  });

  it('the shared fragment routes /api/* -> admin-api-service /api/v1/* with all carve-outs', () => {
    const frag = read(FRAGMENT_REL);

    // (2a) admin-api catch-all: rewrite ^/api/(.*) -> /api/v1/$1 to admin-api-service:3000
    expect(frag).toMatch(/location\s+\/api\/\s*\{/);
    expect(frag).toContain('rewrite ^/api/(.*) /api/v1/$1');
    expect(frag).toContain('set $api_backend_admin admin-api-service;');
    expect(frag).toContain('proxy_pass http://$api_backend_admin:3000;');

    // (2b) /api/health carve-out: VERSION_NEUTRAL, strips the /api prefix ->
    // admin-api HealthController (@Controller('health')), NOT /api/v1/health.
    expect(frag).toMatch(/location\s+\/api\/health\/\s*\{/);
    expect(frag).toContain('rewrite ^/api/(.*) /$1');
    expect(frag).toContain('set $api_backend_health admin-api-service;');

    // (2c) gateway carve-outs: /api/upload/, /api/v2/ai/, exact = /api/csp-report
    expect(frag).toMatch(/location\s+\/api\/upload\/\s*\{/);
    expect(frag).toMatch(/location\s+\/api\/v2\/ai\/\s*\{/);
    expect(frag).toMatch(/location\s*=\s*\/api\/csp-report\s*\{/);
    expect(frag).toContain('gateway-api');
  });

  it.each(STACKS)('%s does NOT route location /api/ to the gateway upstream', (stack) => {
    // (3) the abandoned "gateway is the REST proxy" contract must be gone: no
    // mounted conf may pair a `location /api/ {` with `proxy_pass http://gateway;`.
    const { text } = resolveNginxServerConf(stack);
    expect(text).not.toMatch(/location\s+\/api\/\s*\{[^}]*proxy_pass\s+http:\/\/gateway\s*;/);
  });

  it('the abandoned gateway REST-proxy directory no longer exists', () => {
    // (4) apps/gateway-api/src/proxy/ (ServiceProxyService + CircuitBreaker +
    // LoadBalancer) was dead code that made gateway-api look like a REST proxy.
    expect(existsSync(resolve(REPO_ROOT, 'apps/gateway-api/src/proxy'))).toBe(false);
  });

  it('web/shell/vite.config.ts declares a server.proxy /api entry with the /api/v1 rewrite', () => {
    // (5) `npm run dev:web` gets the SAME /api contract via a vite proxy so
    // '/api' stays the single FE-side constant (no VITE_ADMIN_API_URL).
    const vite = read('web/shell/vite.config.ts');
    expect(vite).toMatch(/proxy\s*:\s*\{/);
    expect(vite).toContain("'/api'");
    expect(vite).toContain('http://localhost:3008');
    expect(vite).toContain("replace(/^\\/api/, '/api/v1')");
  });
});
