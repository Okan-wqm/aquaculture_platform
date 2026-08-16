import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  canonicalWireJsonContentSha256V1,
  canonicalWireJsonStringifyV1,
  sha256Hex,
} from '../../libs/shared-contracts/src/canonical-json';
import { Role, isPlatformRole } from '../../libs/event-contracts/src/roles';
import { isTenantPermissionCode } from '../../libs/event-contracts/src/tenant-permissions';
import {
  HASH_LINKED_CANONICAL_WIRE_JSON_ALGORITHM_V1,
  hashLinkedCanonicalWireJsonSha256V1,
} from '../../tools/codegen/admin-contracts/hash-linked-canonical-json';

const REPO_ROOT = resolve(__dirname, '..', '..');
const RUNTIME_RELATIVE =
  'web/modules/admin-panel/src/services/types/generated/admin-route-contracts.ts';
const SERVER_REQUEST_RUNTIME_RELATIVE =
  'apps/admin-api-service/src/bootstrap/generated/admin-request-contracts.generated.ts';
const EVIDENCE_RELATIVE =
  'docs/evidence/admin-http-contracts/admin-route-contract-manifest.generated.json';
const RETIRED_V1_RELATIVE =
  'web/modules/admin-panel/src/services/types/generated/admin-contracts.ts';
const RUNTIME = resolve(REPO_ROOT, RUNTIME_RELATIVE);
const SERVER_REQUEST_RUNTIME = resolve(REPO_ROOT, SERVER_REQUEST_RUNTIME_RELATIVE);
const EVIDENCE = resolve(REPO_ROOT, EVIDENCE_RELATIVE);
const GENERATOR = resolve(REPO_ROOT, 'tools/codegen/admin-contracts/generate.ts');

interface AdminRouteAuthorizationV1 {
  readonly authentication: 'bearer-session' | 'public';
  readonly requiredRoles: readonly string[];
  readonly requiredPermissions: readonly string[];
  readonly permissionMode: 'all';
}

interface AdminRouteManifestV7 {
  readonly schemaVersion: string;
  readonly authority: string;
  readonly digestAlgorithm: string;
  readonly compilerGate: string;
  readonly artifacts: {
    readonly runtime: { readonly path: string; readonly projectionDigest: string };
    readonly serverRequestRuntime: {
      readonly path: string;
      readonly projectionDigest: string;
    };
    readonly evidence: { readonly path: string };
  };
  readonly runtimeProjection: {
    readonly schemaVersion: string;
    readonly routes: readonly {
      readonly id: string;
      readonly authorization: AdminRouteAuthorizationV1;
    }[];
  };
  readonly serverRequestRuntimeProjection: {
    readonly schemaVersion: string;
    readonly sqlIdentifierCatalogDigest: string;
    readonly lifecycleExceptions: readonly {
      readonly id: string;
      readonly lifecycle: 'INTERNAL_GATEWAY_ONLY';
    }[];
    readonly routes: readonly {
      readonly id: string;
      readonly authorization: AdminRouteAuthorizationV1;
      readonly request: unknown;
    }[];
  };
  readonly sqlIdentifierCatalog: {
    readonly schemaVersion: string;
    readonly entries: readonly {
      readonly routeId: string;
      readonly requestField: string;
      readonly defaultKey: string;
      readonly identifiers: Readonly<Record<string, string>>;
    }[];
    readonly catalogDigest: string;
  };
  readonly canonicalJsonAuthority: {
    readonly schemaVersion: 'admin-canonical-json-authority.v1';
    readonly declaration: 'libs/shared-contracts/src/canonical-json.ts';
    readonly calls: readonly {
      readonly symbol: 'canonicalWireJsonContentSha256V1' | 'canonicalWireJsonStringifyV1';
      readonly sourceFile: string;
      readonly sourceLine: number;
      readonly sourceColumn: number;
    }[];
    readonly consumerFiles: readonly string[];
    readonly callCount: number;
    readonly projectionDigest: string;
  };
  readonly schemalessJsonDecoderRegistry: {
    readonly schemaVersion: string;
    readonly entries: readonly {
      readonly reason: string;
      readonly decoderId: string;
      readonly decoderVersion: number;
      readonly owner: string;
      readonly rootPolicy: string;
      readonly codecPolicyId: string;
      readonly definitionDigest: string;
    }[];
    readonly registryDigest: string;
  };
  readonly summary: {
    readonly routeCount: number;
    readonly activeRouteCount: number;
    readonly internalGatewayOnlyRouteCount: number;
    readonly contractRouteCount: number;
    readonly bypassRouteCount: number;
    readonly namedProjectionCount: number;
    readonly frontendDemandCount: number;
    readonly governedFrontendDemandCount: number;
    readonly schemalessJsonBoundaryCount: number;
    readonly governedSchemalessJsonBoundaryCount: number;
    readonly unregisteredSchemalessJsonBoundaryCount: number;
    readonly violationCount: number;
    readonly duplicateRouteIds: readonly string[];
    readonly requestParameterCount: number;
    readonly generatedRequestDecoderCoverageCount: number;
    readonly runtimeClassRequestParameterCount: number;
    readonly runtimeErasedRequestParameterCount: number;
    readonly classValidatorCoveredRequestParameterCount: number;
    readonly sqlIdentifierRouteCount: number;
    readonly publicRouteCount: number;
    readonly platformAdminRouteCount: number;
    readonly canonicalJsonAuthorityCallCount: number;
    readonly canonicalJsonAuthorityConsumerCount: number;
  };
  readonly routes: readonly {
    readonly id: string;
    readonly lifecycle: 'ACTIVE' | 'INTERNAL_GATEWAY_ONLY';
    readonly authorization: AdminRouteAuthorizationV1;
    readonly request: {
      readonly runtimeProofs: readonly {
        readonly parameter: string;
        readonly section: 'body' | 'headers' | 'path' | 'query';
        readonly field: string | null;
        readonly metatype: 'class' | 'erased' | 'primitive';
        readonly declaredClassFieldCount: number;
        readonly classValidatorFieldCount: number;
        readonly coverage: 'GENERATED_DECODER' | 'GENERATED_DECODER_AND_CLASS_VALIDATOR';
      }[];
    };
    readonly response: {
      readonly mode: 'bypass' | 'contract';
      readonly returnDeclarationOrigins?: readonly string[];
      readonly schemalessJsonBoundaries?: readonly {
        readonly path: string;
        readonly reason: string;
        readonly decoderId: string;
        readonly decoderVersion: number;
        readonly owner: string;
        readonly rootPolicy: string;
        readonly codecPolicyId: string;
        readonly definitionDigest: string;
      }[];
    };
  }[];
  readonly namedProjections: readonly {
    readonly id: string;
    readonly schemaDigest: string;
  }[];
  readonly frontendDemands: readonly {
    readonly readiness: string;
    readonly routeId?: string;
  }[];
  readonly frontendTransport: {
    readonly rawFetchCallCount: number;
    readonly rawFetchReferenceCount: number;
    readonly graphql: { readonly kernelCallCount: number };
  };
  readonly manifestDigest: string;
}

function generatedSource(): string {
  return readFileSync(RUNTIME, 'utf8');
}

function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = resolve(directory, entry);
    if (statSync(absolute).isDirectory()) return sourceFilesBelow(absolute);
    return /\.(?:ts|tsx)$/.test(entry) ? [absolute] : [];
  });
}

function generatedEvidenceManifest(): AdminRouteManifestV7 {
  return JSON.parse(readFileSync(EVIDENCE, 'utf8')) as AdminRouteManifestV7;
}

describe('admin HTTP executable contract SSOT', () => {
  it('discovers compiler authorities without a hand-maintained route manifest', () => {
    const generator = readFileSync(GENERATOR, 'utf8');

    expect(existsSync(resolve(REPO_ROOT, 'tools/codegen/admin-contracts/manifest.ts'))).toBe(false);
    expect(generator).not.toContain('ADMIN_CONTRACT_SOURCES');
    expect(generator).toContain('program.getSourceFiles()');
  });

  it('commits a non-vacuous hash-linked canonical V7 authority', () => {
    const manifest = generatedEvidenceManifest();
    const { manifestDigest, ...core } = manifest;

    expect(manifest.schemaVersion).toBe('admin-route-contract-manifest.v7');
    expect(manifest.authority).toBe('executable-admin-http-contract-dag');
    expect(manifest.digestAlgorithm).toBe(HASH_LINKED_CANONICAL_WIRE_JSON_ALGORITHM_V1);
    expect(manifest.artifacts.runtime.path).toBe(RUNTIME_RELATIVE);
    expect(manifest.artifacts.serverRequestRuntime.path).toBe(SERVER_REQUEST_RUNTIME_RELATIVE);
    expect(manifest.artifacts.evidence.path).toBe(EVIDENCE_RELATIVE);
    expect(manifest.summary.routeCount).toBeGreaterThan(500);
    expect(manifest.summary.activeRouteCount).toBe(
      manifest.summary.routeCount - manifest.summary.internalGatewayOnlyRouteCount,
    );
    expect(manifest.summary.internalGatewayOnlyRouteCount).toBe(2);
    expect(manifest.summary.contractRouteCount).toBeGreaterThan(500);
    expect(manifest.summary.bypassRouteCount).toBeGreaterThan(0);
    expect(manifest.summary.namedProjectionCount).toBeGreaterThan(300);
    expect(manifest.summary.frontendDemandCount).toBe(manifest.frontendDemands.length);
    expect(manifest.summary.frontendDemandCount).toBeGreaterThan(0);
    expect(manifest.summary.governedFrontendDemandCount).toBe(manifest.summary.frontendDemandCount);
    expect(manifest.summary.violationCount).toBe(0);
    expect(manifest.summary.duplicateRouteIds).toEqual([]);
    expect(manifest.artifacts.runtime.projectionDigest).toBe(
      sha256Hex(
        `admin-route-runtime-projection.v4\0${canonicalWireJsonStringifyV1(manifest.runtimeProjection)}`,
      ),
    );
    expect(manifest.artifacts.serverRequestRuntime.projectionDigest).toBe(
      sha256Hex(
        `admin-server-route-runtime-projection.v3\0${canonicalWireJsonStringifyV1(
          manifest.serverRequestRuntimeProjection,
        )}`,
      ),
    );
    expect(manifestDigest).toBe(
      sha256Hex(`admin-route-contract-manifest.v7\0${hashLinkedCanonicalWireJsonSha256V1(core)}`),
    );
    expect(generatedSource()).toContain(manifest.artifacts.runtime.projectionDigest);
    expect(generatedSource()).not.toContain('ADMIN_ROUTE_CONTRACT_MANIFEST');
    expect(generatedSource()).not.toContain('controllerFile');
    const serverRequestSource = readFileSync(SERVER_REQUEST_RUNTIME, 'utf8');
    expect(serverRequestSource).toContain(manifest.artifacts.serverRequestRuntime.projectionDigest);
    expect(serverRequestSource).toContain('ADMIN_SERVER_REQUEST_CONTRACTS');
    expect(serverRequestSource).toContain('ADMIN_SERVER_ROUTE_AUTHORIZATION');
    expect(serverRequestSource).toContain('ADMIN_SERVER_ROUTE_LIFECYCLE');
    expect(serverRequestSource).not.toContain('controllerFile');
  });

  it('binds evidence, browser policy, and runtime guard input to one authorization projection', () => {
    const manifest = generatedEvidenceManifest();
    const evidence = manifest.routes.map((route) => ({
      id: route.id,
      authorization: route.authorization,
    }));
    const activeEvidence = manifest.routes
      .filter((route) => route.lifecycle === 'ACTIVE')
      .map((route) => ({ id: route.id, authorization: route.authorization }));
    const browser = manifest.runtimeProjection.routes.map((route) => ({
      id: route.id,
      authorization: route.authorization,
    }));
    const server = manifest.serverRequestRuntimeProjection.routes.map((route) => ({
      id: route.id,
      authorization: route.authorization,
    }));

    expect(manifest.runtimeProjection.schemaVersion).toBe('admin-route-runtime-projection.v4');
    expect(manifest.serverRequestRuntimeProjection.schemaVersion).toBe(
      'admin-server-route-runtime-projection.v3',
    );
    expect(browser).toEqual(activeEvidence);
    expect(server).toEqual(evidence);
    expect(manifest.summary.publicRouteCount).toBe(6);
    expect(manifest.summary.platformAdminRouteCount).toBe(
      manifest.summary.routeCount - manifest.summary.publicRouteCount,
    );

    for (const route of evidence) {
      expect(route.authorization.permissionMode).toBe('all');
      expect(route.authorization.requiredRoles.every(isPlatformRole)).toBe(true);
      expect(route.authorization.requiredPermissions.every(isTenantPermissionCode)).toBe(true);
      if (route.authorization.authentication === 'public') {
        expect(route.authorization.requiredRoles).toEqual([]);
        expect(route.authorization.requiredPermissions).toEqual([]);
      } else {
        expect(route.authorization.requiredRoles).toEqual([Role.SUPER_ADMIN]);
      }
    }
  });

  it('keeps non-active server routes out of every browser route authority', () => {
    const manifest = generatedEvidenceManifest();
    const browserRouteIds = new Set(manifest.runtimeProjection.routes.map((route) => route.id));
    const exceptions = manifest.serverRequestRuntimeProjection.lifecycleExceptions;
    const expectedExceptions = manifest.routes
      .filter((route) => route.lifecycle !== 'ACTIVE')
      .map((route) => ({ id: route.id, lifecycle: route.lifecycle }));

    expect(exceptions).toEqual(expectedExceptions);
    expect(exceptions.filter((route) => route.lifecycle === 'INTERNAL_GATEWAY_ONLY')).toHaveLength(
      2,
    );
    for (const route of exceptions) expect(browserRouteIds.has(route.id)).toBe(false);
    expect(manifest.routes.some((route) => route.id.includes('log-action'))).toBe(false);
    expect(manifest.routes.some((route) => route.id.includes('log-resource'))).toBe(false);
    expect(manifest.routes.some((route) => route.id.includes('validate-impersonation'))).toBe(
      false,
    );
  });

  it('proves complete generated runtime decoding and class-validator coverage', () => {
    const manifest = generatedEvidenceManifest();
    const proofs = manifest.routes.flatMap((route) => route.request.runtimeProofs);
    const classProofs = proofs.filter((proof) => proof.metatype === 'class');
    const erasedProofs = proofs.filter((proof) => proof.metatype === 'erased');

    expect(proofs.length).toBe(manifest.summary.requestParameterCount);
    expect(manifest.summary.generatedRequestDecoderCoverageCount).toBe(proofs.length);
    expect(classProofs.length).toBe(manifest.summary.runtimeClassRequestParameterCount);
    expect(erasedProofs.length).toBe(manifest.summary.runtimeErasedRequestParameterCount);
    expect(classProofs.length).toBeGreaterThan(0);
    expect(erasedProofs.length).toBeGreaterThan(0);
    expect(
      classProofs.filter((proof) => proof.coverage === 'GENERATED_DECODER_AND_CLASS_VALIDATOR')
        .length,
    ).toBe(manifest.summary.classValidatorCoveredRequestParameterCount);
    expect(
      classProofs.every(
        (proof) =>
          proof.declaredClassFieldCount > 0 &&
          proof.classValidatorFieldCount === proof.declaredClassFieldCount,
      ),
    ).toBe(true);
    expect(proofs.every((proof) => proof.coverage.startsWith('GENERATED_DECODER'))).toBe(true);
  });

  it('binds caller sort keys to one content-addressed fixed SQL identifier catalog', () => {
    const manifest = generatedEvidenceManifest();
    const { catalogDigest, ...projection } = manifest.sqlIdentifierCatalog;

    expect(projection.schemaVersion).toBe('sql-identifier-catalog.v1');
    expect(catalogDigest).toBe(
      sha256Hex(`sql-identifier-catalog.v1\0${canonicalWireJsonStringifyV1(projection)}`),
    );
    expect(manifest.serverRequestRuntimeProjection.sqlIdentifierCatalogDigest).toBe(catalogDigest);
    expect(manifest.summary.sqlIdentifierRouteCount).toBe(projection.entries.length);
    expect(projection.entries.map((entry) => entry.routeId)).toEqual([
      'GET /admin/tenants',
      'GET /system/errors/groups',
    ]);
    for (const entry of projection.entries) {
      const keys = Object.keys(entry.identifiers);
      const expressions = Object.values(entry.identifiers);
      expect(keys).toContain(entry.defaultKey);
      expect(new Set(keys).size).toBe(keys.length);
      expect(expressions.length).toBeGreaterThan(0);
      expect(expressions.every((value) => /^[A-Za-z_]\w*\.[A-Za-z_]\w*$/.test(value))).toBe(true);
    }
  });

  it('derives route identity only from stable Nest decorator metadata', () => {
    const guard = readFileSync(
      resolve(REPO_ROOT, 'apps/admin-api-service/src/bootstrap/admin-request-contract.guard.ts'),
      'utf8',
    );

    expect(guard).toContain('PATH_METADATA');
    expect(guard).toContain('METHOD_METADATA');
    expect(guard).not.toMatch(/get(?:Class|Handler)\(\)\.name/);
  });

  it('binds every schemaless leaf to one immutable versioned decoder coordinate', () => {
    const manifest = generatedEvidenceManifest();
    const { registryDigest, ...registryProjection } = manifest.schemalessJsonDecoderRegistry;
    const registryByReason = new Map(
      registryProjection.entries.map((entry) => [entry.reason, entry]),
    );
    const boundaries = manifest.routes.flatMap(
      (route) => route.response.schemalessJsonBoundaries ?? [],
    );

    expect(registryProjection.schemaVersion).toBe('admin-json-decoder-catalog.v1');
    expect(registryByReason.size).toBe(registryProjection.entries.length);
    expect(registryDigest).toBe(
      sha256Hex(
        `admin-json-decoder-registry.v1\0${canonicalWireJsonStringifyV1(registryProjection)}`,
      ),
    );
    for (const entry of registryProjection.entries) {
      const { definitionDigest, ...definition } = entry;
      expect(definitionDigest).toBe(
        sha256Hex(`admin-json-decoder-definition.v1\0${canonicalWireJsonStringifyV1(definition)}`),
      );
    }
    for (const boundary of boundaries) {
      const definition = registryByReason.get(boundary.reason);
      if (definition === undefined) {
        throw new Error(`unregistered manifest boundary reason: ${boundary.reason}`);
      }
      expect(boundary).toEqual(expect.objectContaining(definition));
    }
    expect(boundaries.length).toBe(manifest.summary.schemalessJsonBoundaryCount);
    expect(manifest.summary.governedSchemalessJsonBoundaryCount).toBe(boundaries.length);
    expect(manifest.summary.unregisteredSchemalessJsonBoundaryCount).toBe(0);
  });

  it('keeps the compiler result out of its self-referential digest and has no ungoverned demand', () => {
    const manifest = generatedEvidenceManifest();

    expect(manifest.compilerGate).toBe('typescript.getPreEmitDiagnostics');
    expect(manifest.summary).not.toHaveProperty('frontendCompilerDiagnosticCount');
    expect(manifest.frontendDemands.filter((demand) => demand.readiness !== 'GOVERNED')).toEqual(
      [],
    );
  });

  it('keeps persistence models outside response origins', () => {
    const manifest = generatedEvidenceManifest();
    const persistenceOrigins = manifest.routes.flatMap((route) =>
      (route.response.returnDeclarationOrigins ?? []).filter(
        (origin) =>
          origin.includes('/entities/') ||
          origin.includes('.entity.ts:') ||
          origin.startsWith('typeorm#') ||
          origin.startsWith('persistence-registry#'),
      ),
    );

    expect(persistenceOrigins).toEqual([]);
  });

  it('emits unique stable named-projection identities and one transport kernel per class', () => {
    const manifest = generatedEvidenceManifest();
    const projectionIds = manifest.namedProjections.map((projection) => projection.id);

    expect(new Set(projectionIds).size).toBe(projectionIds.length);
    expect(
      manifest.namedProjections.every((projection) =>
        /^[a-f0-9]{64}$/.test(projection.schemaDigest),
      ),
    ).toBe(true);
    expect(manifest.frontendTransport.rawFetchCallCount).toBe(1);
    expect(manifest.frontendTransport.rawFetchReferenceCount).toBe(1);
    expect(manifest.frontendTransport.graphql.kernelCallCount).toBe(1);
  });

  it('retires the V1 projection artifact after every facade moved to V2', () => {
    expect(existsSync(resolve(REPO_ROOT, RETIRED_V1_RELATIVE))).toBe(false);
    for (const facade of ['tenant.ts', 'audit.ts', 'reports.ts', 'security.ts']) {
      const source = readFileSync(
        resolve(REPO_ROOT, 'web/modules/admin-panel/src/services/types', facade),
        'utf8',
      );
      expect(source).toContain('./generated/admin-route-contracts');
      expect(source).not.toContain('./generated/admin-contracts');
    }
  });

  it('does not restore the retired pagination compatibility fallbacks', () => {
    const featureToggles = readFileSync(
      resolve(REPO_ROOT, 'web/modules/admin-panel/src/pages/system/FeatureTogglesPage.tsx'),
      'utf8',
    );
    const jobQueue = readFileSync(
      resolve(REPO_ROOT, 'web/modules/admin-panel/src/pages/system/JobQueuePage.tsx'),
      'utf8',
    );

    expect(featureToggles).not.toMatch(/Array\.isArray|safeToggles|response\.data/);
    expect(jobQueue).not.toMatch(/Array\.isArray|safeJobs|safeQueues|currentJobs|response\.data/);
  });

  it('uses one canonical JSON/hash authority for admin identities and evidence', () => {
    const manifest = generatedEvidenceManifest();
    const { projectionDigest, ...projection } = manifest.canonicalJsonAuthority;
    const fixture = {
      tenantId: 'tenant-1',
      quantities: { users: 5, farms: 2 },
      moduleIds: ['m2', 'm1'],
    };

    expect(canonicalWireJsonStringifyV1(fixture)).toBe(
      '{"moduleIds":["m2","m1"],"quantities":{"farms":2,"users":5},"tenantId":"tenant-1"}',
    );
    expect(canonicalWireJsonContentSha256V1(fixture)).toBe(
      'fd791f2c595b02070cb026cf491c321532e1626c7b7384d60ab698d3616d5ca1',
    );
    expect(projection.schemaVersion).toBe('admin-canonical-json-authority.v1');
    expect(projection.declaration).toBe('libs/shared-contracts/src/canonical-json.ts');
    expect(projection.callCount).toBe(projection.calls.length);
    expect(projection.consumerFiles).toEqual(
      [...new Set(projection.calls.map((call) => call.sourceFile))].sort(),
    );
    expect(projection.calls.length).toBeGreaterThan(0);
    expect(
      projection.calls.every(
        (call) =>
          call.sourceLine > 0 &&
          call.sourceColumn > 0 &&
          (call.symbol === 'canonicalWireJsonContentSha256V1' ||
            call.symbol === 'canonicalWireJsonStringifyV1'),
      ),
    ).toBe(true);
    expect(new Set(projection.calls.map((call) => JSON.stringify(call))).size).toBe(
      projection.calls.length,
    );
    expect(manifest.summary.canonicalJsonAuthorityCallCount).toBe(projection.callCount);
    expect(manifest.summary.canonicalJsonAuthorityConsumerCount).toBe(
      projection.consumerFiles.length,
    );
    expect(projectionDigest).toBe(
      sha256Hex(`admin-canonical-json-authority.v1\0${canonicalWireJsonStringifyV1(projection)}`),
    );
  });

  it('keeps browser navigation and download capabilities behind one audited owner', () => {
    const sourceRoot = resolve(REPO_ROOT, 'web/modules/admin-panel/src');
    const owner = resolve(sourceRoot, 'services/browser-capabilities.ts');
    const testsDirectory = `${resolve(sourceRoot, 'services/__tests__')}/`;
    const capabilityPattern =
      /window\.open\s*\(|window\.location\.(?:assign|replace|reload)\s*\(|(?:window\.)?URL\.(?:createObjectURL|revokeObjectURL)\s*\(|document\.createElement\(\s*['"]a['"]\s*\)|\.download\s*=/g;
    const violations = sourceFilesBelow(sourceRoot).flatMap((file) => {
      if (file === owner || file.startsWith(testsDirectory)) return [];
      const matches = readFileSync(file, 'utf8').match(capabilityPattern) ?? [];
      return matches.map((match) => `${file.slice(REPO_ROOT.length + 1)}: ${match}`);
    });

    expect(violations).toEqual([]);

    const directAnchors = sourceFilesBelow(sourceRoot).flatMap((file) => {
      if (file.startsWith(testsDirectory)) return [];
      const source = readFileSync(file, 'utf8');
      return source.match(/<a\b/g)?.map(() => file.slice(REPO_ROOT.length + 1)) ?? [];
    });
    expect(directAnchors).toEqual([]);

    const shellLayout = readFileSync(
      resolve(REPO_ROOT, 'web/shell/src/layouts/MainLayout.tsx'),
      'utf8',
    );
    expect(shellLayout).toContain('href="#main-content"');
    expect(shellLayout).toContain('id="main-content"');

    const formActions = sourceFilesBelow(sourceRoot).flatMap((file) => {
      const source = readFileSync(file, 'utf8');
      return source.match(/<form\b[^>]*\baction\s*=/gs)?.map(() => file) ?? [];
    });
    expect(formActions).toEqual([]);
  });
});
