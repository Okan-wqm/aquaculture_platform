import { resolve } from 'node:path';

import ts from 'typescript';

import {
  adminNetworkAliases,
  assertSupportedAdminRoutePathSegment,
} from '../../platform/libs/admin-http-contracts/src/route-policy';
import {
  auditFrontendTransportFixtureProgram,
  assertConcreteAssignableType,
  assertConstContractDeclaration,
  assertNoSemanticRouteCollisions,
  assertNoRouteCoordinateOverrides,
  assertRequestRuntimeCoverage,
  auditReturnTypeOrigins,
  discoverPersistenceTypeSymbols,
  resolveAdminJsonDecoderDefinition,
} from '../../tools/codegen/admin-contracts/generate';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FIXTURE = resolve(
  REPO_ROOT,
  'tools/codegen/admin-contracts/fixtures/return-proof.fixture.ts',
);
const FRONTEND_TSCONFIG = resolve(REPO_ROOT, 'web/modules/admin-panel/tsconfig.json');
const FRONTEND_FIXTURES = [
  'tools/codegen/admin-contracts/fixtures/frontend/aliased-import.fixture.ts',
  'tools/codegen/admin-contracts/fixtures/frontend/namespace-import.fixture.ts',
  'tools/codegen/admin-contracts/fixtures/frontend/reexport.fixture.ts',
  'tools/codegen/admin-contracts/fixtures/frontend/local-shadow.fixture.ts',
  'tools/codegen/admin-contracts/fixtures/frontend/alternate-transports.fixture.ts',
  'tools/codegen/admin-contracts/fixtures/frontend/graphql-escape.fixture.ts',
] as const;

function fixtureAuthority(): {
  readonly checker: ts.TypeChecker;
  readonly persistenceTypes: ReturnType<typeof discoverPersistenceTypeSymbols>;
  readonly expected: ts.Type;
  readonly actual: (name: string) => ts.Type;
} {
  const program = ts.createProgram({
    rootNames: [FIXTURE],
    options: {
      strict: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      experimentalDecorators: true,
      skipLibCheck: true,
    },
  });
  expect(ts.getPreEmitDiagnostics(program)).toEqual([]);
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(FIXTURE);
  if (source === undefined) throw new Error('return proof fixture is outside the program');
  const moduleSymbol = checker.getSymbolAtLocation(source);
  if (moduleSymbol === undefined) throw new Error('return proof fixture has no module symbol');
  const exports = new Map(
    checker.getExportsOfModule(moduleSymbol).map((symbol) => [symbol.getName(), symbol]),
  );
  const expectedSymbol = exports.get('ExpectedRouteResponse');
  if (expectedSymbol === undefined) throw new Error('fixture expected type is absent');
  return {
    checker,
    persistenceTypes: discoverPersistenceTypeSymbols(program),
    expected: checker.getDeclaredTypeOfSymbol(expectedSymbol),
    actual: (name: string): ts.Type => {
      const symbol = exports.get(name);
      const declaration = symbol?.valueDeclaration;
      if (symbol === undefined || declaration === undefined) {
        throw new Error(`fixture function ${name} is absent`);
      }
      const signature = checker.getSignaturesOfType(
        checker.getTypeOfSymbolAtLocation(symbol, declaration),
        ts.SignatureKind.Call,
      )[0];
      if (signature === undefined) throw new Error(`${name} has no call signature`);
      const declared = checker.getReturnTypeOfSignature(signature);
      return checker.getAwaitedType(declared) ?? declared;
    },
  };
}

describe('admin contract compiler negative return-proof fixtures', () => {
  const authority = fixtureAuthority();

  it('accepts one concrete assignable response', () => {
    expect(() =>
      assertConcreteAssignableType(
        authority.actual('validRoute'),
        authority.expected,
        authority.checker,
        'validRoute',
      ),
    ).not.toThrow();
  });

  it.each([
    'anyRoute',
    'promiseAnyRoute',
    'unknownRoute',
    'genericRoute',
    'indexedRoute',
    'unionDriftRoute',
  ])('rejects %s instead of treating compiler uncertainty as proof', (name) => {
    expect(() =>
      assertConcreteAssignableType(
        authority.actual(name),
        authority.expected,
        authority.checker,
        name,
      ),
    ).toThrow();
  });

  it.each(['nestedAnyRoute', 'unknownIndexRoute', 'unsafeMethodRoute'])(
    'rejects unresolved authority nested inside %s',
    (name) => {
      const actual = authority.actual(name);
      expect(() => assertConcreteAssignableType(actual, actual, authority.checker, name)).toThrow(
        'contains any, unknown, or an unresolved generic/indexed type',
      );
    },
  );

  it('permits never only when the executable contract root is never', () => {
    const neverType = authority.actual('neverRoute');
    expect(() =>
      assertConcreteAssignableType(neverType, neverType, authority.checker, 'neverRoute'),
    ).toThrow('valid only for an executable never root contract');
    expect(() =>
      assertConcreteAssignableType(neverType, neverType, authority.checker, 'neverRoute', true),
    ).not.toThrow();
  });

  it.each([
    'directEntityRoute',
    'nestedEntityRoute',
    'arrayEntityRoute',
    'promiseEntityRoute',
    'viewEntityRoute',
    'childEntityRoute',
    'baseEntityRoute',
    'entitySchemaRoute',
    'entitySchemaTargetAliasRoute',
    'entitySchemaTargetReexportRoute',
  ])('rejects persistence provenance through %s', (name) => {
    const declared = authority.actual(name);
    const actual = authority.checker.getAwaitedType(declared) ?? declared;
    expect(() =>
      auditReturnTypeOrigins(actual, authority.checker, authority.persistenceTypes),
    ).toThrow('persistence entity origins');
  });
});

describe('admin contract compiler route and declaration fixtures', () => {
  it('rejects runtime-erased interface and Record bodies without the generated guard proof', () => {
    for (const metatype of ['erased', 'primitive'] as const) {
      expect(() =>
        assertRequestRuntimeCoverage(
          {
            metatype,
            declaredClassFieldCount: 0,
            classValidatorFieldCount: 0,
            generatedBoundaryDecoderInstalled: false,
          },
          `${metatype} fixture`,
        ),
      ).toThrow('no mandatory generated controller-boundary request decoder');
    }
  });

  it('rejects a class DTO whose runtime validation metadata does not cover every field', () => {
    expect(() =>
      assertRequestRuntimeCoverage(
        {
          metatype: 'class',
          declaredClassFieldCount: 2,
          classValidatorFieldCount: 1,
          generatedBoundaryDecoderInstalled: true,
        },
        'MissingMetadataDto',
      ),
    ).toThrow('validates 1/2 fields with class-validator metadata');
  });

  it('accepts erased and class metatypes only with their complete runtime proof', () => {
    expect(
      assertRequestRuntimeCoverage(
        {
          metatype: 'erased',
          declaredClassFieldCount: 0,
          classValidatorFieldCount: 0,
          generatedBoundaryDecoderInstalled: true,
        },
        'GeneratedInterfaceDto',
      ),
    ).toBe('GENERATED_DECODER');
    expect(
      assertRequestRuntimeCoverage(
        {
          metatype: 'class',
          declaredClassFieldCount: 2,
          classValidatorFieldCount: 2,
          generatedBoundaryDecoderInstalled: true,
        },
        'ValidatedClassDto',
      ),
    ).toBe('GENERATED_DECODER_AND_CLASS_VALIDATOR');
  });

  it('rejects unregistered JSON reasons instead of emitting a generic decoder', () => {
    expect(() => resolveAdminJsonDecoderDefinition('missing-reason')).toThrow(
      'has no registered V1 decoder',
    );
    expect(resolveAdminJsonDecoderDefinition('security-audit-context')).toEqual(
      expect.objectContaining({
        decoderId: 'admin-json.security-audit-context.v1',
        decoderVersion: 1,
        owner: 'platform.security-compliance',
      }),
    );
  });

  it('rejects matcher-equivalent parameter names and ALL overlaps', () => {
    expect(() =>
      assertNoSemanticRouteCollisions([
        { id: 'GET /x/:id', method: 'GET', path: '/x/:id' },
        { id: 'GET /x/:code', method: 'GET', path: '/x/:code' },
      ]),
    ).toThrow('semantic route collision');
    expect(() =>
      assertNoSemanticRouteCollisions([
        { id: 'ALL /x/:id', method: 'ALL', path: '/x/:id' },
        { id: 'POST /x/:code', method: 'POST', path: '/x/:code' },
      ]),
    ).toThrow('semantic route collision');
  });

  it('requires and emits static-before-parameter registration proof', () => {
    expect(
      assertNoSemanticRouteCollisions([
        {
          id: 'GET /x/stats',
          method: 'GET',
          path: '/x/stats',
          registrationOwner: 'fixture#Controller',
          registrationOrder: 10,
        },
        {
          id: 'GET /x/:id',
          method: 'GET',
          path: '/x/:id',
          registrationOwner: 'fixture#Controller',
          registrationOrder: 20,
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        specificRouteId: 'GET /x/stats',
        parameterRouteId: 'GET /x/:id',
        effectiveMethods: ['GET', 'HEAD'],
      }),
    ]);

    expect(() =>
      assertNoSemanticRouteCollisions([
        {
          id: 'GET /x/:id',
          method: 'GET',
          path: '/x/:id',
          registrationOwner: 'fixture#Controller',
          registrationOrder: 10,
        },
        {
          id: 'GET /x/stats',
          method: 'GET',
          path: '/x/stats',
          registrationOwner: 'fixture#Controller',
          registrationOrder: 20,
        },
      ]),
    ).toThrow('unproven route precedence');
  });

  it('models case-insensitive, ALL, and GET-to-HEAD method dominance', () => {
    expect(() =>
      assertNoSemanticRouteCollisions([
        { id: 'GET /x/Stats', method: 'GET', path: '/x/Stats' },
        { id: 'GET /x/stats', method: 'GET', path: '/x/stats' },
      ]),
    ).toThrow('semantic route collision');
    expect(() =>
      assertNoSemanticRouteCollisions([
        { id: 'GET /x/:id', method: 'GET', path: '/x/:id' },
        { id: 'HEAD /x/stats', method: 'HEAD', path: '/x/stats' },
      ]),
    ).toThrow('semantic route collision');
    expect(() =>
      assertNoSemanticRouteCollisions([
        { id: 'ALL /x/:id', method: 'ALL', path: '/x/:id' },
        { id: 'OPTIONS /x/stats', method: 'OPTIONS', path: '/x/stats' },
      ]),
    ).toThrow('semantic route collision');
  });

  it('rejects overlapping matchers whose specificity direction reverses', () => {
    expect(() =>
      assertNoSemanticRouteCollisions([
        {
          id: 'GET /foo/:id',
          method: 'GET',
          path: '/foo/:id',
          registrationOwner: 'fixture#Controller',
          registrationOrder: 10,
        },
        {
          id: 'GET /:scope/bar',
          method: 'GET',
          path: '/:scope/bar',
          registrationOwner: 'fixture#Controller',
          registrationOrder: 20,
        },
      ]),
    ).toThrow('semantic route collision');
  });

  it.each([':id?', ':id(\\d+)', '*', ':path*'])('rejects unsupported path syntax %s', (segment) => {
    expect(() => assertSupportedAdminRoutePathSegment(segment)).toThrow(
      'unsupported Nest route path segment',
    );
  });

  it('accepts const and rejects let as executable contract authorities', () => {
    const source = ts.createSourceFile(
      'contract-declaration.fixture.ts',
      'const stable = 1; let mutable = 1;',
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );
    const declarations: ts.VariableDeclaration[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node)) declarations.push(node);
      node.forEachChild(visit);
    };
    source.forEachChild(visit);

    expect(() => assertConstContractDeclaration(declarations[0]!)).not.toThrow();
    expect(() => assertConstContractDeclaration(declarations[1]!)).toThrow(
      'must be declared with const',
    );
  });

  it('rejects controller/method version and host-option overrides', () => {
    for (const input of [
      { controllerOptions: true, controllerVersion: false, methodVersion: false },
      { controllerOptions: false, controllerVersion: true, methodVersion: false },
      { controllerOptions: false, controllerVersion: false, methodVersion: true },
    ]) {
      expect(() => assertNoRouteCoordinateOverrides(input, 'fixture')).toThrow(
        'outside ADMIN_HTTP_ROUTE_POLICY',
      );
    }
  });

  it('derives neutral and v1 network aliases from one prefix policy', () => {
    expect(adminNetworkAliases('/tenants')).toEqual(['/api/tenants', '/api/v1/tenants']);
    expect(adminNetworkAliases('/health/ready')).toEqual(['/health/ready', '/v1/health/ready']);
  });
});

describe('admin frontend transport compiler negative fixtures', () => {
  it('fails closed across aliases, re-exports, browser transports, and GraphQL escapes', () => {
    const loaded = ts.readConfigFile(FRONTEND_TSCONFIG, ts.sys.readFile);
    expect(loaded.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(
      loaded.config,
      ts.sys,
      resolve(REPO_ROOT, 'web/modules/admin-panel'),
      { noEmit: true },
      FRONTEND_TSCONFIG,
    );
    expect(parsed.errors).toEqual([]);
    const roots = [
      'web/modules/admin-panel/src/services/http-client.ts',
      'web/modules/admin-panel/src/services/admin-graphql-client.ts',
      'web/modules/admin-panel/src/services/types/generated/admin-route-contracts.ts',
      'web/modules/admin-panel/src/generated/graphql.ts',
      ...FRONTEND_FIXTURES,
    ].map((file) => resolve(REPO_ROOT, file));
    const program = ts.createProgram({ rootNames: roots, options: parsed.options });
    const audit = auditFrontendTransportFixtureProgram(program, FRONTEND_FIXTURES);
    const reasons = audit.demands
      .map((demand) => demand.reason)
      .filter((reason): reason is string => reason !== undefined);

    for (const expected of [
      'forbids import aliases',
      'forbid namespace imports',
      'cannot be re-exported',
      'lacks transport-kernel symbol provenance',
      'forbidden transport module axios/internal',
      'dynamic loading of transport module axios',
      'sole direct transport-kernel call',
      'computed global fetch access is forbidden',
      'XMLHttpRequest is outside',
      'WebSocket is outside',
      'EventSource is outside',
      'navigator.sendBeacon is outside',
      'graphqlClient import is restricted',
      'bypasses generated admin GraphQL operation authority',
    ]) {
      expect(reasons.some((reason) => reason.includes(expected))).toBe(true);
    }
    expect(audit.rawFetchCallCount).toBe(1);
    expect(audit.rawFetchReferenceCount).toBe(1);
    expect(audit.graphqlKernelCallCount).toBe(1);
  });
});
