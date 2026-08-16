/**
 * Admin HTTP route-contract compiler.
 *
 * The executable `@AdminResponseContract(...)` DAG is the sole response-shape
 * authority. This compiler inventories every Nest route by symbol provenance,
 * evaluates that closed DAG, verifies controller return assignability, and
 * emits content-addressed browser decoders plus a signed-by-content manifest.
 * Controller return annotations are checked, never used to invent a schema.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

import ts from 'typescript';

import {
  Role,
  isPlatformRole,
  type Role as RoleCode,
} from '../../../libs/event-contracts/src/roles';
import {
  isTenantPermissionCode,
  type TenantPermissionCode,
} from '../../../libs/event-contracts/src/tenant-permissions';

import {
  canonicalWireJsonStringifyV1,
  compareUtf16CodeUnits,
  sha256Hex,
} from '../../../libs/shared-contracts/src/canonical-json';
import {
  ADMIN_JSON_DECODER_CATALOG,
  type AdminJsonDecoderDefinitionV1,
} from '../../../platform/libs/admin-http-contracts/src/json-decoder-catalog';
import {
  ADMIN_HTTP_ROUTE_POLICY,
  ADMIN_RESERVED_REQUEST_HEADER_NAMES,
  adminLogicalRoutePathFromMetadata,
  adminNetworkAliases,
} from '../../../platform/libs/admin-http-contracts/src/route-policy';
import {
  ADMIN_SQL_IDENTIFIER_CATALOG,
  type SqlIdentifierCatalogEntryV1,
} from '../../../platform/libs/admin-http-contracts/src/sql-identifier-catalog';

import { ADMIN_SCHEMALESS_BOUNDARY_CATALOG } from './schemaless-boundary-catalog';
import {
  HASH_LINKED_CANONICAL_WIRE_JSON_ALGORITHM_V1,
  hashLinkedCanonicalWireJsonSha256V1,
} from './hash-linked-canonical-json';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const BACKEND_TSCONFIG = resolve(REPO_ROOT, 'apps/admin-api-service/tsconfig.app.json');
const FRONTEND_TSCONFIG = resolve(REPO_ROOT, 'web/modules/admin-panel/tsconfig.json');
const TOOLS_TSCONFIG = resolve(REPO_ROOT, 'tools/gates/tsconfig.json');
const CONTROLLER_ROOT = 'apps/admin-api-service/src';
const FRONTEND_ROOT = 'web/modules/admin-panel/src';
const FRONTEND_TRANSPORT_KERNEL = 'web/modules/admin-panel/src/services/http-client.ts';
const FRONTEND_GRAPHQL_KERNEL = 'web/modules/admin-panel/src/services/admin-graphql-client.ts';
const FRONTEND_GRAPHQL_GENERATED = 'web/modules/admin-panel/src/generated/graphql.ts';
const SHARED_UI_ENTRY = 'web/shared-ui/src/index.ts';
const GRAPHQL_SCHEMA_REGISTRY = 'infrastructure/apollo-router/codegen-schema.generated.json';
const RUNTIME_OUTPUT =
  'web/modules/admin-panel/src/services/types/generated/admin-route-contracts.ts';
const SERVER_REQUEST_RUNTIME_OUTPUT =
  'apps/admin-api-service/src/bootstrap/generated/admin-request-contracts.generated.ts';
const EVIDENCE_OUTPUT =
  'docs/evidence/admin-http-contracts/admin-route-contract-manifest.generated.json';
const ADMIN_DECORATOR_SUFFIX =
  '/apps/admin-api-service/src/shared/admin-response-contract.decorator.ts';
const ADMIN_CONTRACT_LIBRARY_SUFFIX = '/platform/libs/admin-http-contracts/src/index.ts';
const ADMIN_MANUAL_SENDER_SUFFIX =
  '/apps/admin-api-service/src/shared/admin-manual-response.sender.ts';
const ADMIN_ROUTE_POLICY_ADAPTER_SUFFIX =
  '/apps/admin-api-service/src/bootstrap/admin-http-route-policy.ts';
const ADMIN_ROUTE_POLICY_SUFFIX = '/platform/libs/admin-http-contracts/src/route-policy.ts';
const ADMIN_REQUEST_GUARD_SUFFIX =
  '/apps/admin-api-service/src/bootstrap/admin-request-contract.guard.ts';
const ADMIN_SERVER_REQUEST_RUNTIME_SUFFIX =
  '/apps/admin-api-service/src/bootstrap/generated/admin-request-contracts.generated.ts';

const SQL_IDENTIFIER_CONSUMER_ROUTES = Object.freeze({
  'apps/admin-api-service/src/system-management/services/error-tracking.service.ts':
    'GET /system/errors/groups',
  'apps/admin-api-service/src/tenant/query-handlers/tenant-query.handlers.ts': 'GET /admin/tenants',
} as const);

const NEST_HTTP_DECORATORS = new Map<string, AdminHttpMethod>([
  ['Get', 'GET'],
  ['Post', 'POST'],
  ['Put', 'PUT'],
  ['Patch', 'PATCH'],
  ['Delete', 'DELETE'],
  ['Head', 'HEAD'],
  ['Options', 'OPTIONS'],
  ['All', 'ALL'],
]);

const CONTRACT_BUILDERS = new Set([
  'array',
  'boolean',
  'dateString',
  'json',
  'literal',
  'literalSet',
  'never',
  'nullable',
  'number',
  'object',
  'optional',
  'page',
  'record',
  'string',
  'tuple',
  'union',
  'void',
]);

type AdminHttpMethod = 'ALL' | 'DELETE' | 'GET' | 'HEAD' | 'OPTIONS' | 'PATCH' | 'POST' | 'PUT';
type AdminRouteLifecycle = 'ACTIVE' | 'INTERNAL_GATEWAY_ONLY';

type JsonPrimitive = boolean | null | number | string;

type ContractNode =
  | { readonly kind: 'string' | 'number' | 'boolean' | 'date-string' | 'never' | 'void' }
  | ({ readonly kind: 'json' } & AdminJsonDecoderDefinitionV1)
  | { readonly kind: 'literal'; readonly value: JsonPrimitive }
  | { readonly kind: 'array' | 'page'; readonly item: ContractNode }
  | { readonly kind: 'optional' | 'nullable' | 'record'; readonly value: ContractNode }
  | { readonly kind: 'tuple'; readonly items: readonly ContractNode[] }
  | { readonly kind: 'union'; readonly variants: readonly ContractNode[] }
  | { readonly kind: 'object'; readonly fields: Readonly<Record<string, ContractNode>> };

interface EvaluatedContract {
  readonly name: string;
  readonly node: ContractNode;
  readonly sourceFile: string;
  readonly sourceLine: number;
  readonly expression: ts.Expression;
}

interface NamedProjection {
  readonly id: string;
  readonly name: string;
  readonly sourceFile: string;
  readonly sourceLine: number;
  readonly contract: EvaluatedContract;
  readonly schemaDigest: string;
}

interface ContractedResponse {
  readonly mode: 'contract';
  readonly transport: 'json-envelope';
  readonly contract: EvaluatedContract;
  readonly schemaDigest: string;
  readonly returnAssignable: true;
  readonly returnType: string;
  readonly returnDeclarationOrigins: readonly string[];
}

interface BypassResponse {
  readonly mode: 'bypass';
  readonly transport: 'binary-download' | 'frontend-external';
  readonly profile: EvaluatedManualProfile;
}

type ManualProfileNode =
  | {
      readonly kind: 'health-response';
      readonly transport: 'frontend-external';
      readonly statusCodes: readonly number[];
      readonly body: ContractNode;
    }
  | {
      readonly kind: 'binary-download';
      readonly transport: 'binary-download';
      readonly statusCodes: readonly number[];
      readonly mediaTypes: readonly string[];
      readonly maxBytes: number;
      readonly disposition: 'attachment-with-filename';
    };

interface EvaluatedManualProfile {
  readonly name: string;
  readonly node: ManualProfileNode;
  readonly sourceFile: string;
  readonly sourceLine: number;
}

interface RouteAuthority {
  readonly id: string;
  readonly method: AdminHttpMethod;
  readonly path: string;
  readonly networkAliases: readonly string[];
  readonly controllerFile: string;
  readonly controllerClass: string;
  readonly controllerMethod: string;
  readonly controllerLine: number;
  readonly successStatusCode: number;
  readonly lifecycle: AdminRouteLifecycle;
  readonly manualResponse?: {
    readonly mode: 'exclusive' | 'passthrough';
    readonly parameterName: string;
    readonly sourceLine: number;
  };
  readonly authorization: RouteAuthorizationAuthority;
  readonly request: RouteRequestAuthority;
  readonly response: ContractedResponse | BypassResponse;
}

interface RouteAuthorizationAuthority {
  readonly authentication: 'bearer-session' | 'public';
  readonly requiredRoles: readonly RoleCode[];
  readonly requiredPermissions: readonly TenantPermissionCode[];
  readonly permissionMode: 'all';
}

function routeMatcherCandidate(route: RouteAuthority, path = route.path): RouteMatcherCandidate {
  return {
    id: path === route.path ? route.id : `${route.id} -> ${path}`,
    method: route.method,
    path,
    registrationOwner: `${route.controllerFile}#${route.controllerClass}`,
    registrationOrder: route.controllerLine,
  };
}

interface RouteRequestAuthority {
  readonly path: ContractNode;
  readonly query: ContractNode;
  readonly queryCodecs: Readonly<Record<string, 'comma-separated' | 'repeated' | 'scalar'>>;
  readonly headers: ContractNode;
  readonly body: ContractNode;
  readonly contentType: 'application/json' | null;
  readonly ambientInputs: readonly ('current-user' | 'request-context' | 'response-writer')[];
  readonly schemaDigest: string;
  readonly schemalessBoundaryIds: readonly string[];
  readonly runtimeProofs: readonly RequestRuntimeProof[];
}

type RequestRuntimeMetatype = 'class' | 'erased' | 'primitive';

interface RequestRuntimeProof {
  readonly parameter: string;
  readonly section: 'body' | 'headers' | 'path' | 'query';
  readonly field: string | null;
  readonly metatype: RequestRuntimeMetatype;
  readonly declaredClassFieldCount: number;
  readonly classValidatorFieldCount: number;
  readonly coverage: 'GENERATED_DECODER' | 'GENERATED_DECODER_AND_CLASS_VALIDATOR';
}

interface FrontendDemand {
  readonly sourceFile: string;
  readonly sourceLine: number;
  readonly routeId?: string;
  readonly readiness:
    | 'GOVERNED'
    | 'GENERIC_TYPE_ARGUMENT'
    | 'ARBITRARY_REQUEST_SURFACE'
    | 'MISSING_ROUTE_AUTHORITY'
    | 'UNKNOWN_ROUTE_AUTHORITY'
    | 'NON_ACTIVE_ROUTE_AUTHORITY'
    | 'UNRESOLVED_ENDPOINT'
    | 'ROUTE_IDENTITY_MISMATCH'
    | 'MANUAL_PROFILE_ROUTE'
    | 'WRONG_TRANSPORT_AUTHORITY'
    | 'RAW_TRANSPORT_ESCAPE';
  readonly reason?: string;
}

interface FrontendGraphqlOperation {
  readonly documentName: string;
  readonly operationKind: 'mutation' | 'query' | 'subscription';
  readonly operationName: string;
  readonly operationDigest: string;
  readonly generatedSourceFile: string;
  readonly sourceFile: string;
  readonly sourceLine: number;
  readonly resultType: string;
  readonly variablesType: string;
}

interface SchemalessJsonBoundary {
  readonly path: string;
  readonly reason: string;
  readonly decoderId: string;
  readonly decoderVersion: 1;
  readonly owner: string;
  readonly rootPolicy: string;
  readonly codecPolicyId: string;
  readonly definitionDigest: string;
}

interface GeneratedArtifact {
  readonly runtimeContent: string;
  readonly serverRequestRuntimeContent: string;
  readonly evidenceContent: string;
  readonly runtimeProjectionDigest: string;
  readonly serverRequestRuntimeProjectionDigest: string;
  readonly manifestDigest: string;
  readonly violationCount: number;
  readonly routeCount: number;
  readonly contractRouteCount: number;
  readonly bypassRouteCount: number;
  readonly frontendDemandCount: number;
  readonly frontendCompilerDiagnosticCount: number;
  readonly frontendCompilerDiagnostics: string;
}

interface CanonicalJsonAuthorityCallV1 {
  readonly symbol: 'canonicalWireJsonContentSha256V1' | 'canonicalWireJsonStringifyV1';
  readonly sourceFile: string;
  readonly sourceLine: number;
  readonly sourceColumn: number;
}

interface CanonicalJsonAuthorityProjectionV1 {
  readonly schemaVersion: 'admin-canonical-json-authority.v1';
  readonly declaration: 'libs/shared-contracts/src/canonical-json.ts';
  readonly calls: readonly CanonicalJsonAuthorityCallV1[];
  readonly consumerFiles: readonly string[];
  readonly callCount: number;
  readonly projectionDigest: string;
}

export class ContractGenerationError extends Error {}

function requiredValue<T>(value: T | undefined, context: string): T {
  if (value === undefined) {
    throw new ContractGenerationError(`${context} is absent after structural validation`);
  }
  return value;
}

function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

function isNonArrayObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unknownProperty(target: object, key: PropertyKey): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined;
}

interface CompiledAdminJsonDecoderDefinition extends AdminJsonDecoderDefinitionV1 {
  readonly definitionDigest: string;
}

function adminJsonDecoderDefinitionDigest(definition: AdminJsonDecoderDefinitionV1): string {
  return fullHash(`admin-json-decoder-definition.v1\0${canonicalWireJsonStringifyV1(definition)}`);
}

const COMPILED_ADMIN_JSON_DECODERS: readonly CompiledAdminJsonDecoderDefinition[] =
  ADMIN_JSON_DECODER_CATALOG.entries.map((definition) => ({
    ...definition,
    definitionDigest: adminJsonDecoderDefinitionDigest(definition),
  }));

export function resolveAdminJsonDecoderDefinition(
  reason: string,
): CompiledAdminJsonDecoderDefinition {
  const definition = COMPILED_ADMIN_JSON_DECODERS.find((candidate) => candidate.reason === reason);
  if (definition === undefined) {
    throw new ContractGenerationError(
      `adminResponse.json reason ${JSON.stringify(reason)} has no registered V1 decoder`,
    );
  }
  return definition;
}

function adminJsonContractNode(reason: string): Extract<ContractNode, { readonly kind: 'json' }> {
  const definition = resolveAdminJsonDecoderDefinition(reason);
  return {
    kind: 'json',
    reason: definition.reason,
    decoderId: definition.decoderId,
    decoderVersion: definition.decoderVersion,
    owner: definition.owner,
    rootPolicy: definition.rootPolicy,
    codecPolicyId: definition.codecPolicyId,
  };
}

const ADMIN_JSON_DECODER_REGISTRY_PROJECTION = {
  schemaVersion: ADMIN_JSON_DECODER_CATALOG.schemaVersion,
  entries: COMPILED_ADMIN_JSON_DECODERS,
} as const;

const ADMIN_JSON_DECODER_REGISTRY_DIGEST = fullHash(
  `admin-json-decoder-registry.v1\0${canonicalWireJsonStringifyV1(
    ADMIN_JSON_DECODER_REGISTRY_PROJECTION,
  )}`,
);

function repoPath(fileName: string): string {
  return relative(REPO_ROOT, fileName).replaceAll('\\', '/');
}

function createBackendProgram(): ts.Program {
  const loaded = ts.readConfigFile(BACKEND_TSCONFIG, (file) => ts.sys.readFile(file));
  if (loaded.error !== undefined) {
    throw new ContractGenerationError(formatDiagnostics([loaded.error]));
  }
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(BACKEND_TSCONFIG),
    { noEmit: true },
    BACKEND_TSCONFIG,
  );
  if (parsed.errors.length > 0) {
    throw new ContractGenerationError(formatDiagnostics(parsed.errors));
  }
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) {
    throw new ContractGenerationError(
      `backend compiler diagnostics must be empty before contract emission:\n${formatDiagnostics(
        diagnostics,
      )}`,
    );
  }
  return program;
}

function createFrontendProgram(): ts.Program {
  const loaded = ts.readConfigFile(FRONTEND_TSCONFIG, (file) => ts.sys.readFile(file));
  if (loaded.error !== undefined) {
    throw new ContractGenerationError(formatDiagnostics([loaded.error]));
  }
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(FRONTEND_TSCONFIG),
    { noEmit: true },
    FRONTEND_TSCONFIG,
  );
  if (parsed.errors.length > 0) {
    throw new ContractGenerationError(formatDiagnostics(parsed.errors));
  }
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

function createToolsProgram(): ts.Program {
  const loaded = ts.readConfigFile(TOOLS_TSCONFIG, (file) => ts.sys.readFile(file));
  if (loaded.error !== undefined) {
    throw new ContractGenerationError(formatDiagnostics([loaded.error]));
  }
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(TOOLS_TSCONFIG),
    { noEmit: true },
    TOOLS_TSCONFIG,
  );
  if (parsed.errors.length > 0) {
    throw new ContractGenerationError(formatDiagnostics(parsed.errors));
  }
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnostics(diagnostics, {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: () => REPO_ROOT,
    getNewLine: () => '\n',
  });
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

function resolvedSymbol(
  symbol: ts.Symbol | undefined,
  checker: ts.TypeChecker,
): ts.Symbol | undefined {
  if (symbol === undefined) return undefined;
  return (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol;
}

const CANONICAL_JSON_DECLARATION = 'libs/shared-contracts/src/canonical-json.ts' as const;
const CANONICAL_JSON_SYMBOLS = new Set<CanonicalJsonAuthorityCallV1['symbol']>([
  'canonicalWireJsonContentSha256V1',
  'canonicalWireJsonStringifyV1',
]);
const CANONICAL_JSON_CENSUS_ROOTS = [
  'apps/admin-api-service/src/',
  'tools/codegen/admin-contracts/',
  'web/modules/admin-panel/src/',
] as const;

function canonicalJsonAuthorityProjection(
  programs: readonly ts.Program[],
): CanonicalJsonAuthorityProjectionV1 {
  const calls = new Map<string, CanonicalJsonAuthorityCallV1>();
  for (const program of programs) {
    const checker = program.getTypeChecker();
    for (const source of program.getSourceFiles()) {
      const sourceFile = repoPath(source.fileName);
      if (!CANONICAL_JSON_CENSUS_ROOTS.some((root) => sourceFile.startsWith(root))) continue;
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const syntacticName = ts.isIdentifier(node.expression)
            ? node.expression.text
            : ts.isPropertyAccessExpression(node.expression)
              ? node.expression.name.text
              : undefined;
          if (syntacticName && CANONICAL_JSON_SYMBOLS.has(syntacticName)) {
            const symbol = resolvedSymbol(checker.getSymbolAtLocation(node.expression), checker);
            const declarations = symbol?.declarations ?? [];
            const ownsCanonicalIdentity =
              symbol?.getName() === syntacticName &&
              declarations.some(
                (declaration) =>
                  repoPath(declaration.getSourceFile().fileName) === CANONICAL_JSON_DECLARATION,
              );
            if (!ownsCanonicalIdentity) {
              throw new ContractGenerationError(
                `${sourceFile}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1} ` +
                  `${syntacticName} lacks canonical symbol provenance`,
              );
            }
            const location = source.getLineAndCharacterOfPosition(node.getStart());
            const proof: CanonicalJsonAuthorityCallV1 = {
              symbol: syntacticName,
              sourceFile,
              sourceLine: location.line + 1,
              sourceColumn: location.character + 1,
            };
            calls.set(
              `${proof.sourceFile}\0${proof.sourceLine}\0${proof.sourceColumn}\0${proof.symbol}`,
              proof,
            );
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
  }
  const orderedCalls = [...calls.values()].sort(
    (left, right) =>
      compareUtf16CodeUnits(left.sourceFile, right.sourceFile) ||
      left.sourceLine - right.sourceLine ||
      left.sourceColumn - right.sourceColumn ||
      compareUtf16CodeUnits(left.symbol, right.symbol),
  );
  if (orderedCalls.length === 0) {
    throw new ContractGenerationError('admin canonical JSON authority census is empty');
  }
  const core = {
    schemaVersion: 'admin-canonical-json-authority.v1',
    declaration: CANONICAL_JSON_DECLARATION,
    calls: orderedCalls,
    consumerFiles: [...new Set(orderedCalls.map((call) => call.sourceFile))].sort(
      compareUtf16CodeUnits,
    ),
    callCount: orderedCalls.length,
  } as const;
  return Object.freeze({
    ...core,
    projectionDigest: fullHash(
      `admin-canonical-json-authority.v1\0${canonicalWireJsonStringifyV1(core)}`,
    ),
  });
}

function importDeclarationOf(node: ts.Node): ts.ImportDeclaration | undefined {
  let current: ts.Node | undefined = node;
  while (current !== undefined) {
    if (ts.isImportDeclaration(current)) return current;
    current = current.parent;
  }
  return undefined;
}

function importedName(
  expression: ts.LeftHandSideExpression,
  checker: ts.TypeChecker,
  moduleName: string,
): string | undefined {
  const location = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
  const symbol = checker.getSymbolAtLocation(location);
  for (const declaration of symbol?.declarations ?? []) {
    const importDeclaration = importDeclarationOf(declaration);
    if (
      importDeclaration === undefined ||
      !ts.isStringLiteral(importDeclaration.moduleSpecifier) ||
      importDeclaration.moduleSpecifier.text !== moduleName
    ) {
      continue;
    }
    if (ts.isImportSpecifier(declaration)) {
      return (declaration.propertyName ?? declaration.name).text;
    }
    if (ts.isPropertyAccessExpression(expression) && ts.isNamespaceImport(declaration)) {
      return expression.name.text;
    }
  }

  const target = resolvedSymbol(symbol, checker);
  const declarationFile = target?.declarations?.[0]?.getSourceFile().fileName;
  if (
    target !== undefined &&
    declarationFile !== undefined &&
    declarationFile.includes('/node_modules/@nestjs/common/')
  ) {
    return target.getName();
  }
  return undefined;
}

function functionDeclarationFor(symbol: ts.Symbol): ts.FunctionLikeDeclaration | undefined {
  for (const declaration of symbol.declarations ?? []) {
    if (
      ts.isFunctionDeclaration(declaration) ||
      ts.isMethodDeclaration(declaration) ||
      ts.isFunctionExpression(declaration) ||
      ts.isArrowFunction(declaration)
    ) {
      return declaration;
    }
    if (
      ts.isVariableDeclaration(declaration) &&
      declaration.initializer !== undefined &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer))
    ) {
      return declaration.initializer;
    }
  }
  return undefined;
}

function substitutedDecoratorArgument(
  expression: ts.Expression | undefined,
  declaration: ts.FunctionLikeDeclaration,
  invocation: ts.CallExpression,
): ts.Expression | undefined {
  if (expression === undefined || !ts.isIdentifier(expression)) return expression;
  const index = declaration.parameters.findIndex(
    (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === expression.text,
  );
  return index < 0 ? expression : invocation.arguments[index];
}

function literalPathExpression(
  expression: ts.Expression | undefined,
  source: ts.SourceFile,
): string {
  if (expression === undefined) return '';
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  const line = source.getLineAndCharacterOfPosition(expression.getStart(source)).line + 1;
  throw new ContractGenerationError(
    `${repoPath(source.fileName)}:${line} route decorators require a literal path`,
  );
}

interface ResolvedRouteDecorator {
  readonly method: AdminHttpMethod;
  readonly path: string;
}

function resolvedRouteDecorator(
  invocation: ts.CallExpression,
  checker: ts.TypeChecker,
  visited = new Set<ts.Symbol>(),
): ResolvedRouteDecorator | undefined {
  const nestName = importedName(invocation.expression, checker, '@nestjs/common');
  const directMethod = nestName === undefined ? undefined : NEST_HTTP_DECORATORS.get(nestName);
  if (directMethod !== undefined) {
    return {
      method: directMethod,
      path: literalPathExpression(invocation.arguments[0], invocation.getSourceFile()),
    };
  }

  const symbol = resolvedSymbol(
    checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(invocation.expression)
        ? invocation.expression.name
        : invocation.expression,
    ),
    checker,
  );
  if (symbol === undefined || visited.has(symbol)) return undefined;
  const declaration = functionDeclarationFor(symbol);
  if (declaration?.body === undefined) return undefined;

  const nextVisited = new Set(visited);
  nextVisited.add(symbol);
  const candidates: ResolvedRouteDecorator[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const directName = importedName(node.expression, checker, '@nestjs/common');
      const method = directName === undefined ? undefined : NEST_HTTP_DECORATORS.get(directName);
      if (method !== undefined) {
        candidates.push({
          method,
          path: literalPathExpression(
            substitutedDecoratorArgument(node.arguments[0], declaration, invocation),
            invocation.getSourceFile(),
          ),
        });
        return;
      }
      const nested = resolvedRouteDecorator(node, checker, nextVisited);
      if (nested !== undefined) candidates.push(nested);
    }
    node.forEachChild(visit);
  };
  declaration.body.forEachChild(visit);

  const identities = new Map(
    candidates.map((candidate) => [`${candidate.method} ${candidate.path}`, candidate]),
  );
  if (identities.size > 1) {
    throw new ContractGenerationError(
      `composed decorator ${symbol.getName()} contains multiple HTTP route mappings`,
    );
  }
  return identities.values().next().value;
}

function resolvedNestDecoratorCall(
  node: ts.Node,
  checker: ts.TypeChecker,
  exportName: string,
): ts.CallExpression | undefined {
  for (const decorator of decoratorsOf(node)) {
    if (
      ts.isCallExpression(decorator.expression) &&
      importedName(decorator.expression.expression, checker, '@nestjs/common') === exportName
    ) {
      return decorator.expression;
    }
  }
  return undefined;
}

function resolvedDecoratorSymbolName(node: ts.Node, checker: ts.TypeChecker): string | undefined {
  for (const decorator of decoratorsOf(node)) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    const expression = decorator.expression.expression;
    const location = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    const symbol = resolvedSymbol(checker.getSymbolAtLocation(location), checker);
    if (symbol !== undefined) return symbol.getName();
  }
  return undefined;
}

function hasCanonicalPublicDecorator(node: ts.Node, checker: ts.TypeChecker): boolean {
  for (const decorator of decoratorsOf(node)) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    const expression = decorator.expression.expression;
    const location = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    const symbol = resolvedSymbol(checker.getSymbolAtLocation(location), checker);
    if (symbol?.getName() !== 'Public') continue;
    if (
      (symbol.declarations ?? []).some((declaration) =>
        declaration
          .getSourceFile()
          .fileName.replaceAll('\\', '/')
          .endsWith('/libs/backend-common/src/decorators/roles.decorator.ts'),
      )
    ) {
      return true;
    }
  }
  return false;
}

function decoratorLiteralString(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  context: string,
): string {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  const type = checker.getTypeAtLocation(expression);
  if (type.isStringLiteral()) return type.value;
  throw new ContractGenerationError(`${context} authorization decorators require literal values`);
}

function authorizationDecoratorValues(
  node: ts.Node,
  checker: ts.TypeChecker,
  kind: 'permission' | 'role',
): readonly string[] | undefined {
  let values: readonly string[] | undefined;
  for (const decorator of decoratorsOf(node)) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    const invocation = decorator.expression;
    const location = ts.isPropertyAccessExpression(invocation.expression)
      ? invocation.expression.name
      : invocation.expression;
    const symbol = resolvedSymbol(checker.getSymbolAtLocation(location), checker);
    if (symbol === undefined) continue;
    const name = symbol.getName();
    const declarationFiles = (symbol.declarations ?? []).map((declaration) =>
      declaration.getSourceFile().fileName.replaceAll('\\', '/'),
    );
    const isRoleDecorator =
      kind === 'role' &&
      (name === 'Roles' || name === 'PlatformAdminOnly') &&
      declarationFiles.some((file) => file.endsWith('/decorators/roles.decorator.ts'));
    const isPermissionDecorator =
      kind === 'permission' &&
      name === 'RequireTenantPermission' &&
      declarationFiles.some((file) => file.endsWith('/decorators/require-permission.decorator.ts'));
    if (!isRoleDecorator && !isPermissionDecorator) continue;
    if (values !== undefined) {
      throw new ContractGenerationError('route declares duplicate authorization decorators');
    }
    const context = `${repoPath(node.getSourceFile().fileName)}:${
      node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1
    }`;
    values =
      name === 'PlatformAdminOnly'
        ? [Role.SUPER_ADMIN]
        : invocation.arguments.map((argument) =>
            decoratorLiteralString(argument, checker, context),
          );
  }
  return values;
}

function routeAuthorizationAuthority(
  controller: ts.ClassDeclaration,
  member: ts.MethodDeclaration,
  isPublic: boolean,
  checker: ts.TypeChecker,
): RouteAuthorizationAuthority {
  const declaredRoles =
    authorizationDecoratorValues(member, checker, 'role') ??
    authorizationDecoratorValues(controller, checker, 'role');
  const declaredPermissions =
    authorizationDecoratorValues(member, checker, 'permission') ??
    authorizationDecoratorValues(controller, checker, 'permission') ??
    [];
  const context = `${repoPath(member.getSourceFile().fileName)}#${member.name.getText()}`;
  if (isPublic) {
    if ((declaredRoles?.length ?? 0) > 0 || declaredPermissions.length > 0) {
      throw new ContractGenerationError(`${context} public route also declares authorization`);
    }
    return {
      authentication: 'public',
      requiredRoles: [],
      requiredPermissions: [],
      permissionMode: 'all',
    };
  }
  const roleValues = declaredRoles ?? [Role.SUPER_ADMIN];
  if (!roleValues.every(isPlatformRole)) {
    throw new ContractGenerationError(`${context} declares an unknown platform role`);
  }
  if (roleValues.some((role) => role !== Role.SUPER_ADMIN)) {
    throw new ContractGenerationError(`${context} widens the platform-admin boundary`);
  }
  if (!declaredPermissions.every(isTenantPermissionCode)) {
    throw new ContractGenerationError(`${context} declares an unknown tenant capability`);
  }
  const requiredRoles = [...new Set(roleValues)].sort(compareUtf16CodeUnits);
  const requiredPermissions = [...new Set(declaredPermissions)].sort(compareUtf16CodeUnits);
  if (requiredRoles.length === 0) {
    throw new ContractGenerationError(`${context} authenticated route declares no role`);
  }
  return {
    authentication: 'bearer-session',
    requiredRoles,
    requiredPermissions,
    permissionMode: 'all',
  };
}

function adminDecoratorCall(
  node: ts.Node,
  checker: ts.TypeChecker,
  exportName:
    | 'AdminManualResponse'
    | 'AdminQueryEncoding'
    | 'AdminResponseContract'
    | 'AdminRouteLifecycle',
): ts.CallExpression | undefined {
  for (const decorator of decoratorsOf(node)) {
    if (!ts.isCallExpression(decorator.expression)) continue;
    const expression = decorator.expression.expression;
    const location = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    const symbol = resolvedSymbol(checker.getSymbolAtLocation(location), checker);
    if (symbol?.getName() !== exportName) continue;
    if (
      (symbol.declarations ?? []).some((declaration) =>
        declaration.getSourceFile().fileName.replaceAll('\\', '/').endsWith(ADMIN_DECORATOR_SUFFIX),
      )
    ) {
      return decorator.expression;
    }
  }
  return undefined;
}

function routeLifecycleAuthority(
  member: ts.MethodDeclaration,
  checker: ts.TypeChecker,
  context: string,
): AdminRouteLifecycle {
  const call = adminDecoratorCall(member, checker, 'AdminRouteLifecycle');
  if (call === undefined) return 'ACTIVE';
  const argument = call.arguments[0];
  if (
    call.arguments.length !== 1 ||
    argument === undefined ||
    !ts.isStringLiteral(argument) ||
    !['ACTIVE', 'INTERNAL_GATEWAY_ONLY'].includes(argument.text)
  ) {
    throw new ContractGenerationError(`${context} declares an invalid route lifecycle`);
  }
  return argument.text === 'INTERNAL_GATEWAY_ONLY' ? 'INTERNAL_GATEWAY_ONLY' : 'ACTIVE';
}

export function canonicalMatcherPath(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? ':*' : segment.toLowerCase()))
    .join('/');
}

export interface RouteMatcherCandidate {
  readonly id: string;
  readonly method: AdminHttpMethod;
  readonly path: string;
  readonly registrationOwner?: string;
  readonly registrationOrder?: number;
}

export interface RouteMatcherOrderProof {
  readonly schemaVersion: 'admin-route-matcher-order-proof.v1';
  readonly registrationOwner: string;
  readonly specificRouteId: string;
  readonly specificOrder: number;
  readonly parameterRouteId: string;
  readonly parameterOrder: number;
  readonly effectiveMethods: readonly AdminHttpMethod[];
}

const CONCRETE_ADMIN_HTTP_METHODS = [
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
] as const satisfies readonly AdminHttpMethod[];

function effectiveRequestMethods(method: AdminHttpMethod): readonly AdminHttpMethod[] {
  if (method === 'ALL') return CONCRETE_ADMIN_HTTP_METHODS;
  if (method === 'GET') return ['GET', 'HEAD'];
  return [method];
}

function intersectingRequestMethods(
  left: AdminHttpMethod,
  right: AdminHttpMethod,
): readonly AdminHttpMethod[] {
  const rightMethods = new Set(effectiveRequestMethods(right));
  return effectiveRequestMethods(left).filter((method) => rightMethods.has(method));
}

interface OverlappingRouteMatchers {
  readonly equivalent: boolean;
  readonly incomparable: boolean;
  readonly specific?: 'left' | 'right';
}

function overlappingRouteMatchers(
  leftPath: string,
  rightPath: string,
): OverlappingRouteMatchers | undefined {
  const left = canonicalMatcherPath(leftPath).split('/').filter(Boolean);
  const right = canonicalMatcherPath(rightPath).split('/').filter(Boolean);
  if (left.length !== right.length) return undefined;
  const specificityDirections = new Set<'left' | 'right'>();
  for (let index = 0; index < left.length; index++) {
    const leftSegment = requiredValue(left[index], 'left route matcher segment');
    const rightSegment = requiredValue(right[index], 'right route matcher segment');
    const leftParameter = leftSegment === ':*';
    const rightParameter = rightSegment === ':*';
    if (!leftParameter && !rightParameter && leftSegment !== rightSegment) return undefined;
    if (leftParameter !== rightParameter) {
      specificityDirections.add(leftParameter ? 'right' : 'left');
    }
  }
  const specific =
    specificityDirections.size === 1 ? specificityDirections.values().next().value : undefined;
  return {
    equivalent: specificityDirections.size === 0,
    incomparable: specificityDirections.size > 1,
    specific,
  };
}

export function assertNoSemanticRouteCollisions(
  candidates: readonly RouteMatcherCandidate[],
): readonly RouteMatcherOrderProof[] {
  const proofs: RouteMatcherOrderProof[] = [];
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex++) {
    const left = requiredValue(candidates[leftIndex], 'left route matcher candidate');
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex++) {
      const right = requiredValue(candidates[rightIndex], 'right route matcher candidate');
      const effectiveMethods = intersectingRequestMethods(left.method, right.method);
      if (effectiveMethods.length === 0) continue;
      const overlap = overlappingRouteMatchers(left.path, right.path);
      if (overlap === undefined) continue;
      const matcher = `${canonicalMatcherPath(left.path)} <> ${canonicalMatcherPath(right.path)}`;
      if (
        overlap.equivalent ||
        overlap.incomparable ||
        left.method === 'ALL' ||
        right.method === 'ALL' ||
        left.method !== right.method
      ) {
        throw new ContractGenerationError(
          `semantic route collision [${effectiveMethods.join(',')}] ${matcher}: ` +
            `${left.id} and ${right.id}`,
        );
      }

      const specific = overlap.specific === 'left' ? left : right;
      const parameter = overlap.specific === 'left' ? right : left;
      if (
        specific.registrationOwner === undefined ||
        specific.registrationOwner !== parameter.registrationOwner ||
        specific.registrationOrder === undefined ||
        parameter.registrationOrder === undefined ||
        specific.registrationOrder >= parameter.registrationOrder
      ) {
        throw new ContractGenerationError(
          `unproven route precedence [${effectiveMethods.join(',')}] ${matcher}: ` +
            `${specific.id} must register before ${parameter.id} in one controller`,
        );
      }
      proofs.push({
        schemaVersion: 'admin-route-matcher-order-proof.v1',
        registrationOwner: specific.registrationOwner,
        specificRouteId: specific.id,
        specificOrder: specific.registrationOrder,
        parameterRouteId: parameter.id,
        parameterOrder: parameter.registrationOrder,
        effectiveMethods,
      });
    }
  }
  return Object.freeze(
    proofs.sort((left, right) =>
      compareUtf16CodeUnits(
        `${left.specificRouteId}\0${left.parameterRouteId}`,
        `${right.specificRouteId}\0${right.parameterRouteId}`,
      ),
    ),
  );
}

function manualResponseAuthority(
  member: ts.MethodDeclaration,
  checker: ts.TypeChecker,
): RouteAuthority['manualResponse'] {
  let authority: RouteAuthority['manualResponse'];
  for (const parameter of member.parameters) {
    const responseDecorator = resolvedNestDecoratorCall(parameter, checker, 'Res');
    if (responseDecorator === undefined) continue;
    if (authority !== undefined) {
      throw new ContractGenerationError('route declares more than one @Res response authority');
    }
    let mode: 'exclusive' | 'passthrough';
    if (responseDecorator.arguments.length === 0) {
      mode = 'exclusive';
    } else {
      const options = responseDecorator.arguments[0];
      const passthroughProperty =
        options !== undefined && ts.isObjectLiteralExpression(options)
          ? options.properties[0]
          : undefined;
      if (
        responseDecorator.arguments.length !== 1 ||
        options === undefined ||
        !ts.isObjectLiteralExpression(options) ||
        options.properties.length !== 1 ||
        passthroughProperty === undefined ||
        !ts.isPropertyAssignment(passthroughProperty) ||
        passthroughProperty.name.getText() !== 'passthrough' ||
        passthroughProperty.initializer.kind !== ts.SyntaxKind.TrueKeyword
      ) {
        throw new ContractGenerationError(
          `${repoPath(member.getSourceFile().fileName)} @Res options must be exactly { passthrough: true }`,
        );
      }
      mode = 'passthrough';
    }
    authority = {
      mode,
      parameterName: parameter.name.getText(),
      sourceLine:
        member.getSourceFile().getLineAndCharacterOfPosition(parameter.getStart()).line + 1,
    };
  }
  return authority;
}

function assertGovernedManualSender(
  member: ts.MethodDeclaration,
  checker: ts.TypeChecker,
  manualResponse: NonNullable<RouteAuthority['manualResponse']>,
  profileExpression: ts.Expression,
  profileKind: ManualProfileNode['kind'],
): void {
  const responseParameter = member.parameters.find(
    (parameter) => parameter.name.getText() === manualResponse.parameterName,
  );
  if (responseParameter === undefined || !ts.isIdentifier(responseParameter.name)) {
    throw new ContractGenerationError('manual response parameter must be a simple identifier');
  }
  const responseSymbol = checker.getSymbolAtLocation(responseParameter.name);
  const profileLocation = ts.isPropertyAccessExpression(profileExpression)
    ? profileExpression.name
    : profileExpression;
  const expectedProfileSymbol = resolvedSymbol(
    checker.getSymbolAtLocation(profileLocation),
    checker,
  );
  const expectedSender =
    profileKind === 'binary-download' ? 'sendAdminBinaryResponse' : 'sendAdminHealthResponse';
  let governedCalls = 0;
  const allowedResponseUses = new Set<ts.Identifier>();
  const allowedProfileUses = new Set<ts.Identifier>();
  const discoverSender = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const location = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name
        : node.expression;
      const senderSymbol = resolvedSymbol(checker.getSymbolAtLocation(location), checker);
      const senderOwned = (senderSymbol?.declarations ?? []).some((declaration) =>
        declaration
          .getSourceFile()
          .fileName.replaceAll('\\', '/')
          .endsWith(ADMIN_MANUAL_SENDER_SUFFIX),
      );
      if (senderOwned) {
        if (senderSymbol?.getName() !== expectedSender) {
          throw new ContractGenerationError(
            `${repoPath(member.getSourceFile().fileName)}#${member.name.getText()} uses ${senderSymbol?.getName()} with ${profileKind}`,
          );
        }
        const responseArgument = node.arguments[0];
        const profileArgument = node.arguments[1];
        const profileArgumentLocation =
          profileArgument !== undefined && ts.isPropertyAccessExpression(profileArgument)
            ? profileArgument.name
            : profileArgument;
        if (
          responseArgument === undefined ||
          !ts.isIdentifier(responseArgument) ||
          checker.getSymbolAtLocation(responseArgument) !== responseSymbol ||
          profileArgumentLocation === undefined ||
          !ts.isIdentifier(profileArgumentLocation) ||
          resolvedSymbol(checker.getSymbolAtLocation(profileArgumentLocation), checker) !==
            expectedProfileSymbol
        ) {
          throw new ContractGenerationError(
            `${repoPath(member.getSourceFile().fileName)}#${member.name.getText()} sender arguments do not match its @Res parameter and decorator profile`,
          );
        }
        allowedResponseUses.add(responseArgument);
        allowedProfileUses.add(profileArgumentLocation);
        governedCalls++;
      }
    }
    node.forEachChild(discoverSender);
  };
  member.body?.forEachChild(discoverSender);
  if (governedCalls !== 1) {
    throw new ContractGenerationError(
      `${repoPath(member.getSourceFile().fileName)}#${member.name.getText()} must call ${expectedSender} exactly once; found ${governedCalls}`,
    );
  }
  const assertExclusiveCapabilityUse = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && !ts.isTypeNode(node.parent)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (
        symbol === responseSymbol &&
        node !== responseParameter.name &&
        !allowedResponseUses.has(node)
      ) {
        throw new ContractGenerationError(
          `${repoPath(member.getSourceFile().fileName)}#${member.name.getText()} uses @Res outside the exact governed sender argument`,
        );
      }
      if (
        resolvedSymbol(symbol, checker) === expectedProfileSymbol &&
        !allowedProfileUses.has(node)
      ) {
        throw new ContractGenerationError(
          `${repoPath(member.getSourceFile().fileName)}#${member.name.getText()} uses its manual profile outside the exact governed sender argument`,
        );
      }
    }
    node.forEachChild(assertExclusiveCapabilityUse);
  };
  member.body?.forEachChild(assertExclusiveCapabilityUse);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  if (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    return unwrapExpression(expression.expression);
  }
  return expression;
}

function propertyNameText(name: ts.PropertyName, source: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  throw new ContractGenerationError(
    `${repoPath(source.fileName)} response fields require a static property name`,
  );
}

function jsonLiteral(expression: ts.Expression): JsonPrimitive {
  const value = unwrapExpression(expression);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (
    ts.isPrefixUnaryExpression(value) &&
    value.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(value.operand)
  ) {
    return -Number(value.operand.text);
  }
  throw new ContractGenerationError(
    `${repoPath(value.getSourceFile().fileName)}:${
      value.getSourceFile().getLineAndCharacterOfPosition(value.getStart()).line + 1
    } literal contract requires an inline JSON primitive`,
  );
}

export function assertConstContractDeclaration(declaration: ts.VariableDeclaration): void {
  if (
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0
  ) {
    throw new ContractGenerationError(
      `${repoPath(declaration.getSourceFile().fileName)}:${
        declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart()).line + 1
      } executable response contract ${declaration.name.getText()} must be declared with const`,
    );
  }
}

class ContractDagEvaluator {
  private readonly cache = new Map<ts.Symbol, ContractNode>();
  private readonly visiting = new Set<ts.Symbol>();

  constructor(private readonly checker: ts.TypeChecker) {}

  evaluateRoot(expression: ts.Expression): EvaluatedContract {
    const root = unwrapExpression(expression);
    const symbol = this.symbolForReference(root);
    if (symbol === undefined) {
      throw new ContractGenerationError(
        `${repoPath(root.getSourceFile().fileName)}:${
          root.getSourceFile().getLineAndCharacterOfPosition(root.getStart()).line + 1
        } @AdminResponseContract requires a repository-owned const contract`,
      );
    }
    const declaration = this.variableDeclaration(symbol);
    const source = declaration.getSourceFile();
    const node = this.evaluateSymbol(symbol);
    if (node.kind === 'json') {
      throw new ContractGenerationError(
        `${repoPath(source.fileName)}:${
          source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1
        } root schemaless JSON is forbidden; place the closed JSON boundary inside a named object, array, or record field`,
      );
    }
    return {
      name: symbol.getName(),
      node,
      sourceFile: repoPath(source.fileName),
      sourceLine: source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1,
      expression,
    };
  }

  evaluateManualProfile(expression: ts.Expression): EvaluatedManualProfile {
    const root = unwrapExpression(expression);
    const symbol = this.symbolForReference(root);
    if (symbol === undefined) {
      throw new ContractGenerationError(
        '@AdminManualResponse requires a repository-owned const executable profile',
      );
    }
    const declaration = this.variableDeclaration(symbol);
    const initializer = unwrapExpression(declaration.initializer);
    if (
      !ts.isCallExpression(initializer) ||
      !ts.isPropertyAccessExpression(initializer.expression) ||
      !this.isPlatformBuilderAuthority(initializer.expression.expression, 'adminManualResponse')
    ) {
      throw new ContractGenerationError(
        `${symbol.getName()} must use the closed adminManualResponse builders`,
      );
    }
    const builder = initializer.expression.name.text;
    const arrayLiterals = (argument: ts.Expression | undefined, label: string): JsonPrimitive[] => {
      const value = argument === undefined ? undefined : unwrapExpression(argument);
      if (value === undefined || !ts.isArrayLiteralExpression(value)) {
        throw new ContractGenerationError(`${symbol.getName()} ${label} must be an inline array`);
      }
      return value.elements.map((entry) => jsonLiteral(entry));
    };
    const statuses = arrayLiterals(initializer.arguments[0], 'status codes');
    const numericStatuses = statuses.map((status) => {
      if (typeof status !== 'number') {
        throw new ContractGenerationError(
          `${symbol.getName()} status codes must be numeric literals`,
        );
      }
      return status;
    });
    let node: ManualProfileNode;
    if (builder === 'health' && initializer.arguments.length === 2) {
      const body = this.evaluateExpression(
        requiredValue(initializer.arguments[1], `${symbol.getName()} health body`),
      );
      if (body.kind === 'json') {
        throw new ContractGenerationError(
          `${symbol.getName()} health profile cannot use a root schemaless body`,
        );
      }
      node = {
        kind: 'health-response',
        transport: 'frontend-external',
        statusCodes: numericStatuses,
        body,
      };
    } else if (builder === 'binary' && initializer.arguments.length === 3) {
      const mediaTypes = arrayLiterals(initializer.arguments[1], 'media types');
      const stringMediaTypes = mediaTypes.map((mediaType) => {
        if (typeof mediaType !== 'string') {
          throw new ContractGenerationError(
            `${symbol.getName()} media types must be string literals`,
          );
        }
        return mediaType;
      });
      const maxBytes = this.jsonPrimitiveConstant(
        requiredValue(initializer.arguments[2], `${symbol.getName()} binary maximum bytes`),
      );
      if (typeof maxBytes !== 'number' || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
        throw new ContractGenerationError(
          `${symbol.getName()} maxBytes must be a positive inline integer literal`,
        );
      }
      node = {
        kind: 'binary-download',
        transport: 'binary-download',
        statusCodes: numericStatuses,
        mediaTypes: stringMediaTypes,
        maxBytes,
        disposition: 'attachment-with-filename',
      };
    } else {
      throw new ContractGenerationError(
        `${symbol.getName()} uses unsupported adminManualResponse.${builder} arity`,
      );
    }
    const source = declaration.getSourceFile();
    return {
      name: symbol.getName(),
      node,
      sourceFile: repoPath(source.fileName),
      sourceLine: source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1,
    };
  }

  private symbolForReference(expression: ts.Expression): ts.Symbol | undefined {
    if (!ts.isIdentifier(expression) && !ts.isPropertyAccessExpression(expression))
      return undefined;
    const location = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
    return resolvedSymbol(this.checker.getSymbolAtLocation(location), this.checker);
  }

  private jsonPrimitiveConstant(
    expression: ts.Expression,
    visiting: Set<ts.Symbol> = new Set<ts.Symbol>(),
  ): JsonPrimitive {
    const value = unwrapExpression(expression);
    const symbol = this.symbolForReference(value);
    if (symbol === undefined) return this.jsonPrimitiveLiteral(value);
    if (visiting.has(symbol)) {
      throw new ContractGenerationError(`cyclic JSON primitive authority ${symbol.getName()}`);
    }
    const declaration = this.variableDeclaration(symbol);
    assertConstContractDeclaration(declaration);
    visiting.add(symbol);
    try {
      return this.jsonPrimitiveConstant(declaration.initializer, visiting);
    } finally {
      visiting.delete(symbol);
    }
  }

  private jsonPrimitiveLiteral(expression: ts.Expression): JsonPrimitive {
    const value = unwrapExpression(expression);
    if (
      ts.isStringLiteral(value) ||
      ts.isNoSubstitutionTemplateLiteral(value) ||
      ts.isNumericLiteral(value) ||
      value.kind === ts.SyntaxKind.TrueKeyword ||
      value.kind === ts.SyntaxKind.FalseKeyword ||
      value.kind === ts.SyntaxKind.NullKeyword ||
      ts.isPrefixUnaryExpression(value)
    ) {
      return jsonLiteral(value);
    }

    const type = this.checker.getTypeAtLocation(value);
    if (type.isStringLiteral() || type.isNumberLiteral()) return type.value;
    if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
      return this.checker.typeToString(type) === 'true';
    }
    return jsonLiteral(value);
  }

  private variableDeclaration(
    symbol: ts.Symbol,
  ): ts.VariableDeclaration & { readonly initializer: ts.Expression } {
    const declaration = (symbol.declarations ?? []).find(
      (candidate): candidate is ts.VariableDeclaration & { readonly initializer: ts.Expression } =>
        ts.isVariableDeclaration(candidate) && candidate.initializer !== undefined,
    );
    if (declaration === undefined) {
      throw new ContractGenerationError(`${symbol.getName()} is not an initialized const contract`);
    }
    assertConstContractDeclaration(declaration);
    return declaration;
  }

  private evaluateSymbol(symbol: ts.Symbol): ContractNode {
    const cached = this.cache.get(symbol);
    if (cached !== undefined) return cached;
    if (this.visiting.has(symbol)) {
      throw new ContractGenerationError(`response contract cycle reaches ${symbol.getName()}`);
    }
    this.visiting.add(symbol);
    const declaration = this.variableDeclaration(symbol);
    const node = this.evaluateExpression(declaration.initializer);
    this.visiting.delete(symbol);
    this.cache.set(symbol, node);
    return node;
  }

  private evaluateExpression(expression: ts.Expression): ContractNode {
    const value = unwrapExpression(expression);
    const reference = this.symbolForReference(value);
    if (reference !== undefined && !ts.isCallExpression(value)) {
      return this.evaluateSymbol(reference);
    }
    if (!ts.isCallExpression(value) || !ts.isPropertyAccessExpression(value.expression)) {
      throw new ContractGenerationError(
        `${repoPath(value.getSourceFile().fileName)}:${
          value.getSourceFile().getLineAndCharacterOfPosition(value.getStart()).line + 1
        } contract nodes must use the closed adminResponse builders`,
      );
    }

    const builder = value.expression.name.text;
    if (
      !CONTRACT_BUILDERS.has(builder) ||
      !this.isPlatformBuilderAuthority(value.expression.expression, 'adminResponse')
    ) {
      throw new ContractGenerationError(
        `${repoPath(value.getSourceFile().fileName)}:${
          value.getSourceFile().getLineAndCharacterOfPosition(value.getStart()).line + 1
        } contract builder lacks @platform/admin-http-contracts provenance`,
      );
    }

    const args = value.arguments;
    switch (builder) {
      case 'string':
      case 'number':
      case 'boolean':
      case 'never':
      case 'void':
        this.requireArity(builder, args, 0, value);
        return { kind: builder };
      case 'dateString':
        this.requireArity(builder, args, 0, value);
        return { kind: 'date-string' };
      case 'json': {
        this.requireArity(builder, args, 1, value);
        const reason = this.jsonPrimitiveLiteral(requiredValue(args[0], `${builder} argument`));
        if (typeof reason !== 'string') {
          throw new ContractGenerationError('adminResponse.json reason must be a string literal');
        }
        return adminJsonContractNode(reason);
      }
      case 'literal':
        this.requireArity(builder, args, 1, value);
        return {
          kind: 'literal',
          value: this.jsonPrimitiveLiteral(requiredValue(args[0], `${builder} argument`)),
        };
      case 'literalSet': {
        this.requireArity(builder, args, 1, value);
        const argument = unwrapExpression(requiredValue(args[0], `${builder} argument`));
        const reference = this.symbolForReference(argument);
        const initializer =
          reference === undefined
            ? argument
            : unwrapExpression(this.variableDeclaration(reference).initializer);
        const frozenInitializer = unwrapExpression(initializer);
        const list =
          ts.isCallExpression(frozenInitializer) &&
          ts.isPropertyAccessExpression(frozenInitializer.expression) &&
          ts.isIdentifier(frozenInitializer.expression.expression) &&
          frozenInitializer.expression.expression.text === 'Object' &&
          frozenInitializer.expression.name.text === 'freeze' &&
          frozenInitializer.arguments.length === 1 &&
          frozenInitializer.arguments[0] !== undefined
            ? unwrapExpression(frozenInitializer.arguments[0])
            : frozenInitializer;
        let literalEntries: readonly ts.Expression[] = [];
        let derivedObjectKeyValues: readonly JsonPrimitive[] | undefined;
        if (ts.isArrayLiteralExpression(list)) {
          literalEntries = list.elements;
        } else if (
          ts.isCallExpression(list) &&
          ts.isPropertyAccessExpression(list.expression) &&
          ts.isIdentifier(list.expression.expression) &&
          list.expression.expression.text === 'Object' &&
          list.expression.name.text === 'values' &&
          list.arguments.length === 1 &&
          list.arguments[0] !== undefined
        ) {
          const objectArgument = unwrapExpression(list.arguments[0]);
          const objectReference = this.symbolForReference(objectArgument);
          if (objectReference === undefined) {
            throw new ContractGenerationError(
              'adminResponse.literalSet Object.values requires a const object authority',
            );
          }
          let objectInitializer = unwrapExpression(
            this.variableDeclaration(objectReference).initializer,
          );
          if (
            ts.isCallExpression(objectInitializer) &&
            ts.isPropertyAccessExpression(objectInitializer.expression) &&
            ts.isIdentifier(objectInitializer.expression.expression) &&
            objectInitializer.expression.expression.text === 'Object' &&
            objectInitializer.expression.name.text === 'freeze' &&
            objectInitializer.arguments.length === 1 &&
            objectInitializer.arguments[0] !== undefined
          ) {
            objectInitializer = unwrapExpression(objectInitializer.arguments[0]);
          }
          if (!ts.isObjectLiteralExpression(objectInitializer)) {
            throw new ContractGenerationError(
              'adminResponse.literalSet Object.values requires a const object literal authority',
            );
          }
          literalEntries = objectInitializer.properties.map((property) => {
            if (!ts.isPropertyAssignment(property)) {
              throw new ContractGenerationError(
                'adminResponse.literalSet Object.values forbids computed or spread members',
              );
            }
            return property.initializer;
          });
        } else if (
          ts.isCallExpression(list) &&
          ts.isPropertyAccessExpression(list.expression) &&
          ts.isIdentifier(list.expression.expression) &&
          list.expression.expression.text === 'Object' &&
          list.expression.name.text === 'keys' &&
          list.arguments.length === 1 &&
          list.arguments[0] !== undefined
        ) {
          const objectArgument = unwrapExpression(list.arguments[0]);
          const objectReference = this.symbolForReference(objectArgument);
          if (objectReference === undefined) {
            throw new ContractGenerationError(
              'adminResponse.literalSet Object.keys requires a const object authority',
            );
          }
          let objectInitializer = unwrapExpression(
            this.variableDeclaration(objectReference).initializer,
          );
          if (
            ts.isCallExpression(objectInitializer) &&
            ts.isPropertyAccessExpression(objectInitializer.expression) &&
            ts.isIdentifier(objectInitializer.expression.expression) &&
            objectInitializer.expression.expression.text === 'Object' &&
            objectInitializer.expression.name.text === 'freeze' &&
            objectInitializer.arguments.length === 1 &&
            objectInitializer.arguments[0] !== undefined
          ) {
            objectInitializer = unwrapExpression(objectInitializer.arguments[0]);
          }
          if (!ts.isObjectLiteralExpression(objectInitializer)) {
            throw new ContractGenerationError(
              'adminResponse.literalSet Object.keys requires a const object literal authority',
            );
          }
          derivedObjectKeyValues = objectInitializer.properties.map((property) => {
            if (!ts.isPropertyAssignment(property)) {
              throw new ContractGenerationError(
                'adminResponse.literalSet Object.keys forbids computed, shorthand, or spread members',
              );
            }
            const name = property.name;
            if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
              return name.text;
            }
            throw new ContractGenerationError(
              'adminResponse.literalSet Object.keys requires static property names',
            );
          });
        }
        if (literalEntries.length === 0 && derivedObjectKeyValues === undefined) {
          throw new ContractGenerationError(
            'adminResponse.literalSet requires a non-empty const array authority',
          );
        }
        const values =
          derivedObjectKeyValues ??
          literalEntries.map((entry) => {
            if (ts.isSpreadElement(entry)) {
              throw new ContractGenerationError('adminResponse.literalSet forbids spread elements');
            }
            return this.jsonPrimitiveLiteral(entry);
          });
        if (new Set(values.map((entry) => JSON.stringify(entry))).size !== values.length) {
          throw new ContractGenerationError('adminResponse.literalSet requires unique literals');
        }
        return {
          kind: 'union',
          variants: values.map((entry) => ({ kind: 'literal', value: entry })),
        };
      }
      case 'array':
      case 'page':
        this.requireArity(builder, args, 1, value);
        return {
          kind: builder,
          item: this.evaluateExpression(requiredValue(args[0], `${builder} argument`)),
        };
      case 'optional':
      case 'nullable':
      case 'record':
        this.requireArity(builder, args, 1, value);
        return {
          kind: builder,
          value: this.evaluateExpression(requiredValue(args[0], `${builder} argument`)),
        };
      case 'tuple':
      case 'union': {
        this.requireArity(builder, args, 1, value);
        const list = unwrapExpression(requiredValue(args[0], `${builder} argument`));
        if (!ts.isArrayLiteralExpression(list)) {
          throw new ContractGenerationError(`adminResponse.${builder} requires an inline array`);
        }
        if (builder === 'union' && list.elements.length === 0) {
          throw new ContractGenerationError('adminResponse.union cannot be empty');
        }
        const nodes = list.elements.map((entry) => {
          if (ts.isSpreadElement(entry)) {
            throw new ContractGenerationError(`adminResponse.${builder} forbids spread elements`);
          }
          return this.evaluateExpression(entry);
        });
        return builder === 'tuple'
          ? { kind: 'tuple', items: nodes }
          : { kind: 'union', variants: nodes };
      }
      case 'object': {
        this.requireArity(builder, args, 1, value);
        const fieldsExpression = unwrapExpression(requiredValue(args[0], `${builder} argument`));
        if (!ts.isObjectLiteralExpression(fieldsExpression)) {
          throw new ContractGenerationError('adminResponse.object requires an inline object');
        }
        const fields: Record<string, ContractNode> = {};
        for (const property of fieldsExpression.properties) {
          if (!ts.isPropertyAssignment(property)) {
            throw new ContractGenerationError(
              'adminResponse.object forbids spread/shorthand/accessors',
            );
          }
          const name = propertyNameText(property.name, property.getSourceFile());
          if (Object.prototype.hasOwnProperty.call(fields, name)) {
            throw new ContractGenerationError(`duplicate response field ${name}`);
          }
          fields[name] = this.evaluateExpression(property.initializer);
        }
        return { kind: 'object', fields };
      }
      default:
        throw new ContractGenerationError(`unsupported contract builder ${builder}`);
    }
  }

  private isPlatformBuilderAuthority(
    expression: ts.Expression,
    name: 'adminManualResponse' | 'adminResponse',
  ): boolean {
    const symbol = resolvedSymbol(this.checker.getSymbolAtLocation(expression), this.checker);
    return (
      symbol?.getName() === name &&
      (symbol.declarations ?? []).some((declaration) =>
        declaration
          .getSourceFile()
          .fileName.replaceAll('\\', '/')
          .endsWith(ADMIN_CONTRACT_LIBRARY_SUFFIX),
      )
    );
  }

  private requireArity(
    builder: string,
    args: readonly ts.Expression[],
    expected: number,
    call: ts.CallExpression,
  ): void {
    if (args.length !== expected) {
      throw new ContractGenerationError(
        `${repoPath(call.getSourceFile().fileName)} adminResponse.${builder} expects ${expected} arguments`,
      );
    }
  }
}

function discoverNamedProjections(program: ts.Program): readonly NamedProjection[] {
  const checker = program.getTypeChecker();
  const evaluator = new ContractDagEvaluator(checker);
  const projections: NamedProjection[] = [];
  const ids = new Set<string>();
  const productionSources = program
    .getSourceFiles()
    .filter((source) => {
      const file = source.fileName.replaceAll('\\', '/');
      return (
        file.startsWith(`${resolve(REPO_ROOT, CONTROLLER_ROOT).replaceAll('\\', '/')}/`) &&
        !source.isDeclarationFile &&
        !/\.(?:spec|test)\.tsx?$/.test(file) &&
        !file.includes('/__tests__/')
      );
    })
    .sort((left, right) => compareUtf16CodeUnits(left.fileName, right.fileName));

  for (const source of productionSources) {
    source.forEachChild((node) => {
      if (
        !ts.isTypeAliasDeclaration(node) ||
        !node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
        !ts.isTypeReferenceNode(node.type)
      ) {
        return;
      }
      const typeAuthority = resolvedSymbol(
        checker.getSymbolAtLocation(node.type.typeName),
        checker,
      );
      const isProjectionAlias =
        typeAuthority?.getName() === 'AdminResponseProjection' &&
        (typeAuthority.declarations ?? []).some((declaration) =>
          declaration
            .getSourceFile()
            .fileName.replaceAll('\\', '/')
            .endsWith(ADMIN_CONTRACT_LIBRARY_SUFFIX),
        );
      if (!isProjectionAlias) return;
      const argument = node.type.typeArguments?.[0];
      if (
        node.type.typeArguments?.length !== 1 ||
        argument === undefined ||
        !ts.isTypeQueryNode(argument) ||
        !ts.isIdentifier(argument.exprName)
      ) {
        throw new ContractGenerationError(
          `${repoPath(source.fileName)}#${node.name.text} must reference exactly one local const contract with typeof`,
        );
      }
      const contract = evaluator.evaluateRoot(argument.exprName);
      const id = `${repoPath(source.fileName)}#${node.name.text}`;
      if (ids.has(id)) {
        throw new ContractGenerationError(`duplicate named projection ${id}`);
      }
      ids.add(id);
      projections.push({
        id,
        name: node.name.text,
        sourceFile: repoPath(source.fileName),
        sourceLine: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
        contract,
        schemaDigest: schemaDigest(contract.node),
      });
    });
  }
  return projections.sort((left, right) => compareUtf16CodeUnits(left.id, right.id));
}

function fullHash(value: string): string {
  return sha256Hex(value);
}

function graphqlSchemaRegistryHash(): string {
  const parsed: unknown = JSON.parse(
    readFileSync(resolve(REPO_ROOT, GRAPHQL_SCHEMA_REGISTRY), 'utf8'),
  );
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ContractGenerationError('GraphQL schema registry manifest must be an object');
  }
  const registryHash: unknown = Reflect.get(parsed, 'registryHash');
  if (typeof registryHash !== 'string' || !/^[a-f0-9]{64}$/.test(registryHash)) {
    throw new ContractGenerationError(
      'GraphQL schema registry manifest lacks a SHA-256 registryHash',
    );
  }
  return registryHash;
}

function schemaDigest(node: ContractNode): string {
  return fullHash(`admin-response-contract.v1\0${canonicalWireJsonStringifyV1(node)}`);
}

function requestSchemaDigest(
  request: Omit<RouteRequestAuthority, 'schemaDigest' | 'schemalessBoundaryIds'>,
): string {
  return fullHash(`admin-request-contract.v1\0${canonicalWireJsonStringifyV1(request)}`);
}

function requestTypeError(type: ts.Type, checker: ts.TypeChecker, context: string): never {
  throw new ContractGenerationError(
    `${context} request type ${checker.typeToString(type)} is outside the closed request DAG`,
  );
}

interface RequestSchemalessBoundary {
  readonly id: string;
  readonly policy: (typeof ADMIN_SCHEMALESS_BOUNDARY_CATALOG)[string] | undefined;
}

function requestSchemalessBoundary(
  declaration: ts.Declaration,
  fallbackName: string,
): RequestSchemalessBoundary {
  const propertyPath: string[] = [];
  let current: ts.Node | undefined = declaration;
  let owner = '<anonymous>';
  while (current !== undefined) {
    if (
      (ts.isPropertyDeclaration(current) || ts.isPropertySignature(current)) &&
      (ts.isIdentifier(current.name) || ts.isStringLiteral(current.name))
    ) {
      propertyPath.unshift(current.name.text);
    }
    if (
      (ts.isClassDeclaration(current) ||
        ts.isInterfaceDeclaration(current) ||
        ts.isTypeAliasDeclaration(current)) &&
      current.name !== undefined
    ) {
      owner = current.name.text;
      break;
    }
    current = current.parent;
  }
  if (propertyPath.length === 0) propertyPath.push(fallbackName);
  const id = `request:${repoPath(declaration.getSourceFile().fileName)}#${owner}.${propertyPath.join(
    '.',
  )}`;
  return { id, policy: ADMIN_SCHEMALESS_BOUNDARY_CATALOG[id] };
}

export interface RequestRuntimeCoverageInput {
  readonly metatype: RequestRuntimeMetatype;
  readonly declaredClassFieldCount: number;
  readonly classValidatorFieldCount: number;
  readonly generatedBoundaryDecoderInstalled: boolean;
}

export function assertRequestRuntimeCoverage(
  input: RequestRuntimeCoverageInput,
  context: string,
): RequestRuntimeProof['coverage'] {
  if (!input.generatedBoundaryDecoderInstalled) {
    throw new ContractGenerationError(
      `${context} has no mandatory generated controller-boundary request decoder`,
    );
  }
  if (
    input.metatype === 'class' &&
    input.classValidatorFieldCount !== input.declaredClassFieldCount
  ) {
    throw new ContractGenerationError(
      `${context} class metatype validates ${input.classValidatorFieldCount}/` +
        `${input.declaredClassFieldCount} fields with class-validator metadata`,
    );
  }
  return input.metatype === 'class' ? 'GENERATED_DECODER_AND_CLASS_VALIDATOR' : 'GENERATED_DECODER';
}

function isClassValidatorDecorator(decorator: ts.Decorator, checker: ts.TypeChecker): boolean {
  const expression = ts.isCallExpression(decorator.expression)
    ? decorator.expression.expression
    : decorator.expression;
  return importedName(expression, checker, 'class-validator') !== undefined;
}

function requestRuntimeProof(
  parameter: ts.ParameterDeclaration,
  section: RequestRuntimeProof['section'],
  field: string | null,
  checker: ts.TypeChecker,
  context: string,
): RequestRuntimeProof {
  const type = checker.getTypeAtLocation(parameter);
  const symbol = resolvedSymbol(type.aliasSymbol ?? type.getSymbol(), checker);
  const classDeclaration = symbol?.declarations?.find(ts.isClassDeclaration);
  const primitive =
    (type.flags &
      (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike)) !==
      0 || symbol?.getName() === 'Date';
  const metatype: RequestRuntimeMetatype = primitive
    ? 'primitive'
    : classDeclaration === undefined
      ? 'erased'
      : 'class';
  const classFields =
    classDeclaration === undefined
      ? []
      : checker
          .getPropertiesOfType(type)
          .filter((property) =>
            (property.declarations ?? []).some((declaration) =>
              ts.isPropertyDeclaration(declaration),
            ),
          );
  const classValidatorFieldCount = classFields.filter((property) =>
    (property.declarations ?? [])
      .filter(ts.isPropertyDeclaration)
      .some((declaration) =>
        decoratorsOf(declaration).some((decorator) =>
          isClassValidatorDecorator(decorator, checker),
        ),
      ),
  ).length;
  const coverage = assertRequestRuntimeCoverage(
    {
      metatype,
      declaredClassFieldCount: classFields.length,
      classValidatorFieldCount,
      generatedBoundaryDecoderInstalled: true,
    },
    context,
  );
  return {
    parameter: parameter.name.getText(parameter.getSourceFile()),
    section,
    field,
    metatype,
    declaredClassFieldCount: classFields.length,
    classValidatorFieldCount,
    coverage,
  };
}

function literalContractForType(type: ts.Type, checker: ts.TypeChecker): ContractNode | undefined {
  if (type.isStringLiteral()) return { kind: 'literal', value: type.value };
  if (type.isNumberLiteral()) return { kind: 'literal', value: type.value };
  if ((type.flags & ts.TypeFlags.BooleanLiteral) !== 0) {
    const rendered = checker.typeToString(type);
    if (rendered !== 'true' && rendered !== 'false') {
      throw new ContractGenerationError(`unsupported boolean literal type ${rendered}`);
    }
    return {
      kind: 'literal',
      value: rendered === 'true',
    };
  }
  return undefined;
}

function requestContractForType(
  type: ts.Type,
  checker: ts.TypeChecker,
  context: string,
  visiting = new Set<ts.Type>(),
  schemalessBoundary?: RequestSchemalessBoundary,
  usedSchemalessBoundaries = new Set<string>(),
): ContractNode {
  if ((type.flags & ts.TypeFlags.Unknown) !== 0) {
    if (schemalessBoundary?.policy === undefined) {
      throw new ContractGenerationError(
        `${context} schemaless request boundary ${
          schemalessBoundary?.id ?? '<unidentified>'
        } is absent from the closed governance catalog`,
      );
    }
    usedSchemalessBoundaries.add(schemalessBoundary.id);
    return adminJsonContractNode(schemalessBoundary.policy.reason);
  }
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.TypeParameter)) !== 0) {
    return requestTypeError(type, checker, context);
  }

  if (type.isUnion()) {
    const hasUndefined = type.types.some((entry) => (entry.flags & ts.TypeFlags.Undefined) !== 0);
    const hasNull = type.types.some((entry) => (entry.flags & ts.TypeFlags.Null) !== 0);
    const concrete = type.types.filter(
      (entry) => (entry.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0,
    );
    if (concrete.length === 0) return requestTypeError(type, checker, context);
    let node =
      concrete.length === 1
        ? requestContractForType(
            requiredValue(concrete[0], `${context} union member`),
            checker,
            context,
            visiting,
            schemalessBoundary,
            usedSchemalessBoundaries,
          )
        : {
            kind: 'union' as const,
            variants: concrete.map((entry) =>
              requestContractForType(
                entry,
                checker,
                context,
                visiting,
                schemalessBoundary,
                usedSchemalessBoundaries,
              ),
            ),
          };
    if (hasNull) node = { kind: 'nullable', value: node };
    if (hasUndefined) node = { kind: 'optional', value: node };
    return node;
  }

  const literal = literalContractForType(type, checker);
  if (literal !== undefined) return literal;
  if ((type.flags & ts.TypeFlags.StringLike) !== 0) return { kind: 'string' };
  if ((type.flags & ts.TypeFlags.NumberLike) !== 0) return { kind: 'number' };
  if ((type.flags & ts.TypeFlags.BooleanLike) !== 0) return { kind: 'boolean' };
  if ((type.flags & ts.TypeFlags.Never) !== 0) return { kind: 'never' };

  const symbol = resolvedSymbol(type.aliasSymbol ?? type.getSymbol(), checker);
  if (symbol?.getName() === 'Date') return { kind: 'date-string' };

  if (checker.isTupleType(type)) {
    const items = checker.getTypeArguments(type as ts.TypeReference);
    return {
      kind: 'tuple',
      items: items.map((item, index) =>
        requestContractForType(
          item,
          checker,
          `${context}[${index}]`,
          visiting,
          schemalessBoundary,
          usedSchemalessBoundaries,
        ),
      ),
    };
  }
  if (checker.isArrayType(type)) {
    const item = checker.getIndexTypeOfType(type, ts.IndexKind.Number);
    if (item === undefined) return requestTypeError(type, checker, context);
    return {
      kind: 'array',
      item: requestContractForType(
        item,
        checker,
        `${context}[]`,
        visiting,
        schemalessBoundary,
        usedSchemalessBoundaries,
      ),
    };
  }

  if ((type.flags & ts.TypeFlags.Object) === 0 || visiting.has(type)) {
    return requestTypeError(type, checker, context);
  }
  const nextVisiting = new Set(visiting);
  nextVisiting.add(type);
  const stringIndex = checker.getIndexInfoOfType(type, ts.IndexKind.String);
  const properties = checker
    .getPropertiesOfType(type)
    .filter((property) =>
      (property.declarations ?? []).some(
        (declaration) =>
          ts.isPropertyDeclaration(declaration) ||
          ts.isPropertySignature(declaration) ||
          ts.isParameter(declaration) ||
          ts.isGetAccessorDeclaration(declaration),
      ),
    );
  if (stringIndex !== undefined) {
    if (properties.length > 0) return requestTypeError(type, checker, context);
    return {
      kind: 'record',
      value: requestContractForType(
        stringIndex.type,
        checker,
        `${context}.*`,
        nextVisiting,
        schemalessBoundary,
        usedSchemalessBoundaries,
      ),
    };
  }

  const fields: Record<string, ContractNode> = {};
  for (const property of properties.sort((left, right) =>
    compareUtf16CodeUnits(left.getName(), right.getName()),
  )) {
    const name = property.getName();
    if (name === '__proto__' || name === 'prototype' || name === 'constructor') {
      throw new ContractGenerationError(`${context}.${name} is a forbidden request field name`);
    }
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (declaration === undefined) return requestTypeError(type, checker, context);
    let field = requestContractForType(
      checker.getTypeOfSymbolAtLocation(property, declaration),
      checker,
      `${context}.${name}`,
      nextVisiting,
      requestSchemalessBoundary(declaration, name),
      usedSchemalessBoundaries,
    );
    if ((property.flags & ts.SymbolFlags.Optional) !== 0 && field.kind !== 'optional') {
      field = { kind: 'optional', value: field };
    }
    fields[name] = field;
  }
  return { kind: 'object', fields };
}

function ensureOptionalRequestContract(node: ContractNode): ContractNode {
  return node.kind === 'optional' ? node : { kind: 'optional', value: node };
}

function requestObjectFields(
  node: ContractNode,
  context: string,
): Readonly<Record<string, ContractNode>> {
  const unwrapped = node.kind === 'optional' ? node.value : node;
  if (unwrapped.kind !== 'object') {
    throw new ContractGenerationError(`${context} whole-object decorator requires an object DTO`);
  }
  return unwrapped.fields;
}

function assertPathRequestContract(node: ContractNode, context: string): void {
  if (
    node.kind === 'string' ||
    node.kind === 'number' ||
    node.kind === 'boolean' ||
    node.kind === 'literal'
  ) {
    return;
  }
  if (node.kind === 'union') {
    node.variants.forEach((variant) => assertPathRequestContract(variant, context));
    return;
  }
  throw new ContractGenerationError(`${context} path parameter must be a required scalar`);
}

function assertQueryRequestContract(node: ContractNode, context: string): void {
  if (node.kind === 'optional') {
    assertQueryRequestContract(node.value, context);
    return;
  }
  if (
    node.kind === 'string' ||
    node.kind === 'number' ||
    node.kind === 'boolean' ||
    node.kind === 'date-string' ||
    node.kind === 'literal'
  ) {
    return;
  }
  if (node.kind === 'array') {
    assertQueryRequestContract(node.item, `${context}[]`);
    return;
  }
  if (node.kind === 'union') {
    node.variants.forEach((variant) => assertQueryRequestContract(variant, context));
    return;
  }
  throw new ContractGenerationError(
    `${context} query parameter requires a scalar or repeated-scalar codec`,
  );
}

function decoratorFieldName(call: ts.CallExpression, context: string): string | undefined {
  const field = call.arguments[0];
  if (field === undefined) return undefined;
  if (ts.isStringLiteral(field) || ts.isNoSubstitutionTemplateLiteral(field)) return field.text;
  throw new ContractGenerationError(`${context} decorator field name must be a string literal`);
}

function nonOptionalContract(node: ContractNode): ContractNode {
  return node.kind === 'optional' ? node.value : node;
}

function queryCodecsFor(
  member: ts.MethodDeclaration,
  checker: ts.TypeChecker,
  queryFields: Readonly<Record<string, ContractNode>>,
  context: string,
): Readonly<Record<string, 'comma-separated' | 'repeated' | 'scalar'>> {
  const declared = new Map<string, 'comma-separated' | 'repeated'>();
  const call = adminDecoratorCall(member, checker, 'AdminQueryEncoding');
  if (call !== undefined) {
    const argument = call.arguments[0];
    if (
      call.arguments.length !== 1 ||
      argument === undefined ||
      !ts.isObjectLiteralExpression(argument)
    ) {
      throw new ContractGenerationError(
        `${context} @AdminQueryEncoding requires one literal codec object`,
      );
    }
    for (const property of argument.properties) {
      if (!ts.isPropertyAssignment(property) || property.name === undefined) {
        throw new ContractGenerationError(
          `${context} @AdminQueryEncoding permits only literal field assignments`,
        );
      }
      const field =
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : undefined;
      const codec = ts.isStringLiteral(property.initializer)
        ? property.initializer.text
        : undefined;
      if (
        field === undefined ||
        (codec !== 'comma-separated' && codec !== 'repeated') ||
        declared.has(field)
      ) {
        throw new ContractGenerationError(
          `${context} @AdminQueryEncoding contains an invalid or duplicate field`,
        );
      }
      declared.set(field, codec);
    }
  }

  const output: Record<string, 'comma-separated' | 'repeated' | 'scalar'> = {};
  for (const [field, contract] of Object.entries(queryFields)) {
    const unwrapped = nonOptionalContract(contract);
    const explicit = declared.get(field);
    if (explicit === 'comma-separated' && unwrapped.kind === 'array') {
      throw new ContractGenerationError(
        `${context} query field ${field} cannot combine an array contract with comma-separated encoding`,
      );
    }
    if (explicit === 'repeated' && unwrapped.kind !== 'array') {
      throw new ContractGenerationError(
        `${context} query field ${field} repeated encoding requires an array-typed parameter`,
      );
    }
    output[field] = explicit ?? (unwrapped.kind === 'array' ? 'repeated' : 'scalar');
    declared.delete(field);
  }
  if (declared.size > 0) {
    throw new ContractGenerationError(
      `${context} @AdminQueryEncoding names unknown query fields: ${[...declared.keys()]
        .sort(compareUtf16CodeUnits)
        .join(', ')}`,
    );
  }
  return output;
}

function declaredSuccessStatusCode(
  member: ts.MethodDeclaration,
  method: AdminHttpMethod,
  checker: ts.TypeChecker,
  context: string,
): number {
  const call = resolvedNestDecoratorCall(member, checker, 'HttpCode');
  if (call === undefined) return method === 'POST' ? 201 : 200;
  const argument = call.arguments[0];
  let status: number | undefined;
  if (argument !== undefined && ts.isNumericLiteral(argument)) {
    status = Number(argument.text);
  } else if (
    argument !== undefined &&
    (ts.isPropertyAccessExpression(argument) || ts.isElementAccessExpression(argument))
  ) {
    const constant = checker.getConstantValue(argument);
    status = typeof constant === 'number' ? constant : undefined;
  }
  if (status === undefined && argument !== undefined) {
    const argumentType = checker.getTypeAtLocation(argument);
    status = argumentType.isNumberLiteral() ? argumentType.value : undefined;
  }
  if (
    call.arguments.length !== 1 ||
    status === undefined ||
    !Number.isSafeInteger(status) ||
    status < 200 ||
    status > 299
  ) {
    throw new ContractGenerationError(`${context} @HttpCode must resolve to one 2xx integer`);
  }
  return status;
}

function discoverRouteRequest(
  member: ts.MethodDeclaration,
  path: string,
  method: AdminHttpMethod,
  checker: ts.TypeChecker,
): RouteRequestAuthority {
  const source = member.getSourceFile();
  const context = `${repoPath(source.fileName)}#${member.name.getText(source)}`;
  const pathFields: Record<string, ContractNode> = {};
  const queryFields: Record<string, ContractNode> = {};
  const headerFields: Record<string, ContractNode> = {};
  let body: ContractNode = { kind: 'void' };
  let bodyCount = 0;
  const ambientInputs = new Set<'current-user' | 'request-context' | 'response-writer'>();
  const usedSchemalessBoundaries = new Set<string>();
  const runtimeProofs: RequestRuntimeProof[] = [];

  for (const parameter of member.parameters) {
    const paramCall = resolvedNestDecoratorCall(parameter, checker, 'Param');
    const queryCall = resolvedNestDecoratorCall(parameter, checker, 'Query');
    const bodyCall = resolvedNestDecoratorCall(parameter, checker, 'Body');
    const headersCall = resolvedNestDecoratorCall(parameter, checker, 'Headers');
    const requestCall = resolvedNestDecoratorCall(parameter, checker, 'Req');
    const responseCall = resolvedNestDecoratorCall(parameter, checker, 'Res');
    const customDecoratorName = resolvedDecoratorSymbolName(parameter, checker);
    const currentUser = customDecoratorName === 'CurrentUser';
    const requestDecoratorCount = [
      paramCall,
      queryCall,
      bodyCall,
      headersCall,
      requestCall,
      responseCall,
      currentUser ? true : undefined,
    ].filter((call) => call !== undefined).length;
    if (requestDecoratorCount === 0) continue;
    if (requestDecoratorCount !== 1) {
      throw new ContractGenerationError(`${context} parameter has multiple request decorators`);
    }
    if (requestCall !== undefined) {
      ambientInputs.add('request-context');
      continue;
    }
    if (responseCall !== undefined) {
      ambientInputs.add('response-writer');
      continue;
    }
    if (currentUser) {
      ambientInputs.add('current-user');
      continue;
    }
    let contract = requestContractForType(
      checker.getTypeAtLocation(parameter),
      checker,
      `${context}.${parameter.name.getText(source)}`,
      new Set<ts.Type>(),
      requestSchemalessBoundary(parameter, parameter.name.getText(source)),
      usedSchemalessBoundaries,
    );
    if (
      (parameter.questionToken !== undefined || parameter.initializer !== undefined) &&
      contract.kind !== 'optional'
    ) {
      contract = ensureOptionalRequestContract(contract);
    }

    if (paramCall !== undefined) {
      const field = decoratorFieldName(paramCall, context);
      if (field === undefined) {
        throw new ContractGenerationError(`${context} @Param requires one literal field name`);
      }
      if (pathFields[field] !== undefined) {
        throw new ContractGenerationError(`${context} duplicates @Param('${field}')`);
      }
      assertPathRequestContract(contract, `${context} @Param('${field}')`);
      pathFields[field] = contract;
      runtimeProofs.push(
        requestRuntimeProof(parameter, 'path', field, checker, `${context} @Param('${field}')`),
      );
      continue;
    }

    if (queryCall !== undefined) {
      const field = decoratorFieldName(queryCall, context);
      if (field === undefined) {
        for (const [name, fieldContract] of Object.entries(
          requestObjectFields(contract, `${context} @Query()`),
        )) {
          if (queryFields[name] !== undefined) {
            throw new ContractGenerationError(`${context} duplicates query field ${name}`);
          }
          assertQueryRequestContract(fieldContract, `${context} @Query().${name}`);
          queryFields[name] = fieldContract;
        }
        runtimeProofs.push(
          requestRuntimeProof(parameter, 'query', null, checker, `${context} @Query()`),
        );
      } else {
        if (queryFields[field] !== undefined) {
          throw new ContractGenerationError(`${context} duplicates @Query('${field}')`);
        }
        assertQueryRequestContract(contract, `${context} @Query('${field}')`);
        queryFields[field] = contract;
        runtimeProofs.push(
          requestRuntimeProof(parameter, 'query', field, checker, `${context} @Query('${field}')`),
        );
      }
      continue;
    }

    if (headersCall !== undefined) {
      const field = decoratorFieldName(headersCall, context)?.toLowerCase();
      if (field === undefined) {
        throw new ContractGenerationError(
          `${context} whole-header injection is outside the closed request DAG`,
        );
      }
      if (headerFields[field] !== undefined) {
        throw new ContractGenerationError(`${context} duplicates @Headers('${field}')`);
      }
      if (ADMIN_RESERVED_REQUEST_HEADER_NAMES.has(field)) {
        throw new ContractGenerationError(
          `${context} @Headers('${field}') is reserved by the transport kernel`,
        );
      }
      assertPathRequestContract(contract, `${context} @Headers('${field}')`);
      headerFields[field] = contract;
      runtimeProofs.push(
        requestRuntimeProof(
          parameter,
          'headers',
          field,
          checker,
          `${context} @Headers('${field}')`,
        ),
      );
      continue;
    }

    bodyCount++;
    if (bodyCount !== 1 || bodyCall === undefined) {
      throw new ContractGenerationError(`${context} requires at most one @Body parameter`);
    }
    if (bodyCall.arguments.length > 0) {
      throw new ContractGenerationError(
        `${context} named or piped @Body is outside the request DAG`,
      );
    }
    body = contract;
    runtimeProofs.push(requestRuntimeProof(parameter, 'body', null, checker, `${context} @Body()`));
  }

  const routePathFields = path
    .split('/')
    .filter((segment) => segment.startsWith(':'))
    .map((segment) => segment.slice(1))
    .sort(compareUtf16CodeUnits);
  const decoratedPathFields = Object.keys(pathFields).sort(compareUtf16CodeUnits);
  if (
    routePathFields.length !== decoratedPathFields.length ||
    routePathFields.some((field, index) => field !== decoratedPathFields[index])
  ) {
    throw new ContractGenerationError(
      `${context} path/decorator set mismatch: route=[${routePathFields.join(',')}], ` +
        `decorators=[${decoratedPathFields.join(',')}]`,
    );
  }
  if ((method === 'GET' || method === 'HEAD') && body.kind !== 'void') {
    throw new ContractGenerationError(`${context} ${method} routes cannot declare a browser body`);
  }

  const requestWithoutDigest = {
    path: { kind: 'object' as const, fields: pathFields },
    query: { kind: 'object' as const, fields: queryFields },
    queryCodecs: queryCodecsFor(member, checker, queryFields, context),
    headers: { kind: 'object' as const, fields: headerFields },
    body,
    contentType: body.kind === 'void' ? null : ('application/json' as const),
    ambientInputs: [...ambientInputs].sort(compareUtf16CodeUnits),
    runtimeProofs,
  };
  return {
    ...requestWithoutDigest,
    schemaDigest: requestSchemaDigest(requestWithoutDigest),
    schemalessBoundaryIds: [...usedSchemalessBoundaries].sort(compareUtf16CodeUnits),
  };
}

function typeContainsUnresolvedAuthority(
  type: ts.Type,
  checker: ts.TypeChecker,
  expected?: ts.Type,
  allowExpectedUnknown = false,
  visited = new Map<ts.Type, Set<ts.Type | undefined>>(),
): boolean {
  const alignedExpected =
    expected?.isUnion() === true
      ? (expected.types.find((candidate) => checker.isTypeAssignableTo(type, candidate)) ??
        expected)
      : expected;
  const expectedSet = visited.get(type) ?? new Set<ts.Type | undefined>();
  if (expectedSet.has(alignedExpected)) return false;
  expectedSet.add(alignedExpected);
  visited.set(type, expectedSet);
  const unresolvedFlags =
    ts.TypeFlags.Any |
    ts.TypeFlags.TypeParameter |
    ts.TypeFlags.IndexedAccess |
    ts.TypeFlags.Conditional;
  if ((type.flags & unresolvedFlags) !== 0) return true;
  if (allowExpectedUnknown && ((alignedExpected?.flags ?? 0) & ts.TypeFlags.Unknown) !== 0) {
    return false;
  }
  if ((type.flags & ts.TypeFlags.Unknown) !== 0) return true;
  if (type.isUnionOrIntersection()) {
    return type.types.some((entry) =>
      typeContainsUnresolvedAuthority(
        entry,
        checker,
        alignedExpected,
        allowExpectedUnknown,
        visited,
      ),
    );
  }
  const declarationLocation = (symbol: ts.Symbol): ts.Node | undefined =>
    symbol.valueDeclaration ?? symbol.declarations?.[0];
  for (const property of checker.getPropertiesOfType(type)) {
    const expectedProperty =
      alignedExpected === undefined
        ? undefined
        : checker.getPropertyOfType(alignedExpected, property.getName());
    const declaration = declarationLocation(property);
    const repositoryOwned =
      declaration !== undefined &&
      declaration.getSourceFile().fileName.replaceAll('\\', '/').startsWith(`${REPO_ROOT}/`);
    if (!repositoryOwned) continue;
    if (declaration === undefined) continue;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    const expectedDeclaration =
      expectedProperty === undefined ? undefined : declarationLocation(expectedProperty);
    const expectedPropertyType =
      expectedProperty === undefined || expectedDeclaration === undefined
        ? undefined
        : checker.getTypeOfSymbolAtLocation(expectedProperty, expectedDeclaration);
    if (
      typeContainsUnresolvedAuthority(
        propertyType,
        checker,
        expectedPropertyType,
        allowExpectedUnknown,
        visited,
      )
    ) {
      return true;
    }
  }

  for (const kind of [ts.IndexKind.String, ts.IndexKind.Number] as const) {
    const index = checker.getIndexInfoOfType(type, kind);
    if (index === undefined) continue;
    const expectedIndex =
      alignedExpected === undefined ? undefined : checker.getIndexInfoOfType(alignedExpected, kind);
    if (
      typeContainsUnresolvedAuthority(
        index.type,
        checker,
        expectedIndex?.type,
        allowExpectedUnknown,
        visited,
      )
    ) {
      return true;
    }
  }

  for (const signatureKind of [ts.SignatureKind.Call, ts.SignatureKind.Construct] as const) {
    const signatures = checker.getSignaturesOfType(type, signatureKind);
    const expectedSignatures =
      alignedExpected === undefined
        ? []
        : checker.getSignaturesOfType(alignedExpected, signatureKind);
    for (const [index, signature] of signatures.entries()) {
      const expectedSignature = expectedSignatures[index];
      if (
        typeContainsUnresolvedAuthority(
          checker.getReturnTypeOfSignature(signature),
          checker,
          expectedSignature === undefined
            ? undefined
            : checker.getReturnTypeOfSignature(expectedSignature),
          allowExpectedUnknown,
          visited,
        )
      ) {
        return true;
      }
      for (const parameter of signature.getParameters()) {
        const declaration = declarationLocation(parameter);
        if (
          declaration !== undefined &&
          typeContainsUnresolvedAuthority(
            checker.getTypeOfSymbolAtLocation(parameter, declaration),
            checker,
            undefined,
            allowExpectedUnknown,
            visited,
          )
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

export function assertConcreteAssignableType(
  actual: ts.Type,
  expected: ts.Type,
  checker: ts.TypeChecker,
  context: string,
  allowNever = false,
  allowExpectedUnknown = false,
): void {
  if ((actual.flags & ts.TypeFlags.Never) !== 0 && !allowNever) {
    throw new ContractGenerationError(
      `${context} return never is valid only for an executable never root contract`,
    );
  }
  if (typeContainsUnresolvedAuthority(actual, checker, expected, allowExpectedUnknown)) {
    throw new ContractGenerationError(
      `${context} return ${checker.typeToString(
        actual,
      )} contains any, unknown, or an unresolved generic/indexed type and cannot prove the executable contract`,
    );
  }
  if (!checker.isTypeAssignableTo(actual, expected)) {
    throw new ContractGenerationError(
      `${context} return ${checker.typeToString(actual)} is not assignable to ${checker.typeToString(
        expected,
      )}`,
    );
  }
}

function schemalessJsonBoundaries(node: ContractNode, path = '$'): SchemalessJsonBoundary[] {
  switch (node.kind) {
    case 'json': {
      const definition = resolveAdminJsonDecoderDefinition(node.reason);
      if (
        node.decoderId !== definition.decoderId ||
        node.decoderVersion !== definition.decoderVersion ||
        node.owner !== definition.owner ||
        node.rootPolicy !== definition.rootPolicy ||
        node.codecPolicyId !== definition.codecPolicyId
      ) {
        throw new ContractGenerationError(
          `${path} pins stale admin JSON decoder metadata for ${node.reason}`,
        );
      }
      return [{ path, ...definition }];
    }
    case 'array':
    case 'page':
      return schemalessJsonBoundaries(node.item, `${path}[]`);
    case 'optional':
    case 'nullable':
    case 'record':
      return schemalessJsonBoundaries(node.value, `${path}.*`);
    case 'tuple':
      return node.items.flatMap((item, index) =>
        schemalessJsonBoundaries(item, `${path}[${index}]`),
      );
    case 'union':
      return node.variants.flatMap((variant, index) =>
        schemalessJsonBoundaries(variant, `${path}<variant:${index}>`),
      );
    case 'object':
      return Object.entries(node.fields).flatMap(([name, field]) =>
        schemalessJsonBoundaries(field, `${path}.${name}`),
      );
    default:
      return [];
  }
}

interface ReturnProofAudit {
  readonly returnType: string;
  readonly declarationOrigins: readonly string[];
}

export type PersistenceTypeRegistry = ReadonlySet<ts.Symbol>;

function isTypeOrmAuthority(
  expression: ts.LeftHandSideExpression,
  checker: ts.TypeChecker,
  exportName: 'BaseEntity' | 'ChildEntity' | 'Entity' | 'EntitySchema' | 'ViewEntity',
): boolean {
  if (importedName(expression, checker, 'typeorm') === exportName) return true;
  const location = ts.isPropertyAccessExpression(expression) ? expression.name : expression;
  const symbol = resolvedSymbol(checker.getSymbolAtLocation(location), checker);
  return (
    symbol?.getName() === exportName &&
    (symbol.declarations ?? []).some((declaration) =>
      declaration.getSourceFile().fileName.replaceAll('\\', '/').includes('/node_modules/typeorm/'),
    )
  );
}

function persistenceIdentitySymbols(type: ts.Type, checker: ts.TypeChecker): readonly ts.Symbol[] {
  const symbols = new Set<ts.Symbol>();
  for (const symbol of [type.aliasSymbol, type.getSymbol()]) {
    if (symbol === undefined) continue;
    symbols.add(symbol);
    symbols.add(resolvedSymbol(symbol, checker) ?? symbol);
  }
  return [...symbols];
}

function typeExtendsTypeOrmBaseEntity(
  type: ts.Type,
  checker: ts.TypeChecker,
  visited = new Set<ts.Type>(),
): boolean {
  if (visited.has(type)) return false;
  visited.add(type);
  for (const symbol of persistenceIdentitySymbols(type, checker)) {
    if (
      symbol.getName() === 'BaseEntity' &&
      (symbol.declarations ?? []).some((declaration) =>
        declaration
          .getSourceFile()
          .fileName.replaceAll('\\', '/')
          .includes('/node_modules/typeorm/'),
      )
    ) {
      return true;
    }
  }
  if (
    (type.flags & ts.TypeFlags.Object) !== 0 &&
    ((type as ts.ObjectType).objectFlags & (ts.ObjectFlags.Class | ts.ObjectFlags.Interface)) !== 0
  ) {
    return checker
      .getBaseTypes(type as ts.InterfaceType)
      .some((base) => typeExtendsTypeOrmBaseEntity(base, checker, visited));
  }
  return false;
}

/**
 * Build one symbol-identity registry for every persistence model in the backend
 * compiler program. Response auditing consumes this registry; route reachability
 * therefore cannot hide an EntitySchema target behind an alias or re-export.
 */
export function discoverPersistenceTypeSymbols(program: ts.Program): PersistenceTypeRegistry {
  const checker = program.getTypeChecker();
  const registry = new Set<ts.Symbol>();
  const registerType = (type: ts.Type): void => {
    for (const symbol of persistenceIdentitySymbols(type, checker)) registry.add(symbol);
  };
  const registerDeclaration = (declaration: ts.NamedDeclaration): void => {
    if (declaration.name === undefined) return;
    registerType(checker.getTypeAtLocation(declaration.name));
    const symbol = checker.getSymbolAtLocation(declaration.name);
    if (symbol !== undefined) {
      registry.add(symbol);
      registry.add(resolvedSymbol(symbol, checker) ?? symbol);
    }
  };

  for (const source of program.getSourceFiles()) {
    const file = source.fileName.replaceAll('\\', '/');
    if (source.isDeclarationFile || file.includes('/node_modules/')) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name !== undefined) {
        const decoratedPersistenceModel = decoratorsOf(node).some((decorator) => {
          const expression = ts.isCallExpression(decorator.expression)
            ? decorator.expression.expression
            : decorator.expression;
          return (
            isTypeOrmAuthority(expression, checker, 'Entity') ||
            isTypeOrmAuthority(expression, checker, 'ViewEntity') ||
            isTypeOrmAuthority(expression, checker, 'ChildEntity')
          );
        });
        const classType = checker.getTypeAtLocation(node.name);
        if (decoratedPersistenceModel || typeExtendsTypeOrmBaseEntity(classType, checker)) {
          registerDeclaration(node);
        }
      }

      if (
        ts.isNewExpression(node) &&
        isTypeOrmAuthority(node.expression, checker, 'EntitySchema')
      ) {
        for (const typeArgument of node.typeArguments ?? []) {
          registerType(checker.getTypeFromTypeNode(typeArgument));
        }
        const options = node.arguments?.[0];
        if (options !== undefined && ts.isObjectLiteralExpression(options)) {
          for (const property of options.properties) {
            if (
              ts.isPropertyAssignment(property) &&
              propertyNameText(property.name, source) === 'target'
            ) {
              registerType(checker.getTypeAtLocation(property.initializer));
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
  }
  return registry;
}

export function auditReturnTypeOrigins(
  type: ts.Type,
  checker: ts.TypeChecker,
  persistenceTypes: PersistenceTypeRegistry = new Set<ts.Symbol>(),
): ReturnProofAudit {
  const visited = new Set<ts.Type>();
  const origins = new Set<string>();
  const entityOrigins = new Set<string>();
  const declarationLocation = (symbol: ts.Symbol): ts.Node | undefined =>
    symbol.valueDeclaration ?? symbol.declarations?.[0];
  const isTypeOrmPersistenceDecorator = (declaration: ts.Declaration): boolean =>
    decoratorsOf(declaration).some((decorator) => {
      const expression = ts.isCallExpression(decorator.expression)
        ? decorator.expression.expression
        : decorator.expression;
      const name = importedName(expression, checker, 'typeorm');
      return name === 'Entity' || name === 'ViewEntity' || name === 'ChildEntity';
    });
  const visit = (current: ts.Type): void => {
    if (visited.has(current)) return;
    visited.add(current);
    const symbols = [current.aliasSymbol, current.getSymbol()].filter(
      (symbol): symbol is ts.Symbol => symbol !== undefined,
    );
    for (const symbol of symbols) {
      const authority = resolvedSymbol(symbol, checker) ?? symbol;
      if (persistenceTypes.has(symbol) || persistenceTypes.has(authority)) {
        const declaration = symbol.declarations?.[0] ?? authority.declarations?.[0];
        const origin =
          declaration === undefined
            ? `persistence-registry#${authority.getName()}`
            : `${repoPath(declaration.getSourceFile().fileName)}:${
                declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart())
                  .line + 1
              }#${authority.getName()}`;
        entityOrigins.add(origin);
      }
      for (const declaration of symbol.declarations ?? []) {
        const file = declaration.getSourceFile().fileName.replaceAll('\\', '/');
        if (file.includes('/node_modules/typeorm/')) {
          if (symbol.getName() === 'EntitySchema' || symbol.getName() === 'BaseEntity') {
            entityOrigins.add(`typeorm#${symbol.getName()}`);
          }
          continue;
        }
        if (!file.startsWith(`${REPO_ROOT}/`) || file.includes('/node_modules/')) continue;
        const origin = `${repoPath(file)}:${
          declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart()).line + 1
        }#${symbol.getName()}`;
        origins.add(origin);
        if (
          isTypeOrmPersistenceDecorator(declaration) ||
          file.includes('/entities/') ||
          /\.entity\.ts$/.test(file)
        ) {
          entityOrigins.add(origin);
        }
      }
    }
    if (current.isUnionOrIntersection()) current.types.forEach(visit);
    if (
      (current.flags & ts.TypeFlags.Object) !== 0 &&
      ((current as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
    ) {
      checker.getTypeArguments(current as ts.TypeReference).forEach(visit);
    }
    if (
      (current.flags & ts.TypeFlags.Object) !== 0 &&
      ((current as ts.ObjectType).objectFlags &
        (ts.ObjectFlags.Class | ts.ObjectFlags.Interface)) !==
        0
    ) {
      checker.getBaseTypes(current as ts.InterfaceType).forEach(visit);
    }
    for (const property of checker.getPropertiesOfType(current)) {
      const declaration = declarationLocation(property);
      if (declaration === undefined) continue;
      const file = declaration.getSourceFile().fileName.replaceAll('\\', '/');
      if (!file.startsWith(`${REPO_ROOT}/`) || file.includes('/node_modules/')) continue;
      visit(checker.getTypeOfSymbolAtLocation(property, declaration));
    }
    for (const kind of [ts.IndexKind.String, ts.IndexKind.Number] as const) {
      const index = checker.getIndexInfoOfType(current, kind);
      if (index !== undefined) visit(index.type);
    }
    for (const signatureKind of [ts.SignatureKind.Call, ts.SignatureKind.Construct] as const) {
      checker
        .getSignaturesOfType(current, signatureKind)
        .forEach((signature) => visit(checker.getReturnTypeOfSignature(signature)));
    }
  };
  visit(type);
  if (entityOrigins.size > 0) {
    throw new ContractGenerationError(
      `HTTP response return type reaches persistence entity origins: ${[...entityOrigins]
        .sort(compareUtf16CodeUnits)
        .join(', ')}`,
    );
  }
  return {
    returnType: checker.typeToString(type),
    declarationOrigins: [...origins].sort(compareUtf16CodeUnits),
  };
}

function assertReturnAssignable(
  member: ts.MethodDeclaration,
  contract: EvaluatedContract,
  checker: ts.TypeChecker,
  persistenceTypes: PersistenceTypeRegistry,
): ReturnProofAudit {
  const signature = checker.getSignatureFromDeclaration(member);
  if (signature === undefined) {
    throw new ContractGenerationError('route method has no callable signature');
  }
  const declared = checker.getReturnTypeOfSignature(signature);
  const source = checker.getPropertyOfType(
    checker.getTypeAtLocation(contract.expression),
    'source',
  );
  if (source === undefined) {
    throw new ContractGenerationError(`${contract.name} exposes no source type carrier`);
  }
  const expected = checker.getTypeOfSymbolAtLocation(source, contract.expression);
  const actual = checker.getAwaitedType(declared) ?? declared;
  const location = member.getSourceFile().getLineAndCharacterOfPosition(member.getStart()).line + 1;
  assertConcreteAssignableType(
    actual,
    expected,
    checker,
    `${repoPath(member.getSourceFile().fileName)}:${location} (${contract.name})`,
    contract.node.kind === 'never',
    schemalessJsonBoundaries(contract.node).length > 0,
  );
  return auditReturnTypeOrigins(actual, checker, persistenceTypes);
}

function assertBootstrapRoutePolicyConsumption(program: ts.Program): void {
  if (
    ADMIN_HTTP_ROUTE_POLICY.schemaVersion !== 'admin-http-route-policy.v1' ||
    ADMIN_HTTP_ROUTE_POLICY.versioning.strategy !== 'uri' ||
    ADMIN_HTTP_ROUTE_POLICY.hostPolicy !== 'any-host'
  ) {
    throw new ContractGenerationError('unsupported admin HTTP bootstrap route policy');
  }
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(resolve(REPO_ROOT, 'apps/admin-api-service/src/main.ts'));
  if (source === undefined) {
    throw new ContractGenerationError('admin main.ts is absent from the compiler program');
  }
  let governedSpreadCount = 0;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      importedName(node.expression, checker, '@aquaculture/backend-common/bootstrap') ===
        'bootstrapService'
    ) {
      const options = node.arguments[1];
      if (options === undefined || !ts.isObjectLiteralExpression(options)) {
        throw new ContractGenerationError('admin bootstrap options must be an object literal');
      }
      for (const property of options.properties) {
        if (
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          ['customValidationPipe', 'validationPipeOverrides'].includes(property.name.getText())
        ) {
          throw new ContractGenerationError(
            `admin bootstrap ${property.name.getText()} cannot replace or weaken ValidationPipe`,
          );
        }
        if (
          (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
          ['globalPrefix', 'prefixExclusions', 'versioning'].includes(property.name.getText())
        ) {
          throw new ContractGenerationError(
            `admin bootstrap ${property.name.getText()} must come only from ADMIN_HTTP_ROUTE_POLICY`,
          );
        }
        if (!ts.isSpreadAssignment(property) || !ts.isCallExpression(property.expression)) continue;
        const call = property.expression;
        const location = ts.isPropertyAccessExpression(call.expression)
          ? call.expression.name
          : call.expression;
        const adapter = resolvedSymbol(checker.getSymbolAtLocation(location), checker);
        const adapterOwned = (adapter?.declarations ?? []).some((declaration) =>
          declaration
            .getSourceFile()
            .fileName.replaceAll('\\', '/')
            .endsWith(ADMIN_ROUTE_POLICY_ADAPTER_SUFFIX),
        );
        if (!adapterOwned || adapter?.getName() !== 'adminHttpBootstrapRouteOptions') continue;
        const policyArgument = call.arguments[0];
        const policyLocation =
          policyArgument !== undefined && ts.isPropertyAccessExpression(policyArgument)
            ? policyArgument.name
            : policyArgument;
        const policy =
          policyLocation === undefined
            ? undefined
            : resolvedSymbol(checker.getSymbolAtLocation(policyLocation), checker);
        const policyOwned = (policy?.declarations ?? []).some((declaration) =>
          declaration
            .getSourceFile()
            .fileName.replaceAll('\\', '/')
            .endsWith(ADMIN_ROUTE_POLICY_SUFFIX),
        );
        if (!policyOwned || policy?.getName() !== 'ADMIN_HTTP_ROUTE_POLICY') {
          throw new ContractGenerationError(
            'admin route policy adapter must consume ADMIN_HTTP_ROUTE_POLICY directly',
          );
        }
        governedSpreadCount++;
      }
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  if (governedSpreadCount !== 1) {
    throw new ContractGenerationError(
      `admin bootstrap must consume exactly one route policy adapter; found ${governedSpreadCount}`,
    );
  }
}

function assertBootstrapRequestDecoderConsumption(program: ts.Program): void {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(
    resolve(REPO_ROOT, 'apps/admin-api-service/src/bootstrap/admin-http-route-policy.ts'),
  );
  if (source === undefined) {
    throw new ContractGenerationError('admin route policy adapter is absent from the program');
  }
  let guardedCatalogCount = 0;
  const visit = (node: ts.Node): void => {
    if (!ts.isCallExpression(node)) {
      node.forEachChild(visit);
      return;
    }
    const location = ts.isPropertyAccessExpression(node.expression)
      ? node.expression.name
      : node.expression;
    const guardFactory = resolvedSymbol(checker.getSymbolAtLocation(location), checker);
    const guardOwned = (guardFactory?.declarations ?? []).some((declaration) =>
      declaration
        .getSourceFile()
        .fileName.replaceAll('\\', '/')
        .endsWith(ADMIN_REQUEST_GUARD_SUFFIX),
    );
    if (!guardOwned || guardFactory?.getName() !== 'createAdminRequestContractGuard') {
      node.forEachChild(visit);
      return;
    }
    const array = node.parent;
    const property = array.parent;
    if (
      !ts.isArrayLiteralExpression(array) ||
      !ts.isPropertyAssignment(property) ||
      property.name.getText(source) !== 'globalGuards'
    ) {
      throw new ContractGenerationError(
        'generated admin request guard must be installed directly in globalGuards',
      );
    }
    const argument = node.arguments[0];
    const argumentLocation =
      argument !== undefined && ts.isPropertyAccessExpression(argument) ? argument.name : argument;
    const catalog =
      argumentLocation === undefined
        ? undefined
        : resolvedSymbol(checker.getSymbolAtLocation(argumentLocation), checker);
    const generatedCatalog = (catalog?.declarations ?? []).some((declaration) =>
      declaration
        .getSourceFile()
        .fileName.replaceAll('\\', '/')
        .endsWith(ADMIN_SERVER_REQUEST_RUNTIME_SUFFIX),
    );
    if (!generatedCatalog || catalog?.getName() !== 'ADMIN_SERVER_REQUEST_CONTRACTS') {
      throw new ContractGenerationError(
        'admin request guard must consume the generated server request catalog directly',
      );
    }
    guardedCatalogCount++;
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  if (guardedCatalogCount !== 1) {
    throw new ContractGenerationError(
      `admin bootstrap must install exactly one generated request guard; found ${guardedCatalogCount}`,
    );
  }
}

export function assertNoRouteCoordinateOverrides(
  input: {
    readonly controllerOptions: boolean;
    readonly controllerVersion: boolean;
    readonly methodVersion: boolean;
  },
  context: string,
): void {
  if (input.controllerOptions || input.controllerVersion || input.methodVersion) {
    throw new ContractGenerationError(
      `${context} host/version/route options are outside ADMIN_HTTP_ROUTE_POLICY`,
    );
  }
}

function discoverRoutes(program: ts.Program): RouteAuthority[] {
  assertBootstrapRoutePolicyConsumption(program);
  assertBootstrapRequestDecoderConsumption(program);
  const checker = program.getTypeChecker();
  const persistenceTypes = discoverPersistenceTypeSymbols(program);
  const evaluator = new ContractDagEvaluator(checker);
  const routes: RouteAuthority[] = [];
  const returnProofDiagnostics: string[] = [];
  const requestProofDiagnostics: string[] = [];

  const controllerRoot = `${resolve(REPO_ROOT, CONTROLLER_ROOT).replaceAll('\\', '/')}/`;
  const productionSources = program
    .getSourceFiles()
    .filter((source) => {
      const fileName = source.fileName.replaceAll('\\', '/');
      return (
        fileName.startsWith(controllerRoot) &&
        !source.isDeclarationFile &&
        !/\.(?:spec|test)\.tsx?$/.test(fileName) &&
        !fileName.includes('/__tests__/')
      );
    })
    .sort((left, right) => compareUtf16CodeUnits(left.fileName, right.fileName));

  for (const source of productionSources) {
    const file = repoPath(source.fileName);
    source.forEachChild((node) => {
      if (!ts.isClassDeclaration(node)) return;
      const controllerCall = resolvedNestDecoratorCall(node, checker, 'Controller');
      if (controllerCall === undefined) return;
      const controllerOptions =
        controllerCall.arguments[0] !== undefined &&
        ts.isObjectLiteralExpression(controllerCall.arguments[0]);
      assertNoRouteCoordinateOverrides(
        {
          controllerOptions,
          controllerVersion: resolvedNestDecoratorCall(node, checker, 'Version') !== undefined,
          methodVersion: false,
        },
        file,
      );
      const controllerPath = literalPathExpression(controllerCall.arguments[0], source);
      const controllerClass = node.name?.text ?? '<anonymous-controller>';
      const controllerIsPublic = hasCanonicalPublicDecorator(node, checker);

      for (const member of node.members) {
        if (!ts.isMethodDeclaration(member)) continue;
        assertNoRouteCoordinateOverrides(
          {
            controllerOptions: false,
            controllerVersion: false,
            methodVersion: resolvedNestDecoratorCall(member, checker, 'Version') !== undefined,
          },
          `${file}#${member.name.getText(source)}`,
        );
        const routeDecorators = decoratorsOf(member)
          .filter((decorator) => ts.isCallExpression(decorator.expression))
          .map((decorator) =>
            resolvedRouteDecorator(decorator.expression as ts.CallExpression, checker),
          )
          .filter((route): route is ResolvedRouteDecorator => route !== undefined);
        const identities = new Map(
          routeDecorators.map((route) => [`${route.method} ${route.path}`, route]),
        );
        if (identities.size === 0) continue;
        if (identities.size !== 1) {
          throw new ContractGenerationError(
            `${file}#${member.name.getText(source)} declares multiple HTTP route mappings`,
          );
        }
        const route = requiredValue(
          identities.values().next().value,
          `${file}#${member.name.getText(source)} route identity`,
        );
        const path = adminLogicalRoutePathFromMetadata(controllerPath, route.path);
        const lifecycle = routeLifecycleAuthority(
          member,
          checker,
          `${file}#${member.name.getText(source)}`,
        );
        const authorization = routeAuthorizationAuthority(
          node,
          member,
          controllerIsPublic || hasCanonicalPublicDecorator(member, checker),
          checker,
        );
        let request: RouteRequestAuthority;
        try {
          request = discoverRouteRequest(member, path, route.method, checker);
        } catch (error) {
          if (!(error instanceof ContractGenerationError)) throw error;
          requestProofDiagnostics.push(error.message);
          const failedRequest = {
            path: { kind: 'object' as const, fields: {} },
            query: { kind: 'object' as const, fields: {} },
            queryCodecs: {},
            headers: { kind: 'object' as const, fields: {} },
            body: { kind: 'void' as const },
            contentType: null,
            ambientInputs: [],
            runtimeProofs: [],
          };
          request = {
            ...failedRequest,
            schemaDigest: requestSchemaDigest(failedRequest),
            schemalessBoundaryIds: [],
          };
        }
        const contractCall = adminDecoratorCall(member, checker, 'AdminResponseContract');
        const bypassCall = adminDecoratorCall(member, checker, 'AdminManualResponse');
        const manualResponse = manualResponseAuthority(member, checker);
        if ((contractCall === undefined) === (bypassCall === undefined)) {
          throw new ContractGenerationError(
            `${file}#${member.name.getText(source)} must declare exactly one of ` +
              '@AdminResponseContract or @AdminManualResponse',
          );
        }
        if (manualResponse !== undefined && contractCall !== undefined) {
          throw new ContractGenerationError(
            `${file}#${member.name.getText(source)} uses @Res and cannot declare a JSON response contract`,
          );
        }

        let response: ContractedResponse | BypassResponse;
        if (contractCall !== undefined) {
          if (contractCall.arguments.length !== 1 || contractCall.arguments[0] === undefined) {
            throw new ContractGenerationError(
              '@AdminResponseContract requires exactly one contract',
            );
          }
          const contract = evaluator.evaluateRoot(contractCall.arguments[0]);
          let returnProof: ReturnProofAudit = {
            returnType: '<unproven>',
            declarationOrigins: [],
          };
          try {
            returnProof = assertReturnAssignable(member, contract, checker, persistenceTypes);
          } catch (error) {
            if (!(error instanceof ContractGenerationError)) throw error;
            returnProofDiagnostics.push(error.message);
          }
          response = {
            mode: 'contract',
            transport: 'json-envelope',
            contract,
            schemaDigest: schemaDigest(contract.node),
            returnAssignable: true,
            returnType: returnProof.returnType,
            returnDeclarationOrigins: returnProof.declarationOrigins,
          };
        } else {
          if (bypassCall === undefined) {
            throw new ContractGenerationError(
              `${file}#${member.name.getText(source)} lost its manual response authority`,
            );
          }
          const profileExpression = bypassCall.arguments[0];
          if (bypassCall.arguments.length !== 1 || profileExpression === undefined) {
            throw new ContractGenerationError(
              '@AdminManualResponse requires one executable manual response profile',
            );
          }
          const profile = evaluator.evaluateManualProfile(profileExpression);
          response = {
            mode: 'bypass',
            transport: profile.node.transport,
            profile,
          };
          if (profile.node.kind === 'binary-download' && manualResponse === undefined) {
            throw new ContractGenerationError(
              `${file}#${member.name.getText(source)} binary-download bypass requires explicit @Res`,
            );
          }
          if (manualResponse !== undefined) {
            assertGovernedManualSender(
              member,
              checker,
              manualResponse,
              profileExpression,
              profile.node.kind,
            );
          }
        }

        routes.push({
          id: `${route.method} ${path}`,
          method: route.method,
          path,
          networkAliases: adminNetworkAliases(path),
          controllerFile: file,
          controllerClass,
          controllerMethod: member.name.getText(source),
          controllerLine: source.getLineAndCharacterOfPosition(member.getStart()).line + 1,
          successStatusCode: declaredSuccessStatusCode(
            member,
            route.method,
            checker,
            `${file}#${member.name.getText(source)}`,
          ),
          lifecycle,
          manualResponse,
          authorization,
          request,
          response,
        });
      }
    });
  }

  if (requestProofDiagnostics.length > 0 || returnProofDiagnostics.length > 0) {
    throw new ContractGenerationError(
      [
        ...(requestProofDiagnostics.length === 0
          ? []
          : [
              `route request proofs failed (${requestProofDiagnostics.length}):`,
              ...requestProofDiagnostics.map((diagnostic) => `- ${diagnostic}`),
            ]),
        ...(returnProofDiagnostics.length === 0
          ? []
          : [
              `route return proofs failed (${returnProofDiagnostics.length}):`,
              ...returnProofDiagnostics.map((diagnostic) => `- ${diagnostic}`),
            ]),
      ].join('\n'),
    );
  }

  const discoveredSchemalessBoundaryIds = new Set(
    routes.flatMap((route) => route.request.schemalessBoundaryIds),
  );
  const staleSchemalessBoundaryIds = Object.keys(ADMIN_SCHEMALESS_BOUNDARY_CATALOG)
    .filter((id) => !discoveredSchemalessBoundaryIds.has(id))
    .sort(compareUtf16CodeUnits);
  if (staleSchemalessBoundaryIds.length > 0) {
    throw new ContractGenerationError(
      `schemaless boundary catalog contains stale entries: ${staleSchemalessBoundaryIds.join(
        ', ',
      )}`,
    );
  }

  const byId = new Map<string, RouteAuthority>();
  for (const route of routes) {
    const existing = byId.get(route.id);
    if (existing !== undefined) {
      throw new ContractGenerationError(
        `duplicate route ${route.id}: ${existing.controllerFile}#${existing.controllerMethod} ` +
          `and ${route.controllerFile}#${route.controllerMethod}`,
      );
    }
    byId.set(route.id, route);
  }
  assertNoSemanticRouteCollisions(routes.map((route) => routeMatcherCandidate(route)));
  assertNoSemanticRouteCollisions(
    routes.flatMap((route) =>
      route.networkAliases.map((path) => routeMatcherCandidate(route, path)),
    ),
  );
  return [...byId.values()].sort((left, right) => compareUtf16CodeUnits(left.id, right.id));
}

function requestStringLiteralSet(node: ContractNode, context: string): readonly string[] {
  const unwrapped = node.kind === 'optional' ? node.value : node;
  const variants = unwrapped.kind === 'union' ? unwrapped.variants : [unwrapped];
  const values = variants.map((variant) => {
    if (variant.kind !== 'literal' || typeof variant.value !== 'string') {
      throw new ContractGenerationError(
        `${context} must be a closed string-literal union derived from SqlIdentifierCatalogV1`,
      );
    }
    return variant.value;
  });
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new ContractGenerationError(`${context} contains duplicate or empty sort keys`);
  }
  return [...values].sort(compareUtf16CodeUnits);
}

interface CompiledSqlIdentifierEntryV1 extends SqlIdentifierCatalogEntryV1 {
  readonly routeId: string;
}

interface CompiledSqlIdentifierCatalogV1 {
  readonly schemaVersion: 'sql-identifier-catalog.v1';
  readonly entries: readonly CompiledSqlIdentifierEntryV1[];
  readonly catalogDigest: string;
}

function compileSqlIdentifierCatalog(
  routes: readonly RouteAuthority[],
): CompiledSqlIdentifierCatalogV1 {
  const routeById = new Map(routes.map((route) => [route.id, route]));
  const entries = Object.entries(ADMIN_SQL_IDENTIFIER_CATALOG.entries)
    .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
    .map(([routeId, entry]) => {
      const route = routeById.get(routeId);
      if (route === undefined) {
        throw new ContractGenerationError(
          `SqlIdentifierCatalogV1 references unknown admin route ${routeId}`,
        );
      }
      if (route.request.query.kind !== 'object') {
        throw new ContractGenerationError(`${routeId} query contract is not an object`);
      }
      const sortContract = route.request.query.fields[entry.requestField];
      if (sortContract === undefined) {
        throw new ContractGenerationError(
          `${routeId} does not declare catalog field ${entry.requestField}`,
        );
      }
      const requestKeys = requestStringLiteralSet(
        sortContract,
        `${routeId} @Query('${entry.requestField}')`,
      );
      const identifierKeys = Object.keys(entry.identifiers).sort(compareUtf16CodeUnits);
      if (
        requestKeys.length !== identifierKeys.length ||
        requestKeys.some((key, index) => key !== identifierKeys[index])
      ) {
        throw new ContractGenerationError(
          `${routeId}.${entry.requestField} and SqlIdentifierCatalogV1 differ: ` +
            `request=[${requestKeys.join(',')}], catalog=[${identifierKeys.join(',')}]`,
        );
      }
      return Object.freeze({
        routeId,
        requestField: entry.requestField,
        defaultKey: entry.defaultKey,
        identifiers: entry.identifiers,
      });
    });
  const projection = {
    schemaVersion: ADMIN_SQL_IDENTIFIER_CATALOG.schemaVersion,
    entries,
  } as const;
  return Object.freeze({
    ...projection,
    catalogDigest: fullHash(
      `sql-identifier-catalog.v1\0${canonicalWireJsonStringifyV1(projection)}`,
    ),
  });
}

function assertSqlIdentifierCatalogConsumers(program: ts.Program): void {
  const checker = program.getTypeChecker();
  for (const [file, expectedRoute] of Object.entries(SQL_IDENTIFIER_CONSUMER_ROUTES)) {
    const source = program.getSourceFile(resolve(REPO_ROOT, file));
    if (source === undefined) {
      throw new ContractGenerationError(`SQL identifier consumer is absent: ${file}`);
    }
    let resolverCount = 0;
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const resolverName = importedName(
          node.expression,
          checker,
          '@platform/admin-http-contracts',
        );
        if (resolverName === 'resolveAdminSqlIdentifier') {
          const parent = node.parent;
          const directOrderByArgument =
            ts.isCallExpression(parent) &&
            parent.arguments[0] === node &&
            ts.isPropertyAccessExpression(parent.expression) &&
            (parent.expression.name.text === 'orderBy' ||
              parent.expression.name.text === 'addOrderBy');
          if (!directOrderByArgument) {
            throw new ContractGenerationError(
              `${file} may consume SqlIdentifierCatalogV1 only as the direct TypeORM orderBy identifier`,
            );
          }
        }
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          (node.expression.name.text === 'orderBy' || node.expression.name.text === 'addOrderBy')
        ) {
          const identifier = node.arguments[0];
          const catalogResolver =
            identifier !== undefined &&
            ts.isCallExpression(identifier) &&
            importedName(identifier.expression, checker, '@platform/admin-http-contracts') ===
              'resolveAdminSqlIdentifier';
          if (identifier === undefined || (!ts.isStringLiteral(identifier) && !catalogResolver)) {
            throw new ContractGenerationError(
              `${file} ${node.expression.name.text} identifier must be a fixed literal or the direct SqlIdentifierCatalogV1 resolver`,
            );
          }
          if (catalogResolver) {
            const route = identifier.arguments[0];
            if (route === undefined || !ts.isStringLiteral(route) || route.text !== expectedRoute) {
              throw new ContractGenerationError(
                `${file} must resolve only ${expectedRoute} through SqlIdentifierCatalogV1`,
              );
            }
            resolverCount++;
          }
        }
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
    if (resolverCount !== 1) {
      throw new ContractGenerationError(
        `${file} must consume exactly one generated SQL identifier projection; found ${resolverCount}`,
      );
    }
  }
}

function exportedProgramSymbol(program: ts.Program, file: string, exportName: string): ts.Symbol {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(resolve(REPO_ROOT, file));
  const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
  const exported =
    moduleSymbol === undefined
      ? undefined
      : checker
          .getExportsOfModule(moduleSymbol)
          .find((candidate) => candidate.getName() === exportName);
  const authority = resolvedSymbol(exported, checker);
  if (authority === undefined) {
    throw new ContractGenerationError(`${file} must export the compiler authority ${exportName}`);
  }
  return authority;
}

function directUnaliasedNamedImport(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
  authority: ts.Symbol,
  exportName: string,
): boolean {
  const local = checker.getSymbolAtLocation(identifier);
  return (
    resolvedSymbol(local, checker) === authority &&
    (local?.declarations ?? []).some(
      (declaration) =>
        ts.isImportSpecifier(declaration) &&
        declaration.propertyName === undefined &&
        declaration.name.text === exportName,
    )
  );
}

function routeIdFromAuthorityExpression(
  expression: ts.Expression | undefined,
  checker: ts.TypeChecker,
  authority: ts.Symbol,
  authorityName: 'ADMIN_API_ROUTES' | 'ADMIN_BINARY_ROUTES',
): string | undefined {
  if (expression === undefined || !ts.isElementAccessExpression(expression)) return undefined;
  if (
    !ts.isIdentifier(expression.expression) ||
    !directUnaliasedNamedImport(expression.expression, checker, authority, authorityName)
  ) {
    return undefined;
  }
  const argument = expression.argumentExpression;
  return argument !== undefined && ts.isStringLiteral(argument) ? argument.text : undefined;
}

function moduleExportTargets(
  moduleSpecifier: ts.Expression,
  checker: ts.TypeChecker,
): readonly ts.Symbol[] {
  const moduleSymbol = checker.getSymbolAtLocation(moduleSpecifier);
  return moduleSymbol === undefined
    ? []
    : checker
        .getExportsOfModule(moduleSymbol)
        .map((symbol) => resolvedSymbol(symbol, checker))
        .filter((symbol): symbol is ts.Symbol => symbol !== undefined);
}

function isDomAuthority(
  identifier: ts.Identifier,
  checker: ts.TypeChecker,
  name: 'EventSource' | 'WebSocket' | 'XMLHttpRequest' | 'fetch' | 'sendBeacon',
): boolean {
  const symbol = resolvedSymbol(checker.getSymbolAtLocation(identifier), checker);
  return (
    symbol?.getName() === name &&
    (symbol.declarations ?? []).some((declaration) =>
      /\/lib\.(?:dom|webworker)(?:\.iterable)?\.d\.ts$/.test(
        declaration.getSourceFile().fileName.replaceAll('\\', '/'),
      ),
    )
  );
}

function forbiddenTransportModule(value: string): boolean {
  return /^(?:(?:axios|gaxios|got|ky|superagent|undici)(?:\/|$)|(?:node:)?https?$)/.test(value);
}

function staticJsonExpression(expression: ts.Expression): unknown {
  const value = unwrapExpression(expression);
  if (
    ts.isStringLiteral(value) ||
    ts.isNoSubstitutionTemplateLiteral(value) ||
    ts.isNumericLiteral(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword ||
    ts.isPrefixUnaryExpression(value)
  ) {
    return jsonLiteral(value);
  }
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.map((entry) => {
      if (ts.isSpreadElement(entry)) {
        throw new ContractGenerationError('generated GraphQL document contains spread syntax');
      }
      return staticJsonExpression(entry);
    });
  }
  if (ts.isObjectLiteralExpression(value)) {
    const record: Record<string, unknown> = {};
    for (const property of value.properties) {
      if (!ts.isPropertyAssignment(property)) {
        throw new ContractGenerationError(
          'generated GraphQL document must be a static JSON object',
        );
      }
      const name = propertyNameText(property.name, property.getSourceFile());
      record[name] = staticJsonExpression(property.initializer);
    }
    return record;
  }
  throw new ContractGenerationError(
    `${repoPath(value.getSourceFile().fileName)} generated GraphQL document is not static JSON`,
  );
}

function generatedGraphqlOperation(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  call: ts.CallExpression,
): FrontendGraphqlOperation {
  const declaration = (symbol.declarations ?? []).find(ts.isVariableDeclaration);
  if (declaration?.initializer === undefined) {
    throw new ContractGenerationError(
      `${symbol.getName()} is not a generated TypedDocumentNode constant`,
    );
  }
  const generatedSourceFile = repoPath(declaration.getSourceFile().fileName);
  if (generatedSourceFile !== FRONTEND_GRAPHQL_GENERATED) {
    throw new ContractGenerationError(`${symbol.getName()} lacks admin GraphQL codegen provenance`);
  }
  const signature = checker.getResolvedSignature(call);
  const resultType =
    signature === undefined
      ? undefined
      : checker.getAwaitedType(checker.getReturnTypeOfSignature(signature));
  const variables = call.arguments[1];
  if (resultType === undefined || variables === undefined) {
    throw new ContractGenerationError(
      `${symbol.getName()} GraphQL call lacks inferred result or variables proof`,
    );
  }
  const source = call.getSourceFile();
  const staticDocument = staticJsonExpression(declaration.initializer);
  const identity = graphqlOperationIdentityFromStaticDocument(staticDocument, symbol.getName());
  return {
    documentName: symbol.getName(),
    operationKind: identity.kind,
    operationName: identity.name,
    operationDigest: fullHash(
      `admin-graphql-operation.v1\0${canonicalWireJsonStringifyV1(staticDocument)}`,
    ),
    generatedSourceFile,
    sourceFile: repoPath(source.fileName),
    sourceLine: source.getLineAndCharacterOfPosition(call.getStart(source)).line + 1,
    resultType: checker.typeToString(resultType),
    variablesType: checker.typeToString(checker.getTypeAtLocation(variables)),
  };
}

function graphqlOperationIdentityFromStaticDocument(
  value: unknown,
  documentName: string,
): { readonly kind: 'mutation' | 'query' | 'subscription'; readonly name: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractGenerationError(`${documentName} GraphQL document must be an object`);
  }
  const definitions = unknownProperty(value, 'definitions');
  if (!isUnknownArray(definitions)) {
    throw new ContractGenerationError(`${documentName} GraphQL document lacks definitions`);
  }
  const operations = definitions.filter(
    (definition): definition is object =>
      isNonArrayObject(definition) && unknownProperty(definition, 'kind') === 'OperationDefinition',
  );
  if (operations.length !== 1) {
    throw new ContractGenerationError(
      `${documentName} GraphQL document must contain exactly one operation`,
    );
  }
  const operation = requiredValue(operations[0], `${documentName} GraphQL operation`);
  const kind = unknownProperty(operation, 'operation');
  const nameNode = unknownProperty(operation, 'name');
  const name = isNonArrayObject(nameNode) ? unknownProperty(nameNode, 'value') : undefined;
  if (
    (kind !== 'query' && kind !== 'mutation' && kind !== 'subscription') ||
    typeof name !== 'string' ||
    name.length === 0
  ) {
    throw new ContractGenerationError(
      `${documentName} GraphQL operation requires a supported kind and explicit name`,
    );
  }
  return { kind, name };
}

export interface FrontendTransportAudit {
  readonly demands: readonly FrontendDemand[];
  readonly graphqlOperations: readonly FrontendGraphqlOperation[];
  readonly graphqlKernelCallCount: number;
  readonly rawFetchCallCount: number;
  readonly rawFetchReferenceCount: number;
}

function discoverFrontendDemands(
  routes: readonly RouteAuthority[],
  program: ts.Program,
  includedSourceFiles?: readonly string[],
): FrontendTransportAudit {
  const checker = program.getTypeChecker();
  const apiFetchAuthority = exportedProgramSymbol(program, FRONTEND_TRANSPORT_KERNEL, 'apiFetch');
  const apiFetchBlobAuthority = exportedProgramSymbol(
    program,
    FRONTEND_TRANSPORT_KERNEL,
    'apiFetchBlob',
  );
  const apiRoutesAuthority = exportedProgramSymbol(program, RUNTIME_OUTPUT, 'ADMIN_API_ROUTES');
  const binaryRoutesAuthority = exportedProgramSymbol(
    program,
    RUNTIME_OUTPUT,
    'ADMIN_BINARY_ROUTES',
  );
  const executeAdminGraphqlAuthority = exportedProgramSymbol(
    program,
    FRONTEND_GRAPHQL_KERNEL,
    'executeAdminGraphql',
  );
  const graphqlClientAuthority = exportedProgramSymbol(program, SHARED_UI_ENTRY, 'graphqlClient');
  const useGraphqlQueryAuthority = exportedProgramSymbol(
    program,
    SHARED_UI_ENTRY,
    'useGraphQLQuery',
  );
  const useGraphqlMutationAuthority = exportedProgramSymbol(
    program,
    SHARED_UI_ENTRY,
    'useGraphQLMutation',
  );
  const generatedGraphqlSource = program.getSourceFile(
    resolve(REPO_ROOT, FRONTEND_GRAPHQL_GENERATED),
  );
  const generatedGraphqlModule =
    generatedGraphqlSource === undefined
      ? undefined
      : checker.getSymbolAtLocation(generatedGraphqlSource);
  if (generatedGraphqlModule === undefined) {
    throw new ContractGenerationError(
      `${FRONTEND_GRAPHQL_GENERATED} is absent from the frontend compiler program`,
    );
  }
  const graphqlDocumentAuthorities = checker
    .getExportsOfModule(generatedGraphqlModule)
    .map((symbol) => resolvedSymbol(symbol, checker))
    .filter(
      (symbol): symbol is ts.Symbol =>
        symbol !== undefined && symbol.getName().endsWith('Document'),
    );
  const governedAuthorities = new Set([
    apiFetchAuthority,
    apiFetchBlobAuthority,
    apiRoutesAuthority,
    binaryRoutesAuthority,
    executeAdminGraphqlAuthority,
    ...graphqlDocumentAuthorities,
  ]);
  const routesById = new Map(routes.map((route) => [route.id, route] as const));
  const demands: FrontendDemand[] = [];
  const graphqlOperations: FrontendGraphqlOperation[] = [];

  const frontendRoot = `${resolve(REPO_ROOT, FRONTEND_ROOT).replaceAll('\\', '/')}/`;
  const included =
    includedSourceFiles === undefined
      ? undefined
      : new Set(includedSourceFiles.map((file) => resolve(REPO_ROOT, file).replaceAll('\\', '/')));
  const productionSources = program
    .getSourceFiles()
    .filter((source) => {
      const file = source.fileName.replaceAll('\\', '/');
      if (included !== undefined) return included.has(file);
      return (
        file.startsWith(frontendRoot) &&
        !source.isDeclarationFile &&
        !/\.(?:spec|test)\.tsx?$/.test(file) &&
        !file.includes('/__tests__/')
      );
    })
    .sort((left, right) => compareUtf16CodeUnits(left.fileName, right.fileName));
  const violationKeys = new Set<string>();
  let kernelRawFetchCallCount = 0;
  let kernelRawFetchReferenceCount = 0;
  let graphqlKernelCallCount = 0;
  const pushViolation = (source: ts.SourceFile, node: ts.Node, reason: string): void => {
    const file = repoPath(source.fileName);
    const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
    const key = `${file}:${line}:${reason}`;
    if (violationKeys.has(key)) return;
    violationKeys.add(key);
    demands.push({
      sourceFile: file,
      sourceLine: line,
      readiness: 'RAW_TRANSPORT_ESCAPE',
      reason,
    });
  };

  for (const source of productionSources) {
    const file = repoPath(source.fileName);
    const visit = (node: ts.Node): void => {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier !== undefined &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        forbiddenTransportModule(node.moduleSpecifier.text)
      ) {
        pushViolation(source, node, `forbidden transport module ${node.moduleSpecifier.text}`);
      }
      if (ts.isImportDeclaration(node) && node.importClause?.namedBindings !== undefined) {
        const exported = new Set(moduleExportTargets(node.moduleSpecifier, checker));
        if (
          ts.isNamespaceImport(node.importClause.namedBindings) &&
          [...governedAuthorities].some((authority) => exported.has(authority))
        ) {
          pushViolation(
            source,
            node,
            'governed transport and route authorities forbid namespace imports',
          );
        }
        if (ts.isNamedImports(node.importClause.namedBindings)) {
          for (const specifier of node.importClause.namedBindings.elements) {
            const target = resolvedSymbol(checker.getSymbolAtLocation(specifier.name), checker);
            if (
              target !== undefined &&
              governedAuthorities.has(target) &&
              (specifier.propertyName !== undefined || specifier.name.text !== target.getName())
            ) {
              pushViolation(
                source,
                specifier,
                `governed authority ${target.getName()} forbids import aliases`,
              );
            }
          }
        }
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
        const targets =
          node.exportClause !== undefined && ts.isNamedExports(node.exportClause)
            ? node.exportClause.elements
                .map((specifier) =>
                  resolvedSymbol(checker.getSymbolAtLocation(specifier.name), checker),
                )
                .filter((symbol): symbol is ts.Symbol => symbol !== undefined)
            : moduleExportTargets(node.moduleSpecifier, checker);
        if (targets.some((target) => governedAuthorities.has(target))) {
          pushViolation(
            source,
            node,
            'governed transport and route authorities cannot be re-exported',
          );
        }
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === 'require')) &&
        node.arguments[0] !== undefined &&
        ts.isStringLiteral(node.arguments[0]) &&
        forbiddenTransportModule(node.arguments[0].text)
      ) {
        pushViolation(
          source,
          node,
          `dynamic loading of transport module ${node.arguments[0].text} is forbidden`,
        );
      }
      if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)) {
        const owner = node.expression.getText(source);
        if (
          node.argumentExpression.text === 'fetch' &&
          ['globalThis', 'self', 'window'].includes(owner)
        ) {
          pushViolation(source, node, 'computed global fetch access is forbidden');
        }
        if (node.argumentExpression.text === 'sendBeacon' && owner === 'navigator') {
          pushViolation(source, node, 'computed navigator.sendBeacon access is forbidden');
        }
      }
      if (ts.isIdentifier(node) && isDomAuthority(node, checker, 'XMLHttpRequest')) {
        pushViolation(source, node, 'XMLHttpRequest is outside the admin transport kernel');
      }
      if (ts.isIdentifier(node) && isDomAuthority(node, checker, 'WebSocket')) {
        pushViolation(source, node, 'WebSocket is outside a governed admin transport profile');
      }
      if (ts.isIdentifier(node) && isDomAuthority(node, checker, 'EventSource')) {
        pushViolation(source, node, 'EventSource is outside a governed admin transport profile');
      }
      if (ts.isIdentifier(node) && isDomAuthority(node, checker, 'sendBeacon')) {
        pushViolation(source, node, 'navigator.sendBeacon is outside the admin transport kernel');
      }
      if (ts.isIdentifier(node) && isDomAuthority(node, checker, 'fetch')) {
        const directCall = ts.isCallExpression(node.parent) && node.parent.expression === node;
        if (file === FRONTEND_TRANSPORT_KERNEL && directCall) {
          kernelRawFetchCallCount++;
          kernelRawFetchReferenceCount++;
        } else {
          if (file === FRONTEND_TRANSPORT_KERNEL) kernelRawFetchReferenceCount++;
          pushViolation(
            source,
            node,
            'global fetch may appear only as the sole direct transport-kernel call',
          );
        }
      }
      if (ts.isIdentifier(node)) {
        const symbol = resolvedSymbol(checker.getSymbolAtLocation(node), checker);
        if (symbol === useGraphqlQueryAuthority || symbol === useGraphqlMutationAuthority) {
          pushViolation(
            source,
            node,
            `${symbol.getName()} bypasses generated admin GraphQL operation authority`,
          );
        }
        if (symbol === graphqlClientAuthority) {
          if (ts.isImportSpecifier(node.parent)) {
            if (file !== FRONTEND_GRAPHQL_KERNEL) {
              pushViolation(
                source,
                node,
                'graphqlClient import is restricted to the admin GraphQL kernel',
              );
            }
          } else {
            const access =
              ts.isPropertyAccessExpression(node.parent) && node.parent.expression === node
                ? node.parent
                : undefined;
            const call =
              access !== undefined &&
              access.name.text === 'request' &&
              ts.isCallExpression(access.parent) &&
              access.parent.expression === access
                ? access.parent
                : undefined;
            if (
              file === FRONTEND_GRAPHQL_KERNEL &&
              call !== undefined &&
              (call.typeArguments?.length ?? 0) === 0
            ) {
              graphqlKernelCallCount++;
            } else {
              pushViolation(
                source,
                node,
                'graphqlClient may appear only as the sole non-generic admin GraphQL kernel call',
              );
            }
          }
        }
      }
      if (ts.isCallExpression(node)) {
        const calleeLocation = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name
          : node.expression;
        const callSymbol = resolvedSymbol(checker.getSymbolAtLocation(calleeLocation), checker);
        const isJsonAuthority = callSymbol === apiFetchAuthority;
        const isBinaryAuthority = callSymbol === apiFetchBlobAuthority;
        const isGraphqlAuthority = callSymbol === executeAdminGraphqlAuthority;
        const syntacticGraphqlName =
          (ts.isIdentifier(calleeLocation) || ts.isStringLiteral(calleeLocation)) &&
          calleeLocation.text === 'executeAdminGraphql';
        if (!isGraphqlAuthority && syntacticGraphqlName) {
          pushViolation(
            source,
            node,
            'executeAdminGraphql call lacks admin GraphQL kernel provenance',
          );
        }
        if (isGraphqlAuthority) {
          if (
            !ts.isIdentifier(node.expression) ||
            !directUnaliasedNamedImport(
              node.expression,
              checker,
              executeAdminGraphqlAuthority,
              'executeAdminGraphql',
            ) ||
            (node.typeArguments?.length ?? 0) !== 0
          ) {
            pushViolation(
              source,
              node,
              'executeAdminGraphql requires a direct unaliased import and forbids caller generics',
            );
            node.forEachChild(visit);
            return;
          }
          const document = node.arguments[0];
          const documentLocal =
            document !== undefined && ts.isIdentifier(document)
              ? checker.getSymbolAtLocation(document)
              : undefined;
          const documentAuthority = resolvedSymbol(documentLocal, checker);
          if (
            document === undefined ||
            !ts.isIdentifier(document) ||
            documentAuthority === undefined ||
            !graphqlDocumentAuthorities.includes(documentAuthority) ||
            !directUnaliasedNamedImport(
              document,
              checker,
              documentAuthority,
              documentAuthority.getName(),
            )
          ) {
            pushViolation(
              source,
              node,
              'admin GraphQL calls require a direct generated TypedDocumentNode authority',
            );
          } else {
            const operation = generatedGraphqlOperation(documentAuthority, checker, node);
            graphqlOperations.push(operation);
            demands.push({
              sourceFile: file,
              sourceLine: line,
              routeId: `GRAPHQL ${operation.documentName}`,
              readiness: 'GOVERNED',
            });
          }
          node.forEachChild(visit);
          return;
        }
        const governedCall = isJsonAuthority || isBinaryAuthority;
        const syntacticGovernedName =
          (ts.isIdentifier(calleeLocation) || ts.isStringLiteral(calleeLocation)) &&
          (calleeLocation.text === 'apiFetch' || calleeLocation.text === 'apiFetchBlob');
        if (!governedCall && syntacticGovernedName) {
          pushViolation(
            source,
            node,
            `${calleeLocation.text} call lacks transport-kernel symbol provenance`,
          );
        }
        if (!governedCall) {
          node.forEachChild(visit);
          return;
        }
        const isBinary = isBinaryAuthority;
        const transportAuthorityName = isBinary ? 'apiFetchBlob' : 'apiFetch';
        if (
          !ts.isIdentifier(node.expression) ||
          !directUnaliasedNamedImport(
            node.expression,
            checker,
            isBinary ? apiFetchBlobAuthority : apiFetchAuthority,
            transportAuthorityName,
          )
        ) {
          pushViolation(
            source,
            node,
            `${transportAuthorityName} must be a direct unaliased named import from the transport kernel`,
          );
          node.forEachChild(visit);
          return;
        }
        const routeAuthorityName = isBinary ? 'ADMIN_BINARY_ROUTES' : 'ADMIN_API_ROUTES';
        if ((node.typeArguments?.length ?? 0) > 0) {
          demands.push({
            sourceFile: file,
            sourceLine: line,
            readiness: 'GENERIC_TYPE_ARGUMENT',
            reason: `${node.expression.text}<T> lets the caller invent an unchecked response type`,
          });
        } else {
          const routeId = routeIdFromAuthorityExpression(
            node.arguments[0],
            checker,
            isBinary ? binaryRoutesAuthority : apiRoutesAuthority,
            routeAuthorityName,
          );
          if (routeId === undefined) {
            demands.push({
              sourceFile: file,
              sourceLine: line,
              readiness: 'MISSING_ROUTE_AUTHORITY',
            });
          } else {
            const route = routesById.get(routeId);
            if (route === undefined) {
              demands.push({
                sourceFile: file,
                sourceLine: line,
                routeId,
                readiness: 'UNKNOWN_ROUTE_AUTHORITY',
              });
            } else if (route.lifecycle !== 'ACTIVE') {
              demands.push({
                sourceFile: file,
                sourceLine: line,
                routeId,
                readiness: 'NON_ACTIVE_ROUTE_AUTHORITY',
                reason: `route lifecycle is ${route.lifecycle}`,
              });
            } else if (
              (!isBinary && route.response.transport !== 'json-envelope') ||
              (isBinary && route.response.transport !== 'binary-download')
            ) {
              demands.push({
                sourceFile: file,
                sourceLine: line,
                routeId,
                readiness: isBinary ? 'WRONG_TRANSPORT_AUTHORITY' : 'MANUAL_PROFILE_ROUTE',
                reason: `route transport is ${route.response.transport}`,
              });
            } else if (node.arguments.length > 2) {
              demands.push({
                sourceFile: file,
                sourceLine: line,
                routeId,
                readiness: 'ARBITRARY_REQUEST_SURFACE',
                reason: `${transportAuthorityName} accepts only route authority plus one route-shaped input`,
              });
            } else if (
              node.arguments[1] !== undefined &&
              (!ts.isObjectLiteralExpression(node.arguments[1]) ||
                node.arguments[1].properties.some((property) => ts.isSpreadAssignment(property)))
            ) {
              demands.push({
                sourceFile: file,
                sourceLine: line,
                routeId,
                readiness: 'ARBITRARY_REQUEST_SURFACE',
                reason: 'route request input must be one explicit, non-spread object literal',
              });
            } else {
              demands.push({
                sourceFile: file,
                sourceLine: line,
                routeId,
                readiness: 'GOVERNED',
              });
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    source.forEachChild(visit);
  }
  if (kernelRawFetchCallCount !== 1 || kernelRawFetchReferenceCount !== 1) {
    demands.push({
      sourceFile: FRONTEND_TRANSPORT_KERNEL,
      sourceLine: 1,
      readiness: 'RAW_TRANSPORT_ESCAPE',
      reason:
        'transport kernel must own exactly one direct global fetch call and one total ' +
        `fetch reference; found calls=${kernelRawFetchCallCount}, references=${kernelRawFetchReferenceCount}`,
    });
  }
  if (graphqlKernelCallCount !== 1) {
    demands.push({
      sourceFile: FRONTEND_GRAPHQL_KERNEL,
      sourceLine: 1,
      readiness: 'RAW_TRANSPORT_ESCAPE',
      reason: `admin GraphQL kernel must own exactly one graphqlClient.request call; found ${graphqlKernelCallCount}`,
    });
  }
  if (includedSourceFiles === undefined) {
    const generatedNames = graphqlDocumentAuthorities
      .map((authority) => authority.getName())
      .sort(compareUtf16CodeUnits);
    const usedNames = [
      ...new Set(graphqlOperations.map((operation) => operation.documentName)),
    ].sort(compareUtf16CodeUnits);
    if (
      generatedNames.length !== usedNames.length ||
      generatedNames.some((name, index) => name !== usedNames[index])
    ) {
      throw new ContractGenerationError(
        `admin GraphQL generated/used document set mismatch: generated=[${generatedNames.join(
          ',',
        )}], used=[${usedNames.join(',')}]`,
      );
    }
    const byOperationName = new Map<string, string>();
    for (const operation of graphqlOperations) {
      const previous = byOperationName.get(operation.operationName);
      if (previous !== undefined && previous !== operation.documentName) {
        throw new ContractGenerationError(
          `admin GraphQL operation name ${operation.operationName} is owned by both ${previous} and ${operation.documentName}`,
        );
      }
      byOperationName.set(operation.operationName, operation.documentName);
    }
  }
  return {
    demands: demands.sort(
      (left, right) =>
        compareUtf16CodeUnits(left.sourceFile, right.sourceFile) ||
        left.sourceLine - right.sourceLine ||
        compareUtf16CodeUnits(left.reason ?? '', right.reason ?? ''),
    ),
    graphqlOperations: graphqlOperations.sort(
      (left, right) =>
        compareUtf16CodeUnits(left.documentName, right.documentName) ||
        compareUtf16CodeUnits(left.sourceFile, right.sourceFile) ||
        left.sourceLine - right.sourceLine,
    ),
    graphqlKernelCallCount,
    rawFetchCallCount: kernelRawFetchCallCount,
    rawFetchReferenceCount: kernelRawFetchReferenceCount,
  };
}

export function auditFrontendTransportFixtureProgram(
  program: ts.Program,
  fixtureFiles: readonly string[],
): FrontendTransportAudit {
  return discoverFrontendDemands([], program, [
    FRONTEND_TRANSPORT_KERNEL,
    FRONTEND_GRAPHQL_KERNEL,
    ...fixtureFiles,
  ]);
}

function renderContract(node: ContractNode, indent = ''): string {
  const nested = `${indent}  `;
  switch (node.kind) {
    case 'string':
      return 'adminResponse.string()';
    case 'number':
      return 'adminResponse.number()';
    case 'boolean':
      return 'adminResponse.boolean()';
    case 'date-string':
      return 'adminResponse.dateString()';
    case 'never':
      return 'adminResponse.never()';
    case 'void':
      return 'adminResponse.void()';
    case 'json':
      return `adminResponse.json(${JSON.stringify(node.reason)})`;
    case 'literal':
      return `adminResponse.literal(${JSON.stringify(node.value)})`;
    case 'array':
    case 'page':
      return `adminResponse.${node.kind}(${renderContract(node.item, indent)})`;
    case 'optional':
    case 'nullable':
    case 'record':
      return `adminResponse.${node.kind}(${renderContract(node.value, indent)})`;
    case 'tuple':
      return `adminResponse.tuple([\n${node.items
        .map((item) => `${nested}${renderContract(item, nested)},`)
        .join('\n')}\n${indent}] as const)`;
    case 'union':
      return `adminResponse.union([\n${node.variants
        .map((variant) => `${nested}${renderContract(variant, nested)},`)
        .join('\n')}\n${indent}] as const)`;
    case 'object': {
      const fields = Object.entries(node.fields).sort(([left], [right]) =>
        compareUtf16CodeUnits(left, right),
      );
      return `adminResponse.object({\n${fields
        .map(
          ([name, field]) => `${nested}${JSON.stringify(name)}: ${renderContract(field, nested)},`,
        )
        .join('\n')}\n${indent}})`;
    }
  }
}

function renderManualProfile(node: ManualProfileNode): string {
  if (node.kind === 'binary-download') {
    return `adminManualResponse.binary(${JSON.stringify(node.statusCodes)}, ${JSON.stringify(
      node.mediaTypes,
    )}, ${node.maxBytes})`;
  }
  return `adminManualResponse.health(${JSON.stringify(node.statusCodes)}, ${renderContract(
    node.body,
  )})`;
}

function renderArtifact(
  routes: readonly RouteAuthority[],
  namedProjections: readonly NamedProjection[],
  frontendAudit: FrontendTransportAudit,
  frontendCompilerDiagnostics: readonly ts.Diagnostic[],
  canonicalJsonAuthority: CanonicalJsonAuthorityProjectionV1,
): GeneratedArtifact {
  const demands = frontendAudit.demands;
  const frontendCompilerDiagnosticCount = frontendCompilerDiagnostics.length;
  const schemas = new Map<string, ContractNode>();
  for (const route of routes) {
    if (route.response.mode !== 'contract') continue;
    const previous = schemas.get(route.response.schemaDigest);
    if (
      previous !== undefined &&
      canonicalWireJsonStringifyV1(previous) !==
        canonicalWireJsonStringifyV1(route.response.contract.node)
    ) {
      throw new ContractGenerationError(`SHA-256 collision at ${route.response.schemaDigest}`);
    }
    schemas.set(route.response.schemaDigest, route.response.contract.node);
  }
  for (const projection of namedProjections) {
    const previous = schemas.get(projection.schemaDigest);
    if (
      previous !== undefined &&
      canonicalWireJsonStringifyV1(previous) !==
        canonicalWireJsonStringifyV1(projection.contract.node)
    ) {
      throw new ContractGenerationError(`SHA-256 collision at ${projection.schemaDigest}`);
    }
    schemas.set(projection.schemaDigest, projection.contract.node);
  }

  const contractRoutes = routes.filter(
    (route): route is RouteAuthority & { readonly response: ContractedResponse } =>
      route.response.mode === 'contract',
  );
  const bypassRoutes = routes.filter(
    (route): route is RouteAuthority & { readonly response: BypassResponse } =>
      route.response.mode === 'bypass',
  );
  const activeRoutes = routes.filter((route) => route.lifecycle === 'ACTIVE');
  const browserContractRoutes = contractRoutes.filter((route) => route.lifecycle === 'ACTIVE');
  const browserBypassRoutes = bypassRoutes.filter((route) => route.lifecycle === 'ACTIVE');
  const governedSchemalessJsonBoundaries = contractRoutes.flatMap((route) =>
    schemalessJsonBoundaries(route.response.contract.node),
  );
  const violationCount = demands.filter((demand) => demand.readiness !== 'GOVERNED').length;
  const matcherOrderProofs = assertNoSemanticRouteCollisions(
    routes.map((route) => routeMatcherCandidate(route)),
  );
  const sqlIdentifierCatalog = compileSqlIdentifierCatalog(routes);
  const requestRuntimeProofs = routes.flatMap((route) => route.request.runtimeProofs);
  const publicRoutes = routes.map((route) => ({
    id: route.id,
    method: route.method,
    path: route.path,
    networkAliases: route.networkAliases,
    successStatusCode: route.successStatusCode,
    lifecycle: route.lifecycle,
    controller: {
      file: route.controllerFile,
      class: route.controllerClass,
      method: route.controllerMethod,
      line: route.controllerLine,
      manualResponse: route.manualResponse,
    },
    authorization: route.authorization,
    request: route.request,
    response:
      route.response.mode === 'contract'
        ? {
            mode: route.response.mode,
            transport: route.response.transport,
            contractName: route.response.contract.name,
            contractSourceFile: route.response.contract.sourceFile,
            contractSourceLine: route.response.contract.sourceLine,
            schemaDigest: route.response.schemaDigest,
            returnAssignable: route.response.returnAssignable,
            returnType: route.response.returnType,
            returnDeclarationOrigins: route.response.returnDeclarationOrigins,
            schemalessJsonBoundaries: schemalessJsonBoundaries(route.response.contract.node),
          }
        : {
            mode: route.response.mode,
            transport: route.response.transport,
            profileName: route.response.profile.name,
            profileSourceFile: route.response.profile.sourceFile,
            profileSourceLine: route.response.profile.sourceLine,
            profile: route.response.profile.node,
          },
  }));
  const runtimeProjection = {
    schemaVersion: 'admin-route-runtime-projection.v4',
    jsonDecoderRegistry: {
      schemaVersion: ADMIN_JSON_DECODER_REGISTRY_PROJECTION.schemaVersion,
      digest: ADMIN_JSON_DECODER_REGISTRY_DIGEST,
    },
    schemas: [...schemas.entries()]
      .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
      .map(([digest, node]) => ({ digest, node })),
    routes: activeRoutes.map((route) => ({
      id: route.id,
      method: route.method,
      path: route.path,
      successStatusCode: route.successStatusCode,
      authorization: route.authorization,
      request: {
        path: route.request.path,
        query: route.request.query,
        queryCodecs: route.request.queryCodecs,
        headers: route.request.headers,
        body: route.request.body,
        contentType: route.request.contentType,
        schemaDigest: route.request.schemaDigest,
      },
      response:
        route.response.mode === 'contract'
          ? {
              mode: route.response.mode,
              transport: route.response.transport,
              schemaDigest: route.response.schemaDigest,
            }
          : {
              mode: route.response.mode,
              transport: route.response.transport,
              profile: route.response.profile.node,
            },
    })),
    namedProjections: namedProjections.map((projection) => ({
      id: projection.id,
      schemaDigest: projection.schemaDigest,
    })),
  } as const;
  const runtimeProjectionDigest = fullHash(
    `admin-route-runtime-projection.v4\0${canonicalArtifactJson(
      runtimeProjection,
      'browser runtime projection',
    )}`,
  );
  const serverRequestRuntimeProjection = {
    schemaVersion: 'admin-server-route-runtime-projection.v3',
    sqlIdentifierCatalogDigest: sqlIdentifierCatalog.catalogDigest,
    lifecycleExceptions: routes
      .filter((route) => route.lifecycle !== 'ACTIVE')
      .map((route) => ({ id: route.id, lifecycle: route.lifecycle })),
    routes: routes.map((route) => ({
      id: route.id,
      authorization: route.authorization,
      request: {
        path: route.request.path,
        query: route.request.query,
        queryCodecs: route.request.queryCodecs,
        headers: route.request.headers,
        body: route.request.body,
        contentType: route.request.contentType,
        schemaDigest: route.request.schemaDigest,
      },
    })),
  } as const;
  const serverRequestRuntimeProjectionDigest = fullHash(
    `admin-server-route-runtime-projection.v3\0${canonicalArtifactJson(
      serverRequestRuntimeProjection,
      'server request runtime projection',
    )}`,
  );
  const manifestCore = {
    schemaVersion: 'admin-route-contract-manifest.v7',
    authority: 'executable-admin-http-contract-dag',
    digestAlgorithm: HASH_LINKED_CANONICAL_WIRE_JSON_ALGORITHM_V1,
    artifacts: {
      runtime: {
        path: RUNTIME_OUTPUT,
        projectionDigest: runtimeProjectionDigest,
      },
      serverRequestRuntime: {
        path: SERVER_REQUEST_RUNTIME_OUTPUT,
        projectionDigest: serverRequestRuntimeProjectionDigest,
      },
      evidence: {
        path: EVIDENCE_OUTPUT,
      },
    },
    compilerGate: 'typescript.getPreEmitDiagnostics',
    routePolicy: ADMIN_HTTP_ROUTE_POLICY,
    schemalessJsonDecoderRegistry: {
      ...ADMIN_JSON_DECODER_REGISTRY_PROJECTION,
      registryDigest: ADMIN_JSON_DECODER_REGISTRY_DIGEST,
    },
    matcherOrderProofs,
    runtimeProjection,
    serverRequestRuntimeProjection,
    sqlIdentifierCatalog,
    canonicalJsonAuthority,
    summary: {
      routeCount: routes.length,
      activeRouteCount: activeRoutes.length,
      internalGatewayOnlyRouteCount: routes.filter(
        (route) => route.lifecycle === 'INTERNAL_GATEWAY_ONLY',
      ).length,
      contractRouteCount: contractRoutes.length,
      bypassRouteCount: bypassRoutes.length,
      manualResponseRouteCount: routes.filter((route) => route.manualResponse !== undefined).length,
      schemalessJsonBoundaryCount: governedSchemalessJsonBoundaries.length,
      governedSchemalessJsonBoundaryCount: governedSchemalessJsonBoundaries.length,
      unregisteredSchemalessJsonBoundaryCount: 0,
      uniqueSchemaCount: schemas.size,
      namedProjectionCount: namedProjections.length,
      frontendDemandCount: demands.length,
      governedFrontendDemandCount: demands.length - violationCount,
      violationCount,
      duplicateRouteIds: [] as string[],
      matcherOrderProofCount: matcherOrderProofs.length,
      requestParameterCount: requestRuntimeProofs.length,
      generatedRequestDecoderCoverageCount: requestRuntimeProofs.length,
      runtimeClassRequestParameterCount: requestRuntimeProofs.filter(
        (proof) => proof.metatype === 'class',
      ).length,
      runtimeErasedRequestParameterCount: requestRuntimeProofs.filter(
        (proof) => proof.metatype === 'erased',
      ).length,
      classValidatorCoveredRequestParameterCount: requestRuntimeProofs.filter(
        (proof) => proof.coverage === 'GENERATED_DECODER_AND_CLASS_VALIDATOR',
      ).length,
      sqlIdentifierRouteCount: sqlIdentifierCatalog.entries.length,
      publicRouteCount: routes.filter((route) => route.authorization.authentication === 'public')
        .length,
      platformAdminRouteCount: routes.filter(
        (route) => route.authorization.authentication === 'bearer-session',
      ).length,
      canonicalJsonAuthorityCallCount: canonicalJsonAuthority.callCount,
      canonicalJsonAuthorityConsumerCount: canonicalJsonAuthority.consumerFiles.length,
    },
    routes: publicRoutes,
    namedProjections: namedProjections.map((projection) => ({
      id: projection.id,
      name: projection.name,
      sourceFile: projection.sourceFile,
      sourceLine: projection.sourceLine,
      contractName: projection.contract.name,
      schemaDigest: projection.schemaDigest,
    })),
    frontendDemands: demands,
    frontendTransport: {
      kernel: FRONTEND_TRANSPORT_KERNEL,
      rawFetchCallCount: frontendAudit.rawFetchCallCount,
      rawFetchReferenceCount: frontendAudit.rawFetchReferenceCount,
      graphql: {
        kernel: FRONTEND_GRAPHQL_KERNEL,
        kernelCallCount: frontendAudit.graphqlKernelCallCount,
        generatedDocuments: FRONTEND_GRAPHQL_GENERATED,
        schemaRegistry: GRAPHQL_SCHEMA_REGISTRY,
        schemaRegistryHash: graphqlSchemaRegistryHash(),
        operations: frontendAudit.graphqlOperations,
      },
      allowedExternalTransportBoundaries: ['generated-graphql'] as const,
    },
  } as const;
  const manifestDigest = fullHash(
    `admin-route-contract-manifest.v7\0${hashLinkedCanonicalWireJsonSha256V1(manifestCore)}`,
  );
  const manifest = { ...manifestCore, manifestDigest } as const;

  const schemaDeclarations = [...schemas.entries()]
    .sort(([left], [right]) => compareUtf16CodeUnits(left, right))
    .map(([digest, node]) => `const adminResponseSchema_${digest} = ${renderContract(node)};`)
    .join('\n\n');
  const requestDeclarations = routes
    .map(
      (route) =>
        `const adminRequestSchema_${route.request.schemaDigest} = createAdminRequestContract(` +
        `${renderContract(route.request.path)}, ${renderContract(route.request.query)}, ` +
        `${canonicalWireJsonStringifyV1(route.request.queryCodecs)}, ${renderContract(
          route.request.headers,
        )}, ` +
        `${renderContract(route.request.body)}, ` +
        `${JSON.stringify(route.request.contentType)});`,
    )
    .filter((declaration, index, declarations) => declarations.indexOf(declaration) === index)
    .join('\n\n');
  const authorizationDefinitions = [
    ...new Map(
      routes.map((route) => {
        const digest = fullHash(
          `admin-route-authorization.v1\0${canonicalWireJsonStringifyV1(route.authorization)}`,
        );
        const symbol = `adminRouteAuthorization_${digest}`;
        const initializer =
          `createAdminRouteAuthorizationV1(${JSON.stringify(
            route.authorization.authentication,
          )}, ${canonicalWireJsonStringifyV1(route.authorization.requiredRoles)}, ` +
          `${canonicalWireJsonStringifyV1(route.authorization.requiredPermissions)})`;
        return [digest, { digest, symbol, initializer }] as const;
      }),
    ).values(),
  ].sort((left, right) => compareUtf16CodeUnits(left.digest, right.digest));
  const authorizationDeclarations = authorizationDefinitions
    .map(({ symbol, initializer }) => `const ${symbol} = ${initializer}`)
    .join('\n');
  const authorizationSymbolFor = (route: RouteAuthority): string =>
    `adminRouteAuthorization_${fullHash(
      `admin-route-authorization.v1\0${canonicalWireJsonStringifyV1(route.authorization)}`,
    )}`;
  const serverRequestCatalogDeclarations = routes
    .map(
      (route) => `  ${JSON.stringify(route.id)}: adminRequestSchema_${route.request.schemaDigest},`,
    )
    .join('\n');
  const serverAuthorizationCatalogDeclarations = routes
    .map((route) => `  ${JSON.stringify(route.id)}: ${authorizationSymbolFor(route)},`)
    .join('\n');
  const serverLifecycleCatalogDeclarations = routes
    .map((route) => `  ${JSON.stringify(route.id)}: ${JSON.stringify(route.lifecycle)},`)
    .join('\n');
  const routeRuntimeDefinitions = browserContractRoutes.map((route) => {
    const response = route.response;
    const symbol = `adminRouteDefinition_${fullHash(`admin-route-definition\0${route.id}`)}`;
    const initializer =
      `createAdminRouteDefinition(${JSON.stringify(route.method)}, ${JSON.stringify(
        route.path,
      )}, adminRequestSchema_${route.request.schemaDigest}, ` +
      `${authorizationSymbolFor(route)}, ${route.successStatusCode}, ` +
      `adminResponseSchema_${response.schemaDigest})`;
    return { route, symbol, initializer } as const;
  });
  const routeDefinitionDeclarations = routeRuntimeDefinitions
    .map(({ symbol, initializer }) => `const ${symbol} = ${initializer};`)
    .join('\n');
  const routeDeclarations = routeRuntimeDefinitions
    .map(({ route, symbol }) => `  ${JSON.stringify(route.id)}: ${symbol},`)
    .join('\n');
  const routeCatalogTypeDeclarations = routeRuntimeDefinitions
    .map(({ route, symbol }) => `  readonly ${JSON.stringify(route.id)}: typeof ${symbol};`)
    .join('\n');
  const bypassDeclarations = browserBypassRoutes
    .map((route) => {
      const response = route.response;
      return `  ${JSON.stringify(route.id)}: ${renderManualProfile(response.profile.node)},`;
    })
    .join('\n');
  const binaryDeclarations = browserBypassRoutes
    .filter((route) => route.response.transport === 'binary-download')
    .map((route) => {
      const response = route.response;
      return (
        `  ${JSON.stringify(route.id)}: createAdminBinaryRouteDefinition(${JSON.stringify(
          route.method,
        )}, ${JSON.stringify(route.path)}, adminRequestSchema_${route.request.schemaDigest}, ` +
        `${authorizationSymbolFor(route)}, ` +
        `${renderManualProfile(response.profile.node)}),`
      );
    })
    .join('\n');
  const projectionDeclarations = namedProjections
    .map(
      (projection) =>
        `  ${JSON.stringify(projection.id)}: adminResponseSchema_${projection.schemaDigest},`,
    )
    .join('\n');
  const graphqlOperations = [
    ...new Map(
      frontendAudit.graphqlOperations.map((operation) => [operation.operationName, operation]),
    ).values(),
  ].sort((left, right) => compareUtf16CodeUnits(left.operationName, right.operationName));
  const graphqlDocumentImports = [...new Set(graphqlOperations.map((entry) => entry.documentName))]
    .sort(compareUtf16CodeUnits)
    .map((documentName) => `  ${documentName},`)
    .join('\n');
  const graphqlOperationCatalogDeclarations = graphqlOperations
    .map(
      (operation) =>
        `  ${JSON.stringify(operation.operationName)}: Object.freeze({ documentName: ${JSON.stringify(
          operation.documentName,
        )}, document: freezeAdminGraphqlDocument(${operation.documentName}), kind: ${JSON.stringify(
          operation.operationKind,
        )}, digest: ${JSON.stringify(operation.operationDigest)} }),`,
    )
    .join('\n');

  const runtimeContent = `/**
 * GENERATED — DO NOT EDIT.
 *
 * Minimal browser runtime produced from the executable @AdminResponseContract
 * DAG. CI provenance lives in ${EVIDENCE_OUTPUT} and is deliberately excluded
 * from the browser module graph.
 */
import {
  adminResponse,
  adminManualResponse,
  createAdminBinaryRouteDefinition,
  createAdminRequestContract,
  createAdminRouteAuthorizationV1,
  createAdminRouteDefinition,
  type AdminRouteRequestInput,
  type AdminWireResponseOf,
} from '@platform/admin-http-contracts';
${graphqlDocumentImports.length === 0 ? '' : `import {\n${graphqlDocumentImports}\n} from '../../../generated/graphql';`}

export const ADMIN_ROUTE_RUNTIME_PROJECTION = Object.freeze({
  schemaVersion: ${JSON.stringify(runtimeProjection.schemaVersion)},
  digest: ${JSON.stringify(runtimeProjectionDigest)},
} as const);

function freezeAdminGraphqlDocument<TDocument extends object>(document: TDocument): TDocument {
  const visited = new WeakSet<object>();
  const freeze = (value: unknown): void => {
    if (typeof value !== 'object' || value === null || visited.has(value)) return;
    visited.add(value);
    for (const key of Reflect.ownKeys(value)) freeze(Reflect.get(value, key));
    Object.freeze(value);
  };
  freeze(document);
  return document;
}

export const ADMIN_GRAPHQL_OPERATION_CATALOG = Object.freeze({
${graphqlOperationCatalogDeclarations}
} as const);

${schemaDeclarations}

${requestDeclarations}

${authorizationDeclarations}

${routeDefinitionDeclarations}

export const ADMIN_API_ROUTES: {
${routeCatalogTypeDeclarations}
} = Object.freeze({
${routeDeclarations}
});

export const ADMIN_RESPONSE_PROJECTIONS = Object.freeze({
${projectionDeclarations}
} as const);

export const ADMIN_BINARY_ROUTES = Object.freeze({
${binaryDeclarations}
} as const);

export const ADMIN_MANUAL_RESPONSE_PROFILES = Object.freeze({
${bypassDeclarations}
} as const);

export type AdminApiRouteId = keyof typeof ADMIN_API_ROUTES;
export type AdminApiRoute = (typeof ADMIN_API_ROUTES)[AdminApiRouteId];
export type AdminBinaryRouteId = keyof typeof ADMIN_BINARY_ROUTES;
export type AdminBinaryRoute = (typeof ADMIN_BINARY_ROUTES)[AdminBinaryRouteId];
export type AdminApiRouteResponse<TId extends AdminApiRouteId> =
  AdminWireResponseOf<(typeof ADMIN_API_ROUTES)[TId]['contract']>;
export type AdminApiRouteRequest<TId extends AdminApiRouteId> =
  AdminRouteRequestInput<(typeof ADMIN_API_ROUTES)[TId]['request']>;
export type AdminBinaryRouteRequest<TId extends AdminBinaryRouteId> =
  AdminRouteRequestInput<(typeof ADMIN_BINARY_ROUTES)[TId]['request']>;
type AdminApiRouteRequestSection<
  TId extends AdminApiRouteId,
  TSection extends 'body' | 'headers' | 'path' | 'query',
> = AdminApiRouteRequest<TId> extends { readonly [TKey in TSection]: infer TValue }
  ? TValue
  : AdminApiRouteRequest<TId> extends { readonly [TKey in TSection]?: infer TValue }
    ? TValue
    : never;
export type AdminApiRouteBody<TId extends AdminApiRouteId> =
  AdminApiRouteRequestSection<TId, 'body'>;
export type AdminApiRouteHeaders<TId extends AdminApiRouteId> =
  AdminApiRouteRequestSection<TId, 'headers'>;
export type AdminApiRoutePath<TId extends AdminApiRouteId> =
  AdminApiRouteRequestSection<TId, 'path'>;
export type AdminApiRouteQuery<TId extends AdminApiRouteId> =
  AdminApiRouteRequestSection<TId, 'query'>;
type AdminBinaryRouteRequestSection<
  TId extends AdminBinaryRouteId,
  TSection extends 'body' | 'headers' | 'path' | 'query',
> = AdminBinaryRouteRequest<TId> extends { readonly [TKey in TSection]: infer TValue }
  ? TValue
  : AdminBinaryRouteRequest<TId> extends { readonly [TKey in TSection]?: infer TValue }
    ? TValue
    : never;
export type AdminBinaryRouteBody<TId extends AdminBinaryRouteId> =
  AdminBinaryRouteRequestSection<TId, 'body'>;
export type AdminBinaryRouteHeaders<TId extends AdminBinaryRouteId> =
  AdminBinaryRouteRequestSection<TId, 'headers'>;
export type AdminBinaryRoutePath<TId extends AdminBinaryRouteId> =
  AdminBinaryRouteRequestSection<TId, 'path'>;
export type AdminBinaryRouteQuery<TId extends AdminBinaryRouteId> =
  AdminBinaryRouteRequestSection<TId, 'query'>;
export type AdminResponseProjectionId = keyof typeof ADMIN_RESPONSE_PROJECTIONS;
export type AdminResponseProjectionById<TId extends AdminResponseProjectionId> =
  AdminWireResponseOf<(typeof ADMIN_RESPONSE_PROJECTIONS)[TId]>;
`;
  const serverRequestRuntimeContent = `/**
 * GENERATED — DO NOT EDIT.
 *
 * Backend-only request decoder graph compiled from every Nest route parameter.
 * The bootstrap guard is the single runtime consumer; ValidationPipe runs after
 * this graph and remains authoritative for class-validator metadata.
 */
import {
  adminResponse,
  createAdminRequestContract,
  createAdminRouteAuthorizationV1,
  type AdminServerRouteAuthorizationCatalogV1,
  type AdminServerRequestContractCatalogV1,
} from '@platform/admin-http-contracts';

export const ADMIN_SERVER_REQUEST_RUNTIME_PROJECTION = Object.freeze({
  schemaVersion: ${JSON.stringify(serverRequestRuntimeProjection.schemaVersion)},
  digest: ${JSON.stringify(serverRequestRuntimeProjectionDigest)},
  routeCount: ${routes.length},
  sqlIdentifierCatalogDigest: ${JSON.stringify(sqlIdentifierCatalog.catalogDigest)},
} as const);

${requestDeclarations}

${authorizationDeclarations}

export const ADMIN_SERVER_REQUEST_CONTRACTS: AdminServerRequestContractCatalogV1 = Object.freeze({
${serverRequestCatalogDeclarations}
});

export const ADMIN_SERVER_ROUTE_AUTHORIZATION: AdminServerRouteAuthorizationCatalogV1 =
  Object.freeze({
${serverAuthorizationCatalogDeclarations}
  });

export const ADMIN_SERVER_ROUTE_LIFECYCLE = Object.freeze({
${serverLifecycleCatalogDeclarations}
} as const);
`;
  const evidenceContent = `${JSON.stringify(manifest)}\n`;

  return {
    runtimeContent,
    serverRequestRuntimeContent,
    evidenceContent,
    runtimeProjectionDigest,
    serverRequestRuntimeProjectionDigest,
    manifestDigest,
    violationCount,
    routeCount: routes.length,
    contractRouteCount: contractRoutes.length,
    bypassRouteCount: bypassRoutes.length,
    frontendDemandCount: demands.length,
    frontendCompilerDiagnosticCount,
    frontendCompilerDiagnostics: formatDiagnostics(frontendCompilerDiagnostics),
  };
}

function generate(): GeneratedArtifact {
  const backendProgram = createBackendProgram();
  const frontendProgram = createFrontendProgram();
  const toolsProgram = createToolsProgram();
  const routes = discoverRoutes(backendProgram);
  assertSqlIdentifierCatalogConsumers(backendProgram);
  const namedProjections = discoverNamedProjections(backendProgram);
  const frontendAudit = discoverFrontendDemands(routes, frontendProgram);
  const frontendCompilerDiagnostics = ts.getPreEmitDiagnostics(frontendProgram);
  const canonicalJsonAuthority = canonicalJsonAuthorityProjection([
    backendProgram,
    frontendProgram,
    toolsProgram,
  ]);
  return renderArtifact(
    routes,
    namedProjections,
    frontendAudit,
    frontendCompilerDiagnostics,
    canonicalJsonAuthority,
  );
}

function shortHash(content: string): string {
  return fullHash(content).slice(0, 16);
}

function canonicalArtifactJson(value: unknown, artifact: string): string {
  try {
    return canonicalWireJsonStringifyV1(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown canonical JSON failure';
    throw new ContractGenerationError(`${artifact} is not canonically serializable: ${detail}`);
  }
}

export function runAdminContractGenerator(): void {
  const check = process.argv.includes('--check');
  const requireReady = process.argv.includes('--require-ready');
  const runtimeOutputPath = resolve(REPO_ROOT, RUNTIME_OUTPUT);
  const serverRequestRuntimeOutputPath = resolve(REPO_ROOT, SERVER_REQUEST_RUNTIME_OUTPUT);
  const evidenceOutputPath = resolve(REPO_ROOT, EVIDENCE_OUTPUT);
  let artifact: GeneratedArtifact;
  try {
    artifact = generate();
  } catch (error) {
    if (error instanceof ContractGenerationError) {
      process.stderr.write(`admin-contracts codegen: ${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  if (check) {
    for (const generated of [
      { path: RUNTIME_OUTPUT, absolute: runtimeOutputPath, content: artifact.runtimeContent },
      {
        path: SERVER_REQUEST_RUNTIME_OUTPUT,
        absolute: serverRequestRuntimeOutputPath,
        content: artifact.serverRequestRuntimeContent,
      },
      { path: EVIDENCE_OUTPUT, absolute: evidenceOutputPath, content: artifact.evidenceContent },
    ]) {
      const current = existsSync(generated.absolute)
        ? readFileSync(generated.absolute, 'utf8')
        : '';
      if (current !== generated.content) {
        process.stderr.write(
          `admin-contracts codegen: ${generated.path} is STALE (` +
            `${current ? shortHash(current) : 'missing'} != ${shortHash(generated.content)}).\n`,
        );
        process.exit(1);
      }
    }
    if (requireReady && artifact.violationCount > 0) {
      process.stderr.write(
        `admin-contracts codegen: ${artifact.violationCount} frontend demands lack route authority.\n`,
      );
      process.exit(1);
    }
    if (requireReady && artifact.frontendCompilerDiagnosticCount > 0) {
      process.stderr.write(
        `admin-contracts codegen: frontend compiler has ${artifact.frontendCompilerDiagnosticCount} diagnostics:\n` +
          artifact.frontendCompilerDiagnostics,
      );
      process.exit(1);
    }
    process.stdout.write(
      `admin-contracts codegen: up to date; routes ${artifact.routeCount} ` +
        `(contracts ${artifact.contractRouteCount}, bypasses ${artifact.bypassRouteCount}); ` +
        `frontend ${artifact.frontendDemandCount}; violations ${artifact.violationCount}; ` +
        `manifest ${artifact.manifestDigest}\n`,
    );
    return;
  }

  mkdirSync(dirname(runtimeOutputPath), { recursive: true });
  mkdirSync(dirname(serverRequestRuntimeOutputPath), { recursive: true });
  mkdirSync(dirname(evidenceOutputPath), { recursive: true });
  writeFileSync(runtimeOutputPath, artifact.runtimeContent, 'utf8');
  writeFileSync(serverRequestRuntimeOutputPath, artifact.serverRequestRuntimeContent, 'utf8');
  writeFileSync(evidenceOutputPath, artifact.evidenceContent, 'utf8');
  process.stdout.write(
    `admin-contracts codegen: wrote ${RUNTIME_OUTPUT}, ${SERVER_REQUEST_RUNTIME_OUTPUT}, ` +
      `and ${EVIDENCE_OUTPUT}; ` +
      `routes ${artifact.routeCount} ` +
      `(contracts ${artifact.contractRouteCount}, bypasses ${artifact.bypassRouteCount}); ` +
      `frontend ${artifact.frontendDemandCount}; violations ${artifact.violationCount}; ` +
      `runtime ${artifact.runtimeProjectionDigest}; server request ` +
      `${artifact.serverRequestRuntimeProjectionDigest}; manifest ${artifact.manifestDigest}\n`,
  );
}
