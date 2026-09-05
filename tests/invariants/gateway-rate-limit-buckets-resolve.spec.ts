/**
 * Every gateway rate-limit bucket names something the gateway serves.
 *
 * `apps/gateway-api/src/config/rate-limit.config.ts` decides which requests
 * get the strict tiers (login, upload, marine-render). Until 2026-09-05 the
 * login tier was keyed on `/api/auth/login` and `/auth/login` — REST paths no
 * service registers — while authentication is the GraphQL `login` mutation.
 * The tier existed, was tested in isolation, and never fired on a real
 * request: brute-force protection on the platform's credential surface was
 * a config entry with no consumer (SEC-HIGH-061). The upload bucket named
 * `/api/files/upload`, which the gateway does not serve either.
 *
 * This spec derives the truth from the code that registers it: REST routes
 * from the gateway's own controllers (with the bootstrap global prefix and
 * its exclusions applied), GraphQL mutation fields from the auth-service
 * resolvers' `@Mutation` decorators. A bucket entry that resolves to nothing
 * fails the PR — the day it is written, not the day someone notices the
 * throttle never engaged.
 *
 * Finding: docs/reviews/admin-expert/2026-09-05-superadmin-audit.md#SEC-HIGH-061
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { buildGatewayEdgeConfig } from '../../apps/gateway-api/src/config/rate-limit.config';

const REPO_ROOT = resolve(__dirname, '..', '..');
const GATEWAY_SRC = join(REPO_ROOT, 'apps/gateway-api/src');
const AUTH_RESOLVERS = join(REPO_ROOT, 'apps/auth-service/src/modules/authentication/resolvers');
/** bootstrapService default (`create-service-app.ts`): gateway passes none. */
const GLOBAL_PREFIX = 'api/v1';

/**
 * `marine.routes.ts` pulls the kernel HTTP client at import time, which the
 * invariant runner does not resolve; its two exported constants are read from
 * source instead. The regex pins the declaration shape, so a rename fails here.
 */
function marineControllerPath(): string {
  const source = readFileSync(join(GATEWAY_SRC, 'routes/marine.routes.ts'), 'utf8');
  const match = /export const GATEWAY_MARINE_CONTROLLER_PATH = '([^']+)';/.exec(source);
  if (!match) throw new Error('GATEWAY_MARINE_CONTROLLER_PATH declaration not found');
  return match[1] as string;
}
const GATEWAY_MARINE_CONTROLLER_PATH = marineControllerPath();
/** Exclusions the gateway passes to bootstrapService in main.ts. */
const PREFIX_EXCLUSIONS = [
  'health',
  'health/(.*)',
  'metrics',
  GATEWAY_MARINE_CONTROLLER_PATH,
  `${GATEWAY_MARINE_CONTROLLER_PATH}/(.*)`,
];

function walk(dir: string, predicate: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, predicate, out);
    else if (predicate(entry)) out.push(full);
  }
  return out;
}

function normalize(path: string): string {
  return `/${path.replace(/^\/+|\/+$/g, '')}`.replace(/\/{2,}/g, '/') || '/';
}

function isExcludedFromPrefix(controllerPath: string): boolean {
  const bare = controllerPath.replace(/^\/+|\/+$/g, '');
  return PREFIX_EXCLUSIONS.some((exclusion) => {
    if (exclusion === bare) return true;
    if (exclusion.endsWith('/(.*)'))
      return bare.startsWith(`${exclusion.slice(0, -5)}/`) || bare === exclusion.slice(0, -5);
    return false;
  });
}

/** Every route the gateway registers, as path templates with `:param` segments. */
function gatewayRouteTemplates(): string[] {
  const templates: string[] = [];
  const CONTROLLER_RE = /@Controller\(\s*(?:'([^']*)'|([A-Z_][A-Z0-9_]*))?\s*\)/;
  const ROUTE_RE = /@(?:Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/g;
  for (const file of walk(
    GATEWAY_SRC,
    (name) => name.endsWith('.ts') && !name.endsWith('.spec.ts'),
  )) {
    const source = readFileSync(file, 'utf8');
    const controller = CONTROLLER_RE.exec(source);
    if (!controller) continue;
    const controllerPath =
      controller[1] ??
      (controller[2] === 'GATEWAY_MARINE_CONTROLLER_PATH' ? GATEWAY_MARINE_CONTROLLER_PATH : '');
    const prefix = isExcludedFromPrefix(controllerPath) ? '' : GLOBAL_PREFIX;
    for (const route of source.matchAll(ROUTE_RE)) {
      templates.push(normalize(`${prefix}/${controllerPath}/${route[1] ?? ''}`));
    }
  }
  return templates;
}

function templateMatches(candidate: string, template: string): boolean {
  const a = normalize(candidate).split('/');
  const b = normalize(template).split('/');
  if (a.length !== b.length) return false;
  return b.every((segment, index) =>
    segment.startsWith(':')
      ? a[index]?.startsWith(':') || (a[index] ?? '').length > 0
      : segment === a[index],
  );
}

/** Every `@Mutation` field name declared by the auth-service resolvers. */
function authMutationFields(): Set<string> {
  const fields = new Set<string>();
  const MUTATION_RE =
    /@Mutation\((?:[^()]|\([^()]*\))*\)\s*(?:@\w+\((?:[^()]|\([^()]*\))*\)\s*)*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
  for (const file of walk(AUTH_RESOLVERS, (name) => name.endsWith('.resolver.ts'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(MUTATION_RE)) {
      fields.add(match[1] as string);
    }
  }
  return fields;
}

class StubConfigService {
  get<T>(_key: string, fallback?: T): T | undefined {
    return fallback;
  }
}

describe('gateway rate-limit buckets resolve to registered routes and mutations (SEC-HIGH-061)', () => {
  const config = buildGatewayEdgeConfig(new StubConfigService() as never);
  const routes = gatewayRouteTemplates();
  const mutations = authMutationFields();

  it('derives a non-trivial route table and mutation set (the spec is not vacuous)', () => {
    expect(routes.length).toBeGreaterThan(3);
    expect(mutations.has('login')).toBe(true);
  });

  it('every bucket refers to a tier that exists', () => {
    for (const bucket of config.endpointBuckets) {
      expect(Object.keys(config.tiers)).toContain(bucket.tier);
    }
  });

  it.each(config.endpointBuckets.map((b) => [b.tier, b] as const))(
    '%s bucket: every path, template and mutation is served',
    (_tier, bucket) => {
      const unresolved: string[] = [];
      for (const path of bucket.paths) {
        if (!routes.some((template) => templateMatches(path, template)))
          unresolved.push(`path ${path}`);
      }
      for (const template of bucket.pathTemplates ?? []) {
        if (!routes.some((registered) => templateMatches(template, registered))) {
          unresolved.push(`template ${template}`);
        }
      }
      for (const field of bucket.graphqlMutations ?? []) {
        if (!mutations.has(field)) unresolved.push(`mutation ${field}`);
      }
      expect(unresolved).toEqual([]);
    },
  );

  it('would have refused the 2026-09-05 config: REST login paths no service registers', () => {
    // Negative control so the resolver cannot pass vacuously.
    for (const dead of ['/api/auth/login', '/auth/login', '/api/files/upload']) {
      expect(routes.some((template) => templateMatches(dead, template))).toBe(false);
    }
    expect(mutations.has('loginWithMagicLinkThatDoesNotExist')).toBe(false);
  });

  it('the login tier is keyed on the GraphQL login mutation, not on a path', () => {
    const login = config.endpointBuckets.find((bucket) => bucket.tier === 'login');
    expect(login).toBeDefined();
    expect(login?.graphqlMutations).toContain('login');
    expect(login?.paths).toEqual([]);
  });
});
