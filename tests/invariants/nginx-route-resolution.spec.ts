/**
 * INVARIANT — nginx and the services it fronts agree on every path.
 *
 * # What went wrong
 *
 * `infrastructure/nginx/droplet.conf` and each service's route table were
 * written by hand, separately, and nothing compared them. On 2026-09-05 that
 * had produced, in production: `/api/upload/*` forwarded verbatim to a
 * gateway that serves uploads under `/api/v1/upload/*`; `/api/csp-report`
 * forwarded to a controller mounted at `/api/v1/api/csp-report`;
 * `/install/*` and `/api/devices/*` — the device-provisioning surface the
 * installer script and the Rust edge agent call — forwarded to a sensor
 * service that served them under `/api/v1/…`; `/api/v2/ai/*` forwarded to a
 * proxy that did not exist; and a gateway REST proxy (`api/v1/sensors`) that
 * no nginx location could reach. Every one of them returned 404 while every
 * unit test stayed green.
 *
 * # What this spec derives, from source, on every PR
 *
 *   1. The nginx location table: path, modifier, rewrite, upstream service
 *      (via the `set $var host; proxy_pass http://$var:port` pairs).
 *   2. Each public Nest service's served route table: `@Controller(...)` +
 *      method decorators, joined and placed under the service's global prefix
 *      unless a `prefixExclusions` pattern (resolved from main.ts, including
 *      spread constants) lifts the route out; `/graphql` when hasGraphQL.
 *
 * And asserts both directions:
 *   - FORWARD: every nginx location that proxies to a Nest service resolves
 *     (after its rewrite) to a route that service serves.
 *   - REVERSE: every route a public service serves OUTSIDE its prefix — the
 *     routes that exist to be reached directly — is covered by some nginx
 *     location, unless the kernel marks it Docker-internal (health, metrics)
 *     or `.claude/allowlists/internal-only-http-routes.yaml` does, with a
 *     reason.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as yaml from 'js-yaml';

import { getServiceCatalogEntry } from '../../platform/libs/service-catalog/src';

const REPO_ROOT = resolve(__dirname, '..', '..');
const NGINX_CONF = 'infrastructure/nginx/droplet.conf';
const ALLOWLIST = '.claude/allowlists/internal-only-http-routes.yaml';
const KERNEL_DEFAULT_PREFIX = 'api/v1';
const KERNEL_DEFAULT_EXCLUSIONS = ['health', 'health/(.*)', 'metrics'];

function read(rel: string): string {
  return readFileSync(resolve(REPO_ROOT, rel), 'utf8');
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

function gitFiles(pathspecs: string[]): string[] {
  return execFileSync(
    'git',
    ['-C', REPO_ROOT, 'ls-files', '--cached', '--others', '--exclude-standard', '--', ...pathspecs],
    {
      encoding: 'utf8',
    },
  )
    .split('\n')
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// nginx
// ---------------------------------------------------------------------------

interface NginxLocation {
  readonly modifier: '' | '=' | '^~';
  readonly path: string;
  readonly service: string | null;
  readonly rewrite: { from: RegExp; to: string } | null;
  /** URI part of proxy_pass, when nginx replaces the matched location with it. */
  readonly upstreamUri: string | null;
  readonly blocked: boolean;
}

function parseNginxLocations(conf: string): NginxLocation[] {
  const locations: NginxLocation[] = [];
  const stripped = conf.replace(/^\s*#.*$/gm, '');
  const open = /location\s+(=|\^~|~\*?)?\s*(\S+)\s*\{/g;
  for (const match of stripped.matchAll(open)) {
    const modifier = (match[1] ?? '') as NginxLocation['modifier'] | '~' | '~*';
    if (modifier === '~' || modifier === '~*') continue; // regex locations are not used for service routing here
    const path = match[2] as string;
    let depth = 1;
    let i = (match.index ?? 0) + match[0].length;
    const bodyStart = i;
    while (i < stripped.length && depth > 0) {
      if (stripped[i] === '{') depth += 1;
      else if (stripped[i] === '}') depth -= 1;
      i += 1;
    }
    const body = stripped.slice(bodyStart, i - 1);
    const vars = new Map<string, string>();
    for (const setMatch of body.matchAll(/set\s+\$(\w+)\s+([A-Za-z0-9_.-]+);/g)) {
      vars.set(setMatch[1] as string, setMatch[2] as string);
    }
    const proxy = /proxy_pass\s+https?:\/\/\$(\w+):\d+(\/\S*)?;/.exec(body);
    const rewriteMatch = /rewrite\s+(\S+)\s+(\S+)\s*(?:break|last|redirect|permanent)?;/.exec(body);
    const blocked = /\breturn\s+(403|404|410)\b/.test(body) || /\bdeny\s+all;/.test(body);
    locations.push({
      modifier,
      path,
      service: proxy ? (vars.get(proxy[1] as string) ?? null) : null,
      rewrite: rewriteMatch
        ? {
            from: new RegExp(rewriteMatch[1] as string),
            to: (rewriteMatch[2] as string).replace(/\$(\d)/g, '$$$1'),
          }
        : null,
      upstreamUri: proxy?.[2] ?? null,
      blocked,
    });
  }
  return locations;
}

/** The upstream path nginx sends for a request that hits `location` at exactly its path (plus `suffix`). */
function upstreamPath(location: NginxLocation, suffix: string): string {
  const request = location.path + suffix;
  if (location.upstreamUri) {
    return location.upstreamUri + request.slice(location.path.length);
  }
  if (location.rewrite) {
    return request.replace(location.rewrite.from, location.rewrite.to);
  }
  return request;
}

// ---------------------------------------------------------------------------
// Nest route tables
// ---------------------------------------------------------------------------

function segments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

function isWildcardSegment(segment: string): boolean {
  return (
    segment.startsWith(':') ||
    segment === '*' ||
    segment.startsWith('{*') ||
    segment === '(.*)' ||
    segment.includes('*')
  );
}

/** True when the served route pattern begins with every segment of `prefix`. */
function routeCoversPrefix(route: string[], prefix: string[]): boolean {
  for (let i = 0; i < prefix.length; i += 1) {
    const routeSegment = route[i];
    if (routeSegment === undefined) return false;
    if (isWildcardSegment(routeSegment)) {
      if (routeSegment.includes('*') && !routeSegment.startsWith(':')) return true; // catch-all consumes the rest
      continue;
    }
    if (routeSegment !== prefix[i]) return false;
  }
  return true;
}

/** True when a request path matches the served route pattern exactly. */
function routeMatchesExactly(route: string[], path: string[]): boolean {
  for (let i = 0; i < Math.max(route.length, path.length); i += 1) {
    const routeSegment = route[i];
    const pathSegment = path[i];
    if (routeSegment === undefined || pathSegment === undefined) return false;
    if (routeSegment.includes('*') && !routeSegment.startsWith(':')) return true;
    if (routeSegment.startsWith(':')) continue;
    if (routeSegment !== pathSegment) return false;
  }
  return true;
}

interface ServiceRoutes {
  readonly service: string;
  readonly prefix: string;
  /** Absolute served paths (leading slash), e.g. `/api/v1/upload/:id`. */
  readonly routes: ReadonlyArray<{ path: string; unprefixed: boolean; source: string }>;
}

/** Resolve `export const NAME = '...'` in the service tree. */
function resolveStringConst(service: string, name: string): string | null {
  for (const file of gitFiles([`apps/${service}/src`])) {
    if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue;
    const match = new RegExp(`export const ${name}\\s*=\\s*'([^']*)'`).exec(read(file));
    if (match) return match[1] as string;
  }
  return null;
}

/** Resolve `export const NAME = [ 'a', \`${CONST}/(.*)\` ] as const` into literal patterns. */
function resolveArrayConst(service: string, name: string): string[] {
  for (const file of gitFiles([`apps/${service}/src`])) {
    if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue;
    const match = new RegExp(`export const ${name}\\s*=\\s*\\[([\\s\\S]*?)\\]`).exec(
      stripComments(read(file)),
    );
    if (!match) continue;
    return resolveArrayElements(service, match[1] as string);
  }
  throw new Error(`${service}: cannot resolve array constant ${name}`);
}

function resolveArrayElements(service: string, body: string): string[] {
  const out: string[] = [];
  for (const element of body
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean)) {
    const literal = /^'([^']*)'$/.exec(element);
    if (literal) {
      out.push(literal[1] as string);
      continue;
    }
    const template = /^`([^`]*)`$/.exec(element);
    if (template) {
      out.push(
        (template[1] as string).replace(/\$\{(\w+)\}/g, (_m, constName: string) => {
          const value = resolveStringConst(service, constName);
          if (value === null) throw new Error(`${service}: cannot resolve ${constName}`);
          return value;
        }),
      );
      continue;
    }
    const spread = /^\.\.\.(\w+)$/.exec(element);
    if (spread) {
      out.push(...resolveArrayConst(service, spread[1] as string));
      continue;
    }
    const identifier = /^[A-Z_][A-Z0-9_]*$/.exec(element);
    if (identifier) {
      const value = resolveStringConst(service, element);
      if (value === null) throw new Error(`${service}: cannot resolve ${element}`);
      out.push(value);
      continue;
    }
    throw new Error(`${service}: unsupported prefixExclusions element ${element}`);
  }
  return out;
}

function exclusionRegex(pattern: string): RegExp {
  const source = pattern
    .split('/')
    .map((seg) =>
      seg === '(.*)' || seg.startsWith('{*') || seg === '*'
        ? '.*'
        : seg.startsWith(':')
          ? '[^/]+'
          : seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${source}$`);
}

function joinRoute(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter((p) => p.length > 0)
    .join('/');
}

function servedRoutes(service: string): ServiceRoutes {
  const main = stripComments(read(`apps/${service}/src/main.ts`));
  const prefix = /globalPrefix:\s*'([^']*)'/.exec(main)?.[1] ?? KERNEL_DEFAULT_PREFIX;
  const exclusionsMatch = /prefixExclusions:\s*\[([\s\S]*?)\]/.exec(main);
  const exclusionPatterns = exclusionsMatch
    ? resolveArrayElements(service, exclusionsMatch[1] as string)
    : KERNEL_DEFAULT_EXCLUSIONS;
  const exclusions = exclusionPatterns.map(exclusionRegex);
  const hasGraphQL = /hasGraphQL:\s*true/.test(main);

  const routes: Array<{ path: string; unprefixed: boolean; source: string }> = [];
  const place = (route: string, source: string): void => {
    const excluded = exclusions.some((re) => re.test(route));
    routes.push({
      path: '/' + (excluded ? route : joinRoute(prefix, route)),
      unprefixed: excluded,
      source,
    });
  };

  for (const file of gitFiles([`apps/${service}/src`])) {
    if (
      !file.endsWith('.ts') ||
      file.endsWith('.spec.ts') ||
      file.includes('/__tests__/') ||
      file.includes('/migrations/')
    )
      continue;
    const src = stripComments(read(file));
    const controllerDecorators = [
      ...src.matchAll(
        /@Controller\(\s*(?:'([^']*)'|\{\s*path:\s*'([^']*)'[^}]*\}|([A-Z_][A-Z0-9_]*))?\s*\)/g,
      ),
    ];
    for (let c = 0; c < controllerDecorators.length; c += 1) {
      const decorator = controllerDecorators[c] as RegExpMatchArray;
      let base = decorator[1] ?? decorator[2] ?? '';
      if (decorator[3]) {
        const value = resolveStringConst(service, decorator[3]);
        if (value === null)
          throw new Error(`${file}: cannot resolve controller path constant ${decorator[3]}`);
        base = value;
      }
      const start = (decorator.index ?? 0) + decorator[0].length;
      const next = controllerDecorators[c + 1];
      const body = src.slice(start, next?.index ?? src.length);
      for (const method of body.matchAll(
        /@(Get|Post|Put|Patch|Delete|All|Head|Options)\(\s*(?:'([^']*)'|\[([^\]]*)\])?\s*\)/g,
      )) {
        const subs = method[3]
          ? [...(method[3] as string).matchAll(/'([^']*)'/g)].map((m) => m[1] as string)
          : [method[2] ?? ''];
        for (const sub of subs) place(joinRoute(base, sub), `${file}#${method[1]}`);
      }
    }
  }
  if (hasGraphQL) {
    // A federated subgraph's /graphql is reached by gateway-api over the Docker
    // network (service catalog: gatewaySubgraph); only the supergraph's is an
    // internet surface.
    const subgraph = getServiceCatalogEntry(service)?.gatewaySubgraph !== undefined;
    routes.push({
      path: '/graphql',
      unprefixed: !subgraph,
      source: subgraph ? 'GraphQLModule (federated subgraph)' : 'GraphQLModule',
    });
  }
  // Socket.IO namespaces are served by @WebSocketGateway classes, not
  // controllers, on their engine.io `path` (default /socket.io/).
  for (const file of gitFiles([`apps/${service}/src`])) {
    if (!file.endsWith('.ts') || file.endsWith('.spec.ts')) continue;
    const src = stripComments(read(file));
    for (const gateway of src.matchAll(/@WebSocketGateway\(([\s\S]*?)\)\s*(?:@|export)/g)) {
      const path = /\bpath:\s*'([^']+)'/.exec(gateway[1] ?? '')?.[1] ?? '/socket.io/';
      routes.push({
        path: `${path.replace(/\/+$/, '')}/(.*)`,
        unprefixed: true,
        source: `${file} @WebSocketGateway`,
      });
    }
  }
  return { service, prefix, routes };
}

function nestServices(): Set<string> {
  return new Set(
    gitFiles(['apps/*/src/main.ts'])
      .map((path) => /^apps\/([^/]+)\/src\/main\.ts$/.exec(path)?.[1])
      .filter(
        (svc): svc is string =>
          svc !== undefined &&
          read(`apps/${svc}/src/main.ts`).includes('bootstrapService(AppModule'),
      ),
  );
}

// ---------------------------------------------------------------------------
// the invariant
// ---------------------------------------------------------------------------

interface AllowlistEntry {
  service: string;
  routePrefix: string;
  owner: string;
  reason: string;
}

describe('INVARIANT: nginx locations and service route tables agree in both directions', () => {
  const services = nestServices();
  const locations = parseNginxLocations(read(NGINX_CONF));
  const proxied = locations.filter(
    (l) => l.service !== null && services.has(l.service) && !l.blocked,
  );
  const publicServices = [...new Set(proxied.map((l) => l.service as string))].sort();
  const tables = new Map(publicServices.map((svc) => [svc, servedRoutes(svc)]));
  const allowlist = (yaml.load(read(ALLOWLIST)) as { entries?: AllowlistEntry[] }).entries ?? [];

  it('parses the topology (sanity)', () => {
    expect(publicServices.length).toBeGreaterThanOrEqual(2);
    expect(publicServices).toContain('gateway-api');
    for (const table of tables.values()) expect(table.routes.length).toBeGreaterThan(0);
  });

  it.each(proxied.map((l) => [l.modifier, l.path, l.service as string, l] as const))(
    'location %s%s → %s resolves to a served route',
    (_modifier, _path, service, location) => {
      const table = tables.get(service) as ServiceRoutes;
      if (location.modifier === '=') {
        const target = segments(upstreamPath(location, ''));
        const hit = table.routes.find((r) => routeMatchesExactly(segments(r.path), target));
        expect(hit ? `${hit.path} (${hit.source})` : null).not.toBeNull();
      } else {
        // A prefix location: some served route must live under the upstream prefix.
        const prefixSegments = segments(upstreamPath(location, ''));
        const hits = table.routes.filter((r) =>
          routeCoversPrefix(segments(r.path), prefixSegments),
        );
        expect(hits.map((r) => r.path)).not.toEqual([]);
      }
    },
  );

  it.each(publicServices)(
    '%s: every route served outside the prefix is reachable through nginx or declared Docker-internal',
    (service) => {
      const table = tables.get(service) as ServiceRoutes;
      const internal = [
        ...KERNEL_DEFAULT_EXCLUSIONS.map(exclusionRegex),
        ...allowlist
          .filter((e) => e.service === service)
          .map((e) => exclusionRegex(`${e.routePrefix}/(.*)`)),
        ...allowlist.filter((e) => e.service === service).map((e) => exclusionRegex(e.routePrefix)),
      ];
      const uncovered: string[] = [];
      for (const route of table.routes.filter((r) => r.unprefixed)) {
        const relative = route.path.replace(/^\//, '');
        if (internal.some((re) => re.test(relative))) continue;
        const routeSegments = segments(route.path);
        const covered = proxied
          .filter((l) => l.service === service)
          .some((l) => {
            const upstream = segments(upstreamPath(l, ''));
            return l.modifier === '='
              ? routeMatchesExactly(routeSegments, upstream)
              : routeCoversPrefix(routeSegments, upstream);
          });
        if (!covered) uncovered.push(`${route.path} (${route.source})`);
      }
      expect(uncovered).toEqual([]);
    },
  );

  it('every Docker-internal declaration names a public service, an owner and a reason', () => {
    for (const entry of allowlist) {
      expect(publicServices).toContain(entry.service);
      expect(entry.routePrefix).toMatch(/^[a-z0-9/_-]+$/);
      expect(entry.owner).toMatch(/\S/);
      expect(entry.reason).toMatch(/\S/);
    }
  });

  it('the nginx config exists and every proxied upstream is a bootstrapped Nest service or a static remote', () => {
    expect(existsSync(resolve(REPO_ROOT, NGINX_CONF))).toBe(true);
    for (const location of locations.filter((l) => l.service !== null && !l.blocked)) {
      const service = location.service as string;
      const isNest = services.has(service);
      const isStaticRemote =
        existsSync(resolve(REPO_ROOT, `web/modules/${service}`)) ||
        existsSync(resolve(REPO_ROOT, `web/${service}`)) ||
        existsSync(resolve(REPO_ROOT, `web/apps/${service}`));
      expect(isNest || isStaticRemote).toBe(true);
    }
  });
});
