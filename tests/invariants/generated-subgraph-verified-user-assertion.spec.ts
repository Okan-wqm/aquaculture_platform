import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const ROUTER_SUBGRAPH_REGISTRY = 'infrastructure/apollo-router/subgraphs.json';
const GENERATED_GATEWAY_SUBGRAPHS = 'apps/gateway-api/src/config/federated-subgraphs.generated.ts';

interface RouterRegistry {
  subgraphs: ReadonlyArray<{
    name: string;
    nxProject: string;
  }>;
  excludedFederatedServices?: ReadonlyArray<{
    name: string;
    nxProject?: string;
  }>;
}

interface SubgraphAppModuleTarget {
  kind: 'active' | 'excluded';
  name: string;
  nxProject: string;
  path: string;
}

function readRouterRegistry(): RouterRegistry {
  return JSON.parse(
    readFileSync(resolve(REPO_ROOT, ROUTER_SUBGRAPH_REGISTRY), 'utf8'),
  ) as RouterRegistry;
}

function appModulePath(nxProject: string): string {
  return `apps/${nxProject}/src/app.module.ts`;
}

function activeSubgraphTargets(): SubgraphAppModuleTarget[] {
  return readRouterRegistry().subgraphs.map((subgraph) => ({
    kind: 'active',
    name: subgraph.name,
    nxProject: subgraph.nxProject,
    path: appModulePath(subgraph.nxProject),
  }));
}

function excludedFederatedServiceTargets(): SubgraphAppModuleTarget[] {
  return (readRouterRegistry().excludedFederatedServices ?? []).map((service) => {
    const nxProject = service.nxProject ?? service.name;
    return {
      kind: 'excluded',
      name: service.name,
      nxProject,
      path: appModulePath(nxProject),
    };
  });
}

function uniqueTargets(targets: ReadonlyArray<SubgraphAppModuleTarget>): SubgraphAppModuleTarget[] {
  const byProject = new Map<string, SubgraphAppModuleTarget>();
  for (const target of targets) {
    byProject.set(target.nxProject, target);
  }
  return [...byProject.values()];
}

const ACTIVE_SUBGRAPH_APP_MODULES = activeSubgraphTargets();
const FEDERATED_SERVICE_APP_MODULES = uniqueTargets([
  ...ACTIVE_SUBGRAPH_APP_MODULES,
  ...excludedFederatedServiceTargets(),
]);

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

function readModule(path: string): string {
  return stripComments(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
}

function generatedGatewayNxProjects(): string[] {
  const src = readFileSync(resolve(REPO_ROOT, GENERATED_GATEWAY_SUBGRAPHS), 'utf8');
  return [...src.matchAll(/\bnxProject:\s*['"]([^'"]+)['"]/g)].map((match) => match[1]!);
}

function indexAfterConfigure(src: string, token: string): number {
  const configureStart = src.indexOf('configure(consumer');
  if (configureStart === -1) {
    return -1;
  }
  return src.indexOf(token, configureStart);
}

function middlewareApplyOrder(src: string): string[] {
  const configureStart = src.indexOf('configure(consumer');
  if (configureStart === -1) {
    return [];
  }

  const applyStart = src.indexOf('.apply(', configureStart);
  const forRoutesStart = src.indexOf('.forRoutes', applyStart);
  if (applyStart === -1 || forRoutesStart === -1) {
    return [];
  }

  return src.slice(applyStart, forRoutesStart).match(/\b[A-Z][A-Za-z0-9]+Middleware\b/g) ?? [];
}

function gitTrackedFixtureFiles(): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', 'apps', 'tests', 'e2e'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((path) => path.length > 0 && existsSync(resolve(REPO_ROOT, path)));
}

function isAllowedRawUserPayloadReference(path: string): boolean {
  return (
    path === 'e2e/tests/security/header-spoofing.spec.ts' ||
    path === 'tests/invariants/generated-subgraph-verified-user-assertion.spec.ts' ||
    path === 'tests/invariants/strip-internal-headers-mounted.spec.ts'
  );
}

function isTrustedFixtureFile(path: string): boolean {
  if (isAllowedRawUserPayloadReference(path)) return false;
  if (!/\.(?:[cm]?[jt]sx?)$/.test(path)) return false;
  return (
    path.startsWith('tests/') ||
    path.startsWith('e2e/') ||
    path.includes('/test/') ||
    path.includes('/__tests__/') ||
    path.endsWith('.spec.ts') ||
    path.endsWith('.e2e-spec.ts')
  );
}

function rawUserPayloadFixtureLines(): string[] {
  return gitTrackedFixtureFiles()
    .filter(isTrustedFixtureFile)
    .flatMap((path) =>
      readFileSync(resolve(REPO_ROOT, path), 'utf8')
        .split('\n')
        .flatMap((line, index) =>
          line.includes('x-user-payload') ? [`${path}:${index + 1}: ${line.trim()}`] : [],
        ),
    );
}

describe('INVARIANT: generated subgraphs require verified user assertion before user context', () => {
  it('derives active subgraph app modules from the router registry and generated gateway config', () => {
    expect(ACTIVE_SUBGRAPH_APP_MODULES).not.toHaveLength(0);
    expect(ACTIVE_SUBGRAPH_APP_MODULES.map((target) => target.nxProject).sort()).toEqual(
      generatedGatewayNxProjects().sort(),
    );
    expect(
      ACTIVE_SUBGRAPH_APP_MODULES.map((target) => target.path).filter((path) =>
        existsSync(resolve(REPO_ROOT, path)),
      ),
    ).toHaveLength(ACTIVE_SUBGRAPH_APP_MODULES.length);
  });

  it('keeps ai-service covered while it is federation-capable but router-excluded', () => {
    expect(FEDERATED_SERVICE_APP_MODULES.map((target) => target.nxProject)).toContain('ai-service');
  });

  it.each(FEDERATED_SERVICE_APP_MODULES)(
    '$kind subgraph $name ($nxProject) wires the canonical auth context middleware order',
    ({ path }) => {
      const src = readModule(path);

      expect(src).toMatch(
        /import\s+\{[^}]*\bVerifiedUserAssertionMiddleware\b[^}]*\}\s+from\s+['"]@aquaculture\/backend-common\/middleware['"]/,
      );

      const stripIdx = indexAfterConfigure(src, 'StripInternalHeadersMiddleware');
      const assertionIdx = indexAfterConfigure(src, 'VerifiedUserAssertionMiddleware');
      const userIdx = indexAfterConfigure(src, 'UserContextMiddleware');
      const tenantIdx = indexAfterConfigure(src, 'TenantContextMiddleware');
      const requestContextIdx = indexAfterConfigure(src, 'RequestContextMiddleware');

      expect(stripIdx).toBeGreaterThanOrEqual(0);
      expect(assertionIdx).toBeGreaterThan(stripIdx);
      expect(userIdx).toBeGreaterThan(assertionIdx);
      expect(tenantIdx).toBeGreaterThan(userIdx);
      expect(requestContextIdx).toBeGreaterThan(tenantIdx);

      expect(middlewareApplyOrder(src).slice(0, 5)).toEqual([
        'StripInternalHeadersMiddleware',
        'VerifiedUserAssertionMiddleware',
        'UserContextMiddleware',
        'TenantContextMiddleware',
        'RequestContextMiddleware',
      ]);
    },
  );

  it('forbids service test fixtures from trusting raw x-user-payload headers', () => {
    expect(rawUserPayloadFixtureLines()).toEqual([]);
  });
});
