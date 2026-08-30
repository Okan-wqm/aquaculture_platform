import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  type BigIntStats,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire, Module } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

import * as ts from 'typescript';

import {
  assertAnchoredDirectoryChainIdentityCurrent,
  assertStableRegularFileCurrent,
  closeAnchoredDirectoryChain,
  decodeFatalUtf8,
  observeStableRegularFile,
  openAnchoredDirectoryChain,
  sameBigIntFileObservation,
  type AnchoredDirectoryChainV1,
  type StableRegularFileObservationV1,
} from './anchored-filesystem';
import { errorFromUnknown } from './error-cause';
import { REPO_ROOT } from './repo-root';

const repositoryRequire = createRequire(__filename);
const REPOSITORY_APPLICATION_MODULE_EXTENSIONS = new Set(['.json', '.ts']);
const MAX_REPOSITORY_APPLICATION_MODULE_BYTES = 16 * 1024 * 1024;
const MAX_REPOSITORY_EXECUTION_AUTHORITY_FILE_BYTES = 2 * 1024 * 1024;

type RepositoryApplicationModuleLoadState = 'LOADING' | 'LOADED';
type CommonJsResolverV1 = (
  this: typeof Module,
  request: string,
  parent: unknown,
  isMain: unknown,
) => unknown;
type CommonJsLoaderV1 = (
  this: unknown,
  request: unknown,
  parent: unknown,
  isMain: unknown,
) => unknown;
type CommonJsCompilerV1 = (
  this: NodeJS.Module,
  content: string | Buffer,
  filename: string,
) => unknown;
type CommonJsModuleRequireV1 = (this: NodeJS.Module, request: string) => unknown;
type TypeScriptCreateServiceV1 = (
  this: object,
  options: Readonly<{ project: string; transpileOnly: true }>,
) => unknown;
type TypeScriptCompileV1 = (this: object, source: string, filename: string) => unknown;
type TypeScriptPathRegisterV1 = (
  this: object,
  options: Readonly<{
    baseUrl: string;
    paths: Readonly<Record<string, readonly string[]>>;
  }>,
) => unknown;
type TypeScriptPathUnregisterV1 = (this: undefined) => unknown;
type RuntimeCallableV1 = (...args: never[]) => unknown;

function assertRuntimeCallable<TCallable extends RuntimeCallableV1>(
  value: unknown,
  label: string,
): asserts value is TCallable {
  if (typeof value !== 'function') throw new Error(label);
}

/**
 * Determinism contract for trusted repository modules. This is not a hostile-code sandbox: it
 * owns only the lifecycle of the CommonJS `module.require` capability installed on modules
 * evaluated here. Source admission rejects a closed set of direct loader APIs used by those
 * trusted modules; it does not claim containment of hostile code.
 */
const REPOSITORY_APPLICATION_MODULE_REQUIRE_CONTRACT_V1 = Object.freeze({
  moduleRequireProperty: 'require',
  postEvaluationModuleRequire: 'DENY',
  schemaVersion: 'RepositoryApplicationModuleRequireContractV1',
});

const REPOSITORY_APPLICATION_TYPESCRIPT_SOURCE_ADMISSION_PROFILE_V1 = Object.freeze({
  deniedLoaderModuleSpecifiers: Object.freeze(['module', 'node:module']),
  schemaVersion: 'RepositoryApplicationTypeScriptSourceAdmissionProfileV1',
});

interface RepositoryApplicationModuleRequireAuthorityV1 {
  readonly assertMode: (expected: RepositoryApplicationModuleRequireModeV1) => void;
  readonly governedRequire: CommonJsModuleRequireV1;
  readonly seal: () => void;
}

type RepositoryApplicationModuleRequireModeV1 = 'EVALUATING' | 'SEALED';

interface RepositoryApplicationModuleCacheEntryV1 {
  readonly digestSha256: string;
  readonly extensionHandler: RepositoryApplicationExtensionHandlerV1;
  readonly generation: BigIntStats;
  readonly module: NodeJS.Module;
  readonly requireAuthority: RepositoryApplicationModuleRequireAuthorityV1;
  readonly sourceObservation: StableRegularFileObservationV1;
  loadingEvaluationToken: object | undefined;
  state: RepositoryApplicationModuleLoadState;
}

interface RepositoryApplicationExtensionHandlerV1 {
  readonly extension: string;
  readonly handler: (loadedModule: NodeJS.Module, filename: string) => unknown;
}

const repositoryApplicationModuleCache = new Map<string, RepositoryApplicationModuleCacheEntryV1>();
interface RepositoryApplicationEvaluationFrameV1 {
  readonly repositoryRoot: string;
  readonly token: object;
}

const repositoryApplicationEvaluationRoots: RepositoryApplicationEvaluationFrameV1[] = [];
interface RepositoryApplicationExecutionAuthorityV1 {
  readonly aliasCoordinates: readonly Readonly<{
    readonly coordinate: string;
    readonly request: string;
  }>[];
  readonly compiler: TypeScriptCompileV1;
  readonly coordinates: readonly StableRegularFileObservationV1[];
  readonly extensionRegistry: object;
  readonly jsonHandler: RepositoryApplicationExtensionHandlerV1['handler'];
  readonly loader: CommonJsLoaderV1;
  readonly moduleCache: object;
  readonly pathMappings: Readonly<Record<string, readonly string[]>>;
  readonly previousJsonHandler: unknown;
  readonly previousLoader: CommonJsLoaderV1;
  readonly previousResolver: CommonJsResolverV1;
  readonly previousTypeScriptHandler: unknown;
  readonly resolver: CommonJsResolverV1;
  readonly resolverProbe: NodeJS.Module;
  readonly service: object;
  readonly typescriptHandler: RepositoryApplicationExtensionHandlerV1['handler'];
}

let repositoryApplicationExecutionAuthority: RepositoryApplicationExecutionAuthorityV1 | undefined;

function withRepositoryApplicationEvaluationRoot<T>(
  repositoryRoot: string,
  action: (frame: RepositoryApplicationEvaluationFrameV1) => T,
): T {
  const authority = repositoryApplicationExecutionAuthority;
  if (authority === undefined) {
    throw new Error('Repository application evaluation has no execution authority');
  }
  const ownsRuntime = repositoryApplicationEvaluationRoots.length === 0;
  if (ownsRuntime) {
    installRepositoryApplicationExecutionRuntime(authority);
  } else {
    assertRepositoryApplicationExecutionRuntimeCurrent(authority);
  }
  const frame = Object.freeze({ repositoryRoot, token: Object.freeze({}) });
  repositoryApplicationEvaluationRoots.push(frame);
  let actionFailure: Error | undefined;
  let result: T | undefined;
  try {
    result = action(frame);
  } catch (error) {
    actionFailure = errorFromUnknown('Repository application evaluation failed', error);
  }
  const releasedRoot = repositoryApplicationEvaluationRoots.pop();
  const cleanupFailure =
    releasedRoot === frame
      ? undefined
      : new Error('Repository application evaluation root stack changed during execution');
  let runtimeCleanupFailure: Error | undefined;
  if (ownsRuntime) {
    try {
      restoreRepositoryApplicationExecutionRuntime(authority);
    } catch (error) {
      runtimeCleanupFailure = errorFromUnknown(
        'Repository application scoped execution runtime cleanup failed',
        error,
      );
    }
  }
  const failures = [actionFailure, cleanupFailure, runtimeCleanupFailure].filter(
    (failure): failure is Error => failure !== undefined,
  );
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'Repository application evaluation and scoped capability cleanup failed',
    );
  }
  const onlyFailure = failures[0];
  if (onlyFailure !== undefined) throw onlyFailure;
  return result as T;
}

function requireRepositoryApplicationEvaluationRoot(): string {
  const frame = repositoryApplicationEvaluationRoots.at(-1);
  if (frame === undefined) {
    throw new Error('Repository application handler escaped a governed evaluation root');
  }
  return frame.repositoryRoot;
}

function requireRepositoryApplicationEvaluationToken(): object {
  const frame = repositoryApplicationEvaluationRoots.at(-1);
  if (frame === undefined) {
    throw new Error('Repository application handler escaped a governed evaluation generation');
  }
  return frame.token;
}

interface RepositoryApplicationModuleDescriptorV1 {
  readonly descriptor: number;
  readonly generation: BigIntStats;
  readonly parent: AnchoredDirectoryChainV1;
  readonly repositoryRoot: string;
  readonly targetPath: string;
}

function isPathBelow(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return (
    pathFromRoot.length > 0 &&
    pathFromRoot !== '..' &&
    !pathFromRoot.startsWith('../') &&
    !isAbsolute(pathFromRoot)
  );
}

function assertDescriptorMatchesTarget(
  descriptor: number,
  targetPath: string,
  expected?: BigIntStats,
): BigIntStats {
  const descriptorStat = fstatSync(descriptor, { bigint: true });
  const lexicalStat = lstatSync(targetPath, { bigint: true });
  if (
    !descriptorStat.isFile() ||
    descriptorStat.isSymbolicLink() ||
    !lexicalStat.isFile() ||
    lexicalStat.isSymbolicLink() ||
    !sameBigIntFileObservation(descriptorStat, lexicalStat) ||
    (expected !== undefined && !sameBigIntFileObservation(expected, descriptorStat))
  ) {
    throw new Error(
      `Repository application module target changed or is not one regular file: ${targetPath}`,
    );
  }
  return descriptorStat;
}

function readBoundedDescriptorContent(opened: RepositoryApplicationModuleDescriptorV1): Buffer {
  if (
    opened.generation.size < 0n ||
    opened.generation.size > BigInt(MAX_REPOSITORY_APPLICATION_MODULE_BYTES)
  ) {
    throw new Error(
      `Repository application module exceeds ${String(MAX_REPOSITORY_APPLICATION_MODULE_BYTES)} bytes: ${opened.targetPath}`,
    );
  }
  const content = readFileSync(opened.descriptor);
  if (BigInt(content.length) !== opened.generation.size) {
    throw new Error(
      `Repository application module descriptor returned a torn size: ${opened.targetPath}`,
    );
  }
  return content;
}

function contentSha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function currentCommonJsResolver(): CommonJsResolverV1 {
  const resolver: unknown = Reflect.get(Module, '_resolveFilename');
  assertRuntimeCallable<CommonJsResolverV1>(
    resolver,
    'Repository application execution authority has no CommonJS resolver',
  );
  return resolver;
}

function currentCommonJsLoader(): CommonJsLoaderV1 {
  const loader: unknown = Reflect.get(Module, '_load');
  assertRuntimeCallable<CommonJsLoaderV1>(
    loader,
    'Repository application execution authority has no CommonJS loader',
  );
  return loader;
}

function currentCommonJsExtensionRegistry(): object {
  const registry: unknown = Reflect.get(Module, '_extensions');
  if (typeof registry !== 'object' || registry === null) {
    throw new Error(
      'Repository application execution authority has no CommonJS extension registry',
    );
  }
  return registry;
}

function currentCommonJsModuleCache(): object {
  const cache: unknown = Reflect.get(Module, '_cache');
  if (typeof cache !== 'object' || cache === null) {
    throw new Error('Repository application execution authority has no CommonJS module cache');
  }
  return cache;
}

function readCommonJsModuleCache(cache: object, targetPath: string): unknown {
  const cachedModule: unknown = Reflect.get(cache, targetPath);
  return cachedModule;
}

function writeCommonJsModuleCache(
  cache: object,
  targetPath: string,
  loadedModule: NodeJS.Module,
): void {
  if (!Reflect.set(cache, targetPath, loadedModule)) {
    throw new Error(`Repository CommonJS cache rejected target ownership: ${targetPath}`);
  }
}

function deleteCommonJsModuleCache(cache: object, targetPath: string): void {
  if (!Reflect.deleteProperty(cache, targetPath)) {
    throw new Error(`Repository CommonJS cache rejected target cleanup: ${targetPath}`);
  }
}

function createRepositoryApplicationModuleRequireAuthority(
  loadedModule: NodeJS.Module,
  targetPath: string,
): RepositoryApplicationModuleRequireAuthorityV1 {
  const property = REPOSITORY_APPLICATION_MODULE_REQUIRE_CONTRACT_V1.moduleRequireProperty;
  if (Object.getOwnPropertyDescriptor(loadedModule, property) !== undefined) {
    throw new Error(
      `Repository application Module starts with an ungoverned require capability: ${targetPath}`,
    );
  }
  const inheritedRequire: unknown = Reflect.get(loadedModule, property);
  assertRuntimeCallable<CommonJsModuleRequireV1>(
    inheritedRequire,
    `Repository application Module exposes no CommonJS require capability: ${targetPath}`,
  );
  let mode: RepositoryApplicationModuleRequireModeV1 = 'EVALUATING';
  const governedRequire = function (this: NodeJS.Module, request: string): unknown {
    if (this !== loadedModule) {
      throw new Error(
        `${REPOSITORY_APPLICATION_MODULE_REQUIRE_CONTRACT_V1.schemaVersion} rejected a ` +
          `foreign module receiver for ${targetPath}`,
      );
    }
    if (mode !== 'EVALUATING') {
      throw new Error(
        `${REPOSITORY_APPLICATION_MODULE_REQUIRE_CONTRACT_V1.schemaVersion} enforced ` +
          `${REPOSITORY_APPLICATION_MODULE_REQUIRE_CONTRACT_V1.postEvaluationModuleRequire} ` +
          `for post-evaluation module.require from ${targetPath}: ${request}`,
      );
    }
    return Reflect.apply(inheritedRequire, loadedModule, [request]);
  };
  Object.freeze(governedRequire);
  Object.defineProperty(loadedModule, property, {
    configurable: false,
    enumerable: false,
    value: governedRequire,
    writable: false,
  });
  const assertMode = (expected: RepositoryApplicationModuleRequireModeV1): void => {
    if (mode !== expected) {
      throw new Error(
        `Repository application module require mode is ${mode}, expected ${expected}: ${targetPath}`,
      );
    }
  };
  const seal = (): void => {
    assertMode('EVALUATING');
    mode = 'SEALED';
  };
  return Object.freeze({
    assertMode: Object.freeze(assertMode),
    governedRequire,
    seal: Object.freeze(seal),
  });
}

function assertRepositoryApplicationRequireDescriptorCurrent(
  entry: RepositoryApplicationModuleCacheEntryV1,
  targetPath: string,
): void {
  const property = REPOSITORY_APPLICATION_MODULE_REQUIRE_CONTRACT_V1.moduleRequireProperty;
  const descriptor = Object.getOwnPropertyDescriptor(entry.module, property);
  if (
    descriptor === undefined ||
    descriptor.configurable !== false ||
    descriptor.enumerable !== false ||
    descriptor.writable !== false ||
    descriptor.value !== entry.requireAuthority.governedRequire ||
    Reflect.get(entry.module, property) !== entry.requireAuthority.governedRequire
  ) {
    throw new Error(`Repository application module require capability changed: ${targetPath}`);
  }
}

function assertRepositoryApplicationEvaluationRequireCurrent(
  entry: RepositoryApplicationModuleCacheEntryV1,
  targetPath: string,
): void {
  assertRepositoryApplicationRequireDescriptorCurrent(entry, targetPath);
  entry.requireAuthority.assertMode('EVALUATING');
}

function assertRepositoryApplicationSealedRequireCurrent(
  entry: RepositoryApplicationModuleCacheEntryV1,
  targetPath: string,
): void {
  assertRepositoryApplicationRequireDescriptorCurrent(entry, targetPath);
  entry.requireAuthority.assertMode('SEALED');
}

function sealRepositoryApplicationModuleRequire(
  entry: RepositoryApplicationModuleCacheEntryV1,
  targetPath: string,
): void {
  assertRepositoryApplicationEvaluationRequireCurrent(entry, targetPath);
  entry.requireAuthority.seal();
  assertRepositoryApplicationSealedRequireCurrent(entry, targetPath);
}

function assertRepositoryApplicationModuleCacheEntryCurrent(
  moduleCache: object,
  targetPath: string,
  entry: RepositoryApplicationModuleCacheEntryV1,
  activeTokens: ReadonlySet<object>,
): void {
  assertStableRegularFileCurrent(
    entry.sourceObservation,
    MAX_REPOSITORY_APPLICATION_MODULE_BYTES,
    'Repository application module cache source',
  );
  if (
    entry.sourceObservation.path !== targetPath ||
    entry.sourceObservation.sha256 !== entry.digestSha256 ||
    !sameBigIntFileObservation(entry.sourceObservation.stat, entry.generation) ||
    readCommonJsModuleCache(moduleCache, targetPath) !== entry.module
  ) {
    throw new Error(`Repository application module cache generation changed: ${targetPath}`);
  }
  if (entry.state === 'LOADING') {
    if (
      entry.module.loaded ||
      entry.loadingEvaluationToken === undefined ||
      !activeTokens.has(entry.loadingEvaluationToken)
    ) {
      throw new Error(
        `Repository application module LOADING authority escaped its evaluation scope: ${targetPath}`,
      );
    }
    assertRepositoryApplicationEvaluationRequireCurrent(entry, targetPath);
  } else if (
    entry.state !== 'LOADED' ||
    !entry.module.loaded ||
    entry.loadingEvaluationToken !== undefined
  ) {
    throw new Error(
      `Repository application module LOADED authority is inconsistent: ${targetPath}`,
    );
  } else {
    assertRepositoryApplicationSealedRequireCurrent(entry, targetPath);
  }
}

function assertRepositoryApplicationModuleCacheCurrent(
  authority: RepositoryApplicationExecutionAuthorityV1,
): void {
  const activeTokens = new Set(repositoryApplicationEvaluationRoots.map((frame) => frame.token));
  for (const [targetPath, entry] of [...repositoryApplicationModuleCache.entries()].sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  )) {
    assertRepositoryApplicationModuleCacheEntryCurrent(
      authority.moduleCache,
      targetPath,
      entry,
      activeTokens,
    );
  }
}

function assertGovernedRepositoryDependencyCoordinate(
  moduleCache: object,
  frame: RepositoryApplicationEvaluationFrameV1,
  coordinate: string,
): void {
  if (!isAbsolute(coordinate)) return;
  if (!isPathBelow(frame.repositoryRoot, coordinate)) {
    throw new Error(
      `Repository application dependency escaped its repository authority: ${coordinate}`,
    );
  }
  const pathFromRoot = relative(frame.repositoryRoot, coordinate);
  if (pathFromRoot.split('/').includes('node_modules')) return;
  if (!REPOSITORY_APPLICATION_MODULE_EXTENSIONS.has(extname(coordinate))) {
    throw new Error(
      `Repository application dependency has no governed application extension: ${coordinate}`,
    );
  }
  const cachedModule = readCommonJsModuleCache(moduleCache, coordinate);
  const entry = repositoryApplicationModuleCache.get(coordinate);
  if (cachedModule === undefined) {
    if (entry !== undefined) {
      throw new Error(
        `Repository application dependency lost its Node cache authority: ${coordinate}`,
      );
    }
    return;
  }
  if (entry === undefined || entry.module !== cachedModule) {
    throw new Error(
      `Repository application dependency has external-first cache authority: ${coordinate}`,
    );
  }
  assertRepositoryApplicationModuleCacheEntryCurrent(
    moduleCache,
    coordinate,
    entry,
    new Set(repositoryApplicationEvaluationRoots.map((activeFrame) => activeFrame.token)),
  );
}

function createCommonJsResolverProbe(): NodeJS.Module {
  const probe = new Module('repository-application-execution-resolver-probe');
  probe.filename = __filename;
  probe.path = dirname(__filename);
  probe.paths = repositoryRequire.resolve.paths('repository-application-execution-probe') ?? [];
  return probe;
}

function resolveRepositoryAliasCoordinate(
  resolver: CommonJsResolverV1,
  resolverProbe: NodeJS.Module,
  request: string,
): string {
  const coordinate: unknown = Reflect.apply(resolver, Module, [request, resolverProbe, false]);
  if (typeof coordinate !== 'string' || !isPathBelow(REPO_ROOT, coordinate)) {
    throw new Error(`Repository TypeScript alias ${request} escaped the repository authority`);
  }
  return coordinate;
}

function resolveRepositoryAliasCoordinates(
  resolver: CommonJsResolverV1,
  resolverProbe: NodeJS.Module,
  paths: Readonly<Record<string, readonly string[]>>,
): readonly Readonly<{ readonly coordinate: string; readonly request: string }>[] {
  return Object.freeze(
    Object.keys(paths)
      .filter((request) => !request.includes('*'))
      .sort()
      .map((request) =>
        Object.freeze({
          coordinate: resolveRepositoryAliasCoordinate(resolver, resolverProbe, request),
          request,
        }),
      ),
  );
}

function isConfiguredTypeScriptAlias(
  paths: Readonly<Record<string, readonly string[]>>,
  request: string,
): boolean {
  return Object.keys(paths).some((pattern) => {
    const wildcard = pattern.indexOf('*');
    if (wildcard < 0) return request === pattern;
    if (pattern.indexOf('*', wildcard + 1) >= 0) {
      throw new Error(`Repository TypeScript path mapping has multiple wildcards: ${pattern}`);
    }
    return (
      request.startsWith(pattern.slice(0, wildcard)) &&
      request.endsWith(pattern.slice(wildcard + 1)) &&
      request.length >= pattern.length - 1
    );
  });
}

function rewriteCompiledTypeScriptAliasRequests(
  source: string,
  filename: string,
  paths: Readonly<Record<string, readonly string[]>>,
  resolver: CommonJsResolverV1,
  resolverProbe: NodeJS.Module,
): string {
  const parsed = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const replacements: Array<{
    readonly end: number;
    readonly start: number;
    readonly value: string;
  }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      isConfiguredTypeScriptAlias(paths, node.arguments[0].text)
    ) {
      replacements.push({
        end: node.arguments[0].end,
        start: node.arguments[0].getStart(parsed),
        value: JSON.stringify(
          resolveRepositoryAliasCoordinate(resolver, resolverProbe, node.arguments[0].text),
        ),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return replacements
    .sort((left, right) => right.start - left.start)
    .reduce(
      (rewritten, replacement) =>
        `${rewritten.slice(0, replacement.start)}${replacement.value}${rewritten.slice(replacement.end)}`,
      source,
    );
}

function assertRepositoryApplicationTypeScriptSourceAdmitted(
  source: string,
  filename: string,
): void {
  const profile = REPOSITORY_APPLICATION_TYPESCRIPT_SOURCE_ADMISSION_PROFILE_V1;
  const parsed = ts.createSourceFile(
    filename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const reject = (node: ts.Node, reason: string): never => {
    const position = parsed.getLineAndCharacterOfPosition(node.getStart(parsed));
    throw new Error(
      `${profile.schemaVersion} rejected ${reason} at ${filename}:` +
        `${String(position.line + 1)}:${String(position.character + 1)}`,
    );
  };
  const rejectDeniedModuleSpecifier = (node: ts.Node, value: string): void => {
    if (profile.deniedLoaderModuleSpecifiers.includes(value)) {
      reject(node, `loader-module capability ${JSON.stringify(value)}`);
    }
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      rejectDeniedModuleSpecifier(node.moduleSpecifier, node.moduleSpecifier.text);
    }
    if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      rejectDeniedModuleSpecifier(
        node.moduleReference.expression,
        node.moduleReference.expression.text,
      );
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        reject(node, 'runtime dynamic import');
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        if (node.arguments.length !== 1) {
          reject(node, 'non-literal CommonJS require');
        }
        const request = node.arguments[0];
        if (request !== undefined && ts.isStringLiteralLike(request)) {
          rejectDeniedModuleSpecifier(request, request.text);
        } else {
          reject(node, 'non-literal CommonJS require');
        }
      }
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'process' &&
        node.expression.name.text === 'getBuiltinModule'
      ) {
        reject(node, 'process.getBuiltinModule loader capability');
      }
    }
    if (ts.isIdentifier(node) && node.text === 'require') {
      const parent = node.parent;
      const isLiteralCall = ts.isCallExpression(parent) && parent.expression === node;
      const isCacheInspection =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        parent.name.text === 'cache';
      if (!isLiteralCall && !isCacheInspection) {
        reject(node, 'captured CommonJS require capability');
      }
    }
    if (ts.isIdentifier(node) && node.text === 'module') {
      const parent = node.parent;
      const isOwnedLifecycleProperty =
        ts.isPropertyAccessExpression(parent) &&
        parent.expression === node &&
        (parent.name.text === 'exports' || parent.name.text === 'loaded');
      if (!isOwnedLifecycleProperty) {
        reject(node, 'direct CommonJS module capability');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
}

function assertRepositoryExecutionCoordinatesCurrent(
  coordinates: readonly StableRegularFileObservationV1[],
): void {
  for (const coordinate of coordinates) {
    assertStableRegularFileCurrent(
      coordinate,
      MAX_REPOSITORY_EXECUTION_AUTHORITY_FILE_BYTES,
      'Repository application execution authority',
    );
  }
}

function requireTypeScriptPathMappings(
  config: StableRegularFileObservationV1,
): Readonly<Record<string, readonly string[]>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(config.content.toString('utf8'));
  } catch (error) {
    throw new AggregateError([error], 'Repository TypeScript config is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Repository TypeScript config has no object root');
  }
  const compilerOptions: unknown = Reflect.get(parsed, 'compilerOptions');
  if (typeof compilerOptions !== 'object' || compilerOptions === null) {
    throw new Error('Repository TypeScript config has no compilerOptions authority');
  }
  if (Reflect.get(compilerOptions, 'baseUrl') !== '.') {
    throw new Error('Repository TypeScript config baseUrl is not repository-relative');
  }
  const rawPaths: unknown = Reflect.get(compilerOptions, 'paths');
  if (typeof rawPaths !== 'object' || rawPaths === null) {
    throw new Error('Repository TypeScript config has no path mapping authority');
  }
  const paths: Record<string, readonly string[]> = {};
  for (const key of Object.keys(rawPaths).sort()) {
    const rawTargets: unknown = Reflect.get(rawPaths, key);
    if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
      throw new Error(`Repository TypeScript path mapping ${key} has no targets`);
    }
    const targets: string[] = [];
    for (let index = 0; index < rawTargets.length; index += 1) {
      const target: unknown = Reflect.get(rawTargets, index);
      if (typeof target !== 'string' || target.length === 0) {
        throw new Error(`Repository TypeScript path mapping ${key} has an invalid target`);
      }
      targets.push(target);
    }
    paths[key] = Object.freeze(targets);
  }
  if (Object.keys(paths).length === 0) {
    throw new Error('Repository TypeScript config has an empty path mapping authority');
  }
  return Object.freeze(paths);
}

function compileRepositoryApplicationCommonJs(
  loadedModule: NodeJS.Module,
  filename: string,
  source: string,
): unknown {
  const compileModule: unknown = Reflect.get(loadedModule, '_compile');
  assertRuntimeCallable<CommonJsCompilerV1>(
    compileModule,
    'Repository application target exposes no CommonJS compiler',
  );
  return Reflect.apply(compileModule, loadedModule, [source, filename]);
}

function evaluateRepositoryApplicationDependency(
  loadedModule: NodeJS.Module,
  filename: string,
  extensionHandler: RepositoryApplicationExtensionHandlerV1,
  label: string,
  evaluate: (
    source: StableRegularFileObservationV1,
    authority: RepositoryApplicationExecutionAuthorityV1,
  ) => unknown,
): unknown {
  const activeAuthority = repositoryApplicationExecutionAuthority;
  if (activeAuthority === undefined) {
    throw new Error(`Repository ${label} handler has no active execution authority`);
  }
  assertRepositoryApplicationExecutionRuntimeCurrent(activeAuthority);
  const source = observeStableRegularFile(
    filename,
    MAX_REPOSITORY_APPLICATION_MODULE_BYTES,
    `Repository ${label} execution source`,
  );
  const evaluationRoot = requireRepositoryApplicationEvaluationRoot();
  const canonicalModuleFilename = resolve(loadedModule.filename);
  const governedDependency =
    resolve(filename) === filename &&
    isPathBelow(evaluationRoot, filename) &&
    extname(filename) === extensionHandler.extension;
  if (
    !governedDependency &&
    (canonicalModuleFilename !== loadedModule.filename ||
      !isPathBelow(evaluationRoot, canonicalModuleFilename))
  ) {
    throw new Error(`Repository ${label} source escaped its evaluation root: ${filename}`);
  }

  let dependencyEntry: RepositoryApplicationModuleCacheEntryV1 | undefined;
  if (governedDependency) {
    if (readCommonJsModuleCache(activeAuthority.moduleCache, filename) !== loadedModule) {
      throw new Error(
        `Repository ${label} dependency has no canonical cache ownership: ${filename}`,
      );
    }
    const existing = repositoryApplicationModuleCache.get(filename);
    if (existing !== undefined) {
      throw new Error(`Repository ${label} dependency duplicated its governed load: ${filename}`);
    }
    dependencyEntry = {
      digestSha256: source.sha256,
      extensionHandler,
      generation: source.stat,
      loadingEvaluationToken: requireRepositoryApplicationEvaluationToken(),
      module: loadedModule,
      requireAuthority: createRepositoryApplicationModuleRequireAuthority(loadedModule, filename),
      sourceObservation: source,
      state: 'LOADING',
    };
    repositoryApplicationModuleCache.set(filename, dependencyEntry);
  }

  let actionFailure: Error | undefined;
  let result: unknown;
  try {
    result = evaluate(source, activeAuthority);
    assertRepositoryApplicationExecutionRuntimeCurrent(activeAuthority);
    assertStableRegularFileCurrent(
      source,
      MAX_REPOSITORY_APPLICATION_MODULE_BYTES,
      `Repository ${label} execution source`,
    );
    if (dependencyEntry !== undefined) {
      if (
        repositoryApplicationModuleCache.get(filename) !== dependencyEntry ||
        readCommonJsModuleCache(activeAuthority.moduleCache, filename) !== loadedModule
      ) {
        throw new Error(`Repository ${label} dependency authority changed: ${filename}`);
      }
      loadedModule.loaded = true;
      sealRepositoryApplicationModuleRequire(dependencyEntry, filename);
      dependencyEntry.state = 'LOADED';
      dependencyEntry.loadingEvaluationToken = undefined;
    }
  } catch (error) {
    actionFailure = errorFromUnknown(`Repository ${label} dependency evaluation failed`, error);
  }
  if (actionFailure === undefined) return result;

  const cleanupFailures: Error[] = [];
  if (
    dependencyEntry !== undefined &&
    repositoryApplicationModuleCache.get(filename) === dependencyEntry
  ) {
    repositoryApplicationModuleCache.delete(filename);
  }
  if (
    dependencyEntry !== undefined &&
    readCommonJsModuleCache(activeAuthority.moduleCache, filename) === loadedModule
  ) {
    try {
      deleteCommonJsModuleCache(activeAuthority.moduleCache, filename);
    } catch (error) {
      cleanupFailures.push(
        errorFromUnknown(`Repository ${label} dependency cache cleanup failed`, error),
      );
    }
  }
  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      [actionFailure, ...cleanupFailures],
      `Repository ${label} dependency evaluation and cache cleanup failed`,
    );
  }
  throw actionFailure;
}

function assertRepositoryApplicationExecutionRuntimeCurrent(
  authority: RepositoryApplicationExecutionAuthorityV1,
): void {
  if (
    currentCommonJsExtensionRegistry() !== authority.extensionRegistry ||
    Reflect.get(authority.extensionRegistry, '.json') !== authority.jsonHandler ||
    Reflect.get(authority.extensionRegistry, '.ts') !== authority.typescriptHandler ||
    currentCommonJsLoader() !== authority.loader ||
    currentCommonJsModuleCache() !== authority.moduleCache ||
    currentCommonJsResolver() !== authority.resolver ||
    Reflect.get(authority.service, 'compile') !== authority.compiler
  ) {
    throw new Error('Repository application execution authority generation changed');
  }
}

function assertRepositoryApplicationExecutionRuntimeInactive(
  authority: RepositoryApplicationExecutionAuthorityV1,
): void {
  if (
    currentCommonJsExtensionRegistry() !== authority.extensionRegistry ||
    Reflect.get(authority.extensionRegistry, '.json') !== authority.previousJsonHandler ||
    Reflect.get(authority.extensionRegistry, '.ts') !== authority.previousTypeScriptHandler ||
    currentCommonJsLoader() !== authority.previousLoader ||
    currentCommonJsModuleCache() !== authority.moduleCache ||
    currentCommonJsResolver() !== authority.previousResolver ||
    Reflect.get(authority.service, 'compile') !== authority.compiler
  ) {
    throw new Error('Repository application inactive execution authority generation changed');
  }
}

function assertRepositoryApplicationExecutionAuthorityCurrent(
  authority: RepositoryApplicationExecutionAuthorityV1,
): void {
  assertRepositoryExecutionCoordinatesCurrent(authority.coordinates);
  if (repositoryApplicationEvaluationRoots.length === 0) {
    assertRepositoryApplicationExecutionRuntimeInactive(authority);
  } else {
    assertRepositoryApplicationExecutionRuntimeCurrent(authority);
  }
  for (const alias of authority.aliasCoordinates) {
    if (
      resolveRepositoryAliasCoordinate(
        authority.resolver,
        authority.resolverProbe,
        alias.request,
      ) !== alias.coordinate
    ) {
      throw new Error(`Repository TypeScript alias generation changed: ${alias.request}`);
    }
  }
  assertRepositoryApplicationModuleCacheCurrent(authority);
}

function restoreRepositoryApplicationExecutionRuntime(
  authority: RepositoryApplicationExecutionAuthorityV1,
): void {
  const rollbackFailures: Error[] = [];
  try {
    let cleanupViolation: Error | undefined;
    if (currentCommonJsLoader() === authority.loader) {
      if (!Reflect.set(Module, '_load', authority.previousLoader)) {
        throw new Error('Repository CommonJS dependency loader restoration was rejected');
      }
    } else if (currentCommonJsLoader() !== authority.previousLoader) {
      cleanupViolation = new Error(
        'Repository CommonJS dependency loader changed during scoped execution',
      );
      if (!Reflect.set(Module, '_load', authority.previousLoader)) {
        throw new Error('Repository CommonJS dependency loader fallback restoration was rejected');
      }
    }
    if (currentCommonJsLoader() !== authority.previousLoader) {
      throw new Error(
        'Repository CommonJS dependency loader restoration did not recover the prior generation',
      );
    }
    if (cleanupViolation !== undefined) throw cleanupViolation;
  } catch (error) {
    rollbackFailures.push(
      errorFromUnknown('Repository CommonJS dependency loader restoration failed', error),
    );
  }
  for (const [extension, installedHandler, previousHandler, label] of [
    ['.json', authority.jsonHandler, authority.previousJsonHandler, 'JSON'],
    ['.ts', authority.typescriptHandler, authority.previousTypeScriptHandler, 'TypeScript'],
  ] as const) {
    try {
      let cleanupViolation: Error | undefined;
      if (Reflect.get(authority.extensionRegistry, extension) === installedHandler) {
        if (previousHandler === undefined) {
          if (!Reflect.deleteProperty(authority.extensionRegistry, extension)) {
            throw new Error(`Repository ${label} handler restoration deletion was rejected`);
          }
        } else if (!Reflect.set(authority.extensionRegistry, extension, previousHandler)) {
          throw new Error(`Repository ${label} handler restoration was rejected`);
        }
      } else if (Reflect.get(authority.extensionRegistry, extension) !== previousHandler) {
        cleanupViolation = new Error(`Repository ${label} handler changed during scoped execution`);
        if (previousHandler === undefined) {
          if (!Reflect.deleteProperty(authority.extensionRegistry, extension)) {
            throw new Error(`Repository ${label} handler fallback deletion was rejected`);
          }
        } else if (!Reflect.set(authority.extensionRegistry, extension, previousHandler)) {
          throw new Error(`Repository ${label} handler fallback restoration was rejected`);
        }
      }
      if (Reflect.get(authority.extensionRegistry, extension) !== previousHandler) {
        throw new Error(
          `Repository ${label} handler restoration did not recover the prior generation`,
        );
      }
      if (cleanupViolation !== undefined) throw cleanupViolation;
    } catch (error) {
      rollbackFailures.push(
        errorFromUnknown(`Repository ${label} handler restoration failed`, error),
      );
    }
  }
  try {
    let cleanupViolation: Error | undefined;
    if (currentCommonJsResolver() === authority.resolver) {
      if (!Reflect.set(Module, '_resolveFilename', authority.previousResolver)) {
        throw new Error('Repository CommonJS resolver restoration was rejected');
      }
    } else if (currentCommonJsResolver() !== authority.previousResolver) {
      cleanupViolation = new Error('Repository CommonJS resolver changed during scoped execution');
      if (!Reflect.set(Module, '_resolveFilename', authority.previousResolver)) {
        throw new Error('Repository CommonJS resolver fallback restoration was rejected');
      }
    }
    if (currentCommonJsResolver() !== authority.previousResolver) {
      throw new Error(
        'Repository CommonJS resolver restoration did not recover the prior generation',
      );
    }
    if (cleanupViolation !== undefined) throw cleanupViolation;
  } catch (error) {
    rollbackFailures.push(
      errorFromUnknown('Repository TypeScript path resolver restoration failed', error),
    );
  }
  try {
    assertRepositoryApplicationExecutionRuntimeInactive(authority);
  } catch (error) {
    rollbackFailures.push(
      errorFromUnknown('Repository scoped execution runtime restoration is incomplete', error),
    );
  }
  const onlyFailure = rollbackFailures.length === 1 ? rollbackFailures[0] : undefined;
  if (onlyFailure !== undefined) throw onlyFailure;
  if (rollbackFailures.length > 1) {
    throw new AggregateError(
      rollbackFailures,
      'Repository scoped execution runtime restoration failed',
    );
  }
}

function installRepositoryApplicationExecutionRuntime(
  authority: RepositoryApplicationExecutionAuthorityV1,
): void {
  assertRepositoryExecutionCoordinatesCurrent(authority.coordinates);
  assertRepositoryApplicationExecutionRuntimeInactive(authority);
  for (const alias of authority.aliasCoordinates) {
    if (
      resolveRepositoryAliasCoordinate(
        authority.resolver,
        authority.resolverProbe,
        alias.request,
      ) !== alias.coordinate
    ) {
      throw new Error(`Repository TypeScript alias generation changed: ${alias.request}`);
    }
  }
  let actionFailure: Error | undefined;
  try {
    if (!Reflect.set(Module, '_resolveFilename', authority.resolver)) {
      throw new Error('Repository CommonJS resolver scoped installation was rejected');
    }
    if (!Reflect.set(authority.extensionRegistry, '.json', authority.jsonHandler)) {
      throw new Error('Repository JSON handler scoped installation was rejected');
    }
    if (!Reflect.set(authority.extensionRegistry, '.ts', authority.typescriptHandler)) {
      throw new Error('Repository TypeScript handler scoped installation was rejected');
    }
    if (!Reflect.set(Module, '_load', authority.loader)) {
      throw new Error('Repository CommonJS dependency loader scoped installation was rejected');
    }
    assertRepositoryApplicationExecutionRuntimeCurrent(authority);
    return;
  } catch (error) {
    actionFailure = errorFromUnknown(
      'Repository application scoped execution runtime installation failed',
      error,
    );
  }
  let cleanupFailure: Error | undefined;
  try {
    restoreRepositoryApplicationExecutionRuntime(authority);
  } catch (error) {
    cleanupFailure = errorFromUnknown(
      'Repository application scoped execution runtime rollback failed',
      error,
    );
  }
  if (cleanupFailure !== undefined) {
    throw new AggregateError(
      [actionFailure, cleanupFailure],
      'Repository application scoped execution runtime installation and rollback failed',
    );
  }
  throw actionFailure;
}

function ensureRepositoryApplicationExecutionAuthority(): RepositoryApplicationExecutionAuthorityV1 {
  const active = repositoryApplicationExecutionAuthority;
  if (active !== undefined) {
    assertRepositoryApplicationExecutionAuthorityCurrent(active);
    return active;
  }
  const configPath = resolve(REPO_ROOT, 'tsconfig.base.json');
  const coordinatePaths = [
    configPath,
    resolve(REPO_ROOT, 'package.json'),
    resolve(REPO_ROOT, 'package-lock.json'),
    repositoryRequire.resolve('ts-node/package.json'),
    repositoryRequire.resolve('tsconfig-paths/package.json'),
  ];
  const coordinates = Object.freeze(
    coordinatePaths.map((path) =>
      observeStableRegularFile(
        path,
        MAX_REPOSITORY_EXECUTION_AUTHORITY_FILE_BYTES,
        'Repository application execution authority',
      ),
    ),
  );
  const config = coordinates[0];
  if (config === undefined || config.path !== configPath) {
    throw new Error('Repository application execution authority lost its TypeScript config');
  }
  const paths = requireTypeScriptPathMappings(config);
  const pathPackage: unknown = repositoryRequire('tsconfig-paths');
  if (typeof pathPackage !== 'object' || pathPackage === null) {
    throw new Error('Repository TypeScript path authority package has no object API');
  }
  const registerPaths: unknown = Reflect.get(pathPackage, 'register');
  assertRuntimeCallable<TypeScriptPathRegisterV1>(
    registerPaths,
    'Repository TypeScript path authority package has no governed API',
  );
  const executionPackage: unknown = repositoryRequire('ts-node');
  if (typeof executionPackage !== 'object' || executionPackage === null) {
    throw new Error('Repository TypeScript execution package has no object API');
  }
  const createExecution: unknown = Reflect.get(executionPackage, 'create');
  assertRuntimeCallable<TypeScriptCreateServiceV1>(
    createExecution,
    'Repository TypeScript execution package has no create API',
  );
  const service: unknown = Reflect.apply(createExecution, executionPackage, [
    { project: configPath, transpileOnly: true },
  ]);
  if (typeof service !== 'object' || service === null) {
    throw new Error('Repository TypeScript execution authority created no compiler service');
  }
  const compileTypeScript: unknown = Reflect.get(service, 'compile');
  assertRuntimeCallable<TypeScriptCompileV1>(
    compileTypeScript,
    'Repository TypeScript execution authority exposes no compiler',
  );
  const typescriptHandler = (loadedModule: NodeJS.Module, filename: string): unknown =>
    evaluateRepositoryApplicationDependency(
      loadedModule,
      filename,
      Object.freeze({ extension: '.ts', handler: typescriptHandler }),
      'TypeScript',
      (source, activeAuthority) => {
        const sourceText = decodeFatalUtf8(
          source.content,
          'Repository TypeScript execution source',
        );
        assertRepositoryApplicationTypeScriptSourceAdmitted(sourceText, filename);
        const compiled: unknown = Reflect.apply(compileTypeScript, service, [sourceText, filename]);
        if (typeof compiled !== 'string') {
          throw new Error('Repository TypeScript compiler returned no JavaScript source');
        }
        return compileRepositoryApplicationCommonJs(
          loadedModule,
          filename,
          rewriteCompiledTypeScriptAliasRequests(
            compiled,
            filename,
            activeAuthority.pathMappings,
            activeAuthority.resolver,
            activeAuthority.resolverProbe,
          ),
        );
      },
    );
  const jsonHandler = (loadedModule: NodeJS.Module, filename: string): unknown =>
    evaluateRepositoryApplicationDependency(
      loadedModule,
      filename,
      Object.freeze({ extension: '.json', handler: jsonHandler }),
      'JSON',
      (source) => {
        if (
          source.content.length >= 3 &&
          source.content[0] === 0xef &&
          source.content[1] === 0xbb &&
          source.content[2] === 0xbf
        ) {
          throw new Error(`Repository JSON execution source carries a UTF-8 BOM: ${filename}`);
        }
        const raw = decodeFatalUtf8(source.content, 'Repository JSON execution source');
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new Error(`Repository JSON execution source is not valid JSON: ${filename}`);
        }
        if (!Reflect.set(loadedModule, 'exports', parsed)) {
          throw new Error(`Repository JSON module rejected parsed exports: ${filename}`);
        }
        return parsed;
      },
    );
  const extensionRegistry = currentCommonJsExtensionRegistry();
  const moduleCache = currentCommonJsModuleCache();
  const previousJsonHandler: unknown = Reflect.get(extensionRegistry, '.json');
  const previousTypeScriptHandler: unknown = Reflect.get(extensionRegistry, '.ts');
  const previousLoader = currentCommonJsLoader();
  const previousResolver = currentCommonJsResolver();
  const resolverProbe = createCommonJsResolverProbe();
  let installedResolver: CommonJsResolverV1 | undefined;
  const governedLoader = function (
    this: unknown,
    request: unknown,
    parent: unknown,
    isMain: unknown,
  ): unknown {
    const activeAuthority = repositoryApplicationExecutionAuthority;
    if (activeAuthority === undefined) {
      throw new Error('Repository application dependency loader has no active execution authority');
    }
    assertRepositoryApplicationExecutionRuntimeCurrent(activeAuthority);
    const frame = repositoryApplicationEvaluationRoots.at(-1);
    if (frame !== undefined) {
      if (typeof request !== 'string' || installedResolver === undefined) {
        throw new Error('Repository application dependency loader received no governed request');
      }
      const coordinate: unknown = Reflect.apply(installedResolver, Module, [
        request,
        parent,
        isMain,
      ]);
      if (typeof coordinate !== 'string') {
        throw new Error(`Repository application dependency resolved no coordinate: ${request}`);
      }
      assertGovernedRepositoryDependencyCoordinate(moduleCache, frame, coordinate);
    }
    assertRepositoryApplicationExecutionRuntimeCurrent(activeAuthority);
    let result: unknown;
    let actionFailure: Error | undefined;
    try {
      result = Reflect.apply(previousLoader, this, [request, parent, isMain]);
    } catch (error) {
      actionFailure = errorFromUnknown('Repository application dependency load failed', error);
    }
    let runtimeFailure: Error | undefined;
    try {
      assertRepositoryApplicationExecutionRuntimeCurrent(activeAuthority);
    } catch (error) {
      runtimeFailure = errorFromUnknown(
        'Repository application execution authority validation failed',
        error,
      );
    }
    if (actionFailure !== undefined && runtimeFailure !== undefined) {
      throw new AggregateError(
        [actionFailure, runtimeFailure],
        'Repository dependency load and execution authority validation failed',
      );
    }
    if (actionFailure !== undefined) throw actionFailure;
    if (runtimeFailure !== undefined) throw runtimeFailure;
    return result;
  };
  let actionFailure: Error | undefined;
  let aliasCoordinates:
    | readonly Readonly<{ readonly coordinate: string; readonly request: string }>[]
    | undefined;
  let unregisterPathsValue: TypeScriptPathUnregisterV1 | undefined;
  try {
    const unregisterPathsCapability: unknown = Reflect.apply(registerPaths, pathPackage, [
      { baseUrl: REPO_ROOT, paths },
    ]);
    assertRuntimeCallable<TypeScriptPathUnregisterV1>(
      unregisterPathsCapability,
      'Repository TypeScript path authority returned no cleanup capability',
    );
    unregisterPathsValue = unregisterPathsCapability;
    installedResolver = currentCommonJsResolver();
    aliasCoordinates = resolveRepositoryAliasCoordinates(installedResolver, resolverProbe, paths);
    assertRepositoryExecutionCoordinatesCurrent(coordinates);
  } catch (error) {
    actionFailure = errorFromUnknown(
      'Repository application execution authority construction failed',
      error,
    );
  }
  let cleanupFailure: Error | undefined;
  try {
    let cleanupViolation: Error | undefined;
    if (unregisterPathsValue !== undefined && currentCommonJsResolver() === installedResolver) {
      Reflect.apply(unregisterPathsValue, undefined, []);
      if (currentCommonJsResolver() !== previousResolver) {
        cleanupViolation = new Error(
          'Repository TypeScript path cleanup did not restore the prior resolver generation',
        );
      }
    }
    if (currentCommonJsResolver() !== previousResolver) {
      if (!Reflect.set(Module, '_resolveFilename', previousResolver)) {
        throw new Error('Repository CommonJS resolver rollback was rejected');
      }
    }
    if (currentCommonJsResolver() !== previousResolver) {
      throw new Error('Repository CommonJS resolver rollback did not restore the prior generation');
    }
    if (cleanupViolation !== undefined) throw cleanupViolation;
  } catch (error) {
    cleanupFailure = errorFromUnknown(
      'Repository TypeScript path resolver capability cleanup failed',
      error,
    );
  }
  if (actionFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [actionFailure, cleanupFailure],
      'Repository application execution authority construction and cleanup failed',
    );
  }
  if (actionFailure !== undefined) throw actionFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (installedResolver === undefined || aliasCoordinates === undefined) {
    throw new Error('Repository application execution authority construction was incomplete');
  }
  const authority = Object.freeze({
    aliasCoordinates,
    compiler: compileTypeScript,
    coordinates,
    extensionRegistry,
    jsonHandler,
    loader: governedLoader,
    moduleCache,
    pathMappings: paths,
    previousJsonHandler,
    previousLoader,
    previousResolver,
    previousTypeScriptHandler,
    resolver: installedResolver,
    resolverProbe,
    service,
    typescriptHandler,
  });
  repositoryApplicationExecutionAuthority = authority;
  try {
    assertRepositoryApplicationExecutionAuthorityCurrent(authority);
  } catch (error) {
    repositoryApplicationExecutionAuthority = undefined;
    throw error;
  }
  return authority;
}

function requireEffectiveUserId(): bigint {
  const getEffectiveUserId = process.geteuid;
  if (typeof getEffectiveUserId !== 'function') {
    throw new Error('Repository application module loader requires a POSIX effective user ID');
  }
  return BigInt(getEffectiveUserId());
}

function requireRepositoryApplicationExtensionHandler(
  targetPath: string,
): RepositoryApplicationExtensionHandlerV1 {
  const executionAuthority = ensureRepositoryApplicationExecutionAuthority();
  const extension = extname(targetPath);
  if (extension === '.json') {
    return Object.freeze({ extension, handler: executionAuthority.jsonHandler });
  }
  if (extension === '.ts') {
    return Object.freeze({ extension, handler: executionAuthority.typescriptHandler });
  }
  throw new TypeError(
    `Repository application module target has no governed application extension: ${targetPath}`,
  );
}

function writeRepositoryApplicationModuleSnapshot(coordinate: string, sourceContent: Buffer): void {
  let descriptor: number | undefined;
  let actionFailure: Error | undefined;
  try {
    descriptor = openSync(
      coordinate,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o400,
    );
    writeFileSync(descriptor, sourceContent);
    fsyncSync(descriptor);
  } catch (error) {
    actionFailure = errorFromUnknown('Repository application module snapshot write failed', error);
  }
  let cleanupFailure: Error | undefined;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      cleanupFailure = errorFromUnknown(
        'Repository application module snapshot cleanup failed',
        error,
      );
    }
  }
  if (actionFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [actionFailure, cleanupFailure],
      'Repository application module snapshot write and descriptor cleanup failed',
    );
  }
  if (actionFailure !== undefined) throw actionFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
}

function assertRepositoryApplicationModuleSnapshot(
  coordinate: string,
  sourceContent: Buffer,
  digestSha256: string,
): void {
  const snapshot = lstatSync(coordinate, { bigint: true });
  if (
    !snapshot.isFile() ||
    snapshot.isSymbolicLink() ||
    (snapshot.mode & 0o777n) !== 0o400n ||
    snapshot.uid !== requireEffectiveUserId() ||
    snapshot.size !== BigInt(sourceContent.length) ||
    contentSha256(readFileSync(coordinate)) !== digestSha256
  ) {
    throw new Error('Repository application module scratch snapshot differs from pinned bytes');
  }
}

function createRepositoryApplicationModule(
  targetPath: string,
  digestSha256: string,
): NodeJS.Module {
  const identity = `repository-application:${digestSha256}:${targetPath}`;
  const loadedModule = new Module(identity);
  loadedModule.filename = targetPath;
  loadedModule.path = dirname(targetPath);
  loadedModule.paths =
    createRequire(targetPath).resolve.paths('repository-application-module') ?? [];
  return loadedModule;
}

function evaluateDescriptorBoundRepositoryApplicationModule(
  opened: RepositoryApplicationModuleDescriptorV1,
  loadedModule: NodeJS.Module,
  sourceContent: Buffer,
  extensionHandler: RepositoryApplicationExtensionHandlerV1,
  entry: RepositoryApplicationModuleCacheEntryV1,
): void {
  const originalCompile: unknown = Reflect.get(loadedModule, '_compile');
  assertRuntimeCallable<CommonJsCompilerV1>(
    originalCompile,
    'Repository application Module instance exposes no CommonJS compiler',
  );
  const compileWithCanonicalIdentity = function (
    this: NodeJS.Module,
    content: string | Buffer,
  ): unknown {
    return Reflect.apply(originalCompile, this, [content, opened.targetPath]);
  };
  if (!Reflect.set(loadedModule, '_compile', compileWithCanonicalIdentity)) {
    throw new Error('Repository application Module compiler cannot be descriptor-bound');
  }
  const canonicalScratchRoot = realpathSync(tmpdir());
  const handlerRoot = mkdtempSync(
    join(canonicalScratchRoot, 'aqua-repository-application-module-'),
  );
  const handlerCoordinate = join(handlerRoot, `source${extname(opened.targetPath)}`);
  let actionFailure: Error | undefined;
  const sourceDigestSha256 = contentSha256(sourceContent);
  try {
    const effectiveUserId = requireEffectiveUserId();
    const handlerRootStat = lstatSync(handlerRoot, { bigint: true });
    if (
      !isPathBelow(canonicalScratchRoot, handlerRoot) ||
      handlerRoot === opened.repositoryRoot ||
      isPathBelow(opened.repositoryRoot, handlerRoot) ||
      !handlerRootStat.isDirectory() ||
      handlerRootStat.isSymbolicLink() ||
      (handlerRootStat.mode & 0o777n) !== 0o700n ||
      handlerRootStat.uid !== effectiveUserId
    ) {
      throw new Error(
        'Repository application module scratch authority is not one external owned 0700 directory',
      );
    }
    writeRepositoryApplicationModuleSnapshot(handlerCoordinate, sourceContent);
    assertRepositoryApplicationModuleSnapshot(handlerCoordinate, sourceContent, sourceDigestSha256);
    withRepositoryApplicationEvaluationRoot(opened.repositoryRoot, (frame) => {
      entry.loadingEvaluationToken = frame.token;
      const result = extensionHandler.handler(loadedModule, handlerCoordinate);
      loadedModule.loaded = true;
      sealRepositoryApplicationModuleRequire(entry, opened.targetPath);
      entry.state = 'LOADED';
      entry.loadingEvaluationToken = undefined;
      return result;
    });
    assertRepositoryApplicationModuleSnapshot(handlerCoordinate, sourceContent, sourceDigestSha256);
  } catch (error) {
    actionFailure = errorFromUnknown('Repository application module evaluation failed', error);
  }
  const cleanupFailures: Error[] = [];
  if (existsSync(handlerCoordinate)) {
    try {
      unlinkSync(handlerCoordinate);
    } catch (error) {
      cleanupFailures.push(
        errorFromUnknown('Repository application module snapshot cleanup failed', error),
      );
    }
  }
  try {
    rmdirSync(handlerRoot);
  } catch (error) {
    cleanupFailures.push(
      errorFromUnknown('Repository application module scratch root cleanup failed', error),
    );
  }
  if (existsSync(handlerCoordinate)) {
    cleanupFailures.push(
      new Error('Repository application module scratch snapshot survived owned cleanup'),
    );
  }
  if (existsSync(handlerRoot)) {
    cleanupFailures.push(new Error('Repository application module scratch root survived cleanup'));
  }
  if (actionFailure !== undefined || cleanupFailures.length > 0) {
    const failures: Error[] = [
      ...(actionFailure === undefined ? [] : [actionFailure]),
      ...cleanupFailures,
    ];
    const onlyFailure = failures.length === 1 ? failures[0] : undefined;
    if (onlyFailure !== undefined) throw onlyFailure;
    throw new AggregateError(
      failures,
      'Repository application module evaluation and descriptor alias cleanup failed',
    );
  }
}

function assertLoaderOwnsCanonicalModuleCache(
  targetPath: string,
  expectedModule: NodeJS.Module,
): void {
  const authority = repositoryApplicationExecutionAuthority;
  if (
    authority === undefined ||
    readCommonJsModuleCache(authority.moduleCache, targetPath) !== expectedModule
  ) {
    throw new Error(
      `Repository application module cache authority was replaced or removed: ${targetPath}`,
    );
  }
}

function loadOpenedRepositoryApplicationModule(
  opened: RepositoryApplicationModuleDescriptorV1,
): unknown {
  const sourceContent = readBoundedDescriptorContent(opened);
  const digestSha256 = contentSha256(sourceContent);
  const sourceObservation = observeStableRegularFile(
    opened.targetPath,
    MAX_REPOSITORY_APPLICATION_MODULE_BYTES,
    'Repository application module cache source',
  );
  if (
    sourceObservation.sha256 !== digestSha256 ||
    !sameBigIntFileObservation(sourceObservation.stat, opened.generation)
  ) {
    throw new Error(
      `Repository application module source observation changed: ${opened.targetPath}`,
    );
  }
  const extensionHandler = requireRepositoryApplicationExtensionHandler(opened.targetPath);
  const executionAuthority = repositoryApplicationExecutionAuthority;
  if (executionAuthority === undefined) {
    throw new Error('Repository application module cache has no execution authority');
  }
  const cached = repositoryApplicationModuleCache.get(opened.targetPath);
  if (cached !== undefined) {
    if (
      !sameBigIntFileObservation(cached.generation, opened.generation) ||
      cached.digestSha256 !== digestSha256
    ) {
      throw new Error(
        `Repository application module generation changed after first governed load: ${opened.targetPath}`,
      );
    }
    if (
      cached.extensionHandler.extension !== extensionHandler.extension ||
      cached.extensionHandler.handler !== extensionHandler.handler
    ) {
      throw new Error(
        `Repository application module extension handler changed after first governed load: ${opened.targetPath}`,
      );
    }
    assertLoaderOwnsCanonicalModuleCache(opened.targetPath, cached.module);
    if (cached.state === 'LOADING') {
      if (cached.module.loaded) {
        throw new Error(
          `Repository application module LOADING cache state has a loaded Module: ${opened.targetPath}`,
        );
      }
      assertRepositoryApplicationExecutionAuthorityCurrent(executionAuthority);
      const loadingExports: unknown = Reflect.get(cached.module, 'exports');
      return loadingExports;
    }
    if (cached.state === 'LOADED') {
      if (!cached.module.loaded) {
        throw new Error(
          `Repository application module LOADED cache state has an unloaded Module: ${opened.targetPath}`,
        );
      }
      assertRepositoryApplicationExecutionAuthorityCurrent(executionAuthority);
      const loadedExports: unknown = Reflect.get(cached.module, 'exports');
      return loadedExports;
    }
    throw new Error(
      `Repository application module cache has an invalid state: ${opened.targetPath}`,
    );
  }
  const externalModule = readCommonJsModuleCache(executionAuthority.moduleCache, opened.targetPath);
  if (externalModule !== undefined) {
    const externalFilename: unknown =
      typeof externalModule === 'object' && externalModule !== null
        ? Reflect.get(externalModule, 'filename')
        : undefined;
    const externalLoaded: unknown =
      typeof externalModule === 'object' && externalModule !== null
        ? Reflect.get(externalModule, 'loaded')
        : undefined;
    throw new Error(
      `Repository application module target already has an external CommonJS cache authority: ${opened.targetPath} (filename=${String(externalFilename)}, loaded=${String(externalLoaded)}, value=${typeof externalModule})`,
    );
  }

  const loadedModule = createRepositoryApplicationModule(opened.targetPath, digestSha256);
  const entry: RepositoryApplicationModuleCacheEntryV1 = {
    digestSha256,
    extensionHandler,
    generation: opened.generation,
    loadingEvaluationToken: undefined,
    module: loadedModule,
    requireAuthority: createRepositoryApplicationModuleRequireAuthority(
      loadedModule,
      opened.targetPath,
    ),
    sourceObservation,
    state: 'LOADING',
  };
  writeCommonJsModuleCache(executionAuthority.moduleCache, opened.targetPath, loadedModule);
  repositoryApplicationModuleCache.set(opened.targetPath, entry);
  try {
    evaluateDescriptorBoundRepositoryApplicationModule(
      opened,
      loadedModule,
      sourceContent,
      extensionHandler,
      entry,
    );
    assertDescriptorMatchesTarget(opened.descriptor, opened.targetPath, opened.generation);
    if (
      contentSha256(readFileSync(`/proc/self/fd/${String(opened.descriptor)}`)) !== digestSha256
    ) {
      throw new Error(
        `Repository application module content changed during governed evaluation: ${opened.targetPath}`,
      );
    }
    const finalExtensionHandler = requireRepositoryApplicationExtensionHandler(opened.targetPath);
    if (
      finalExtensionHandler.extension !== extensionHandler.extension ||
      finalExtensionHandler.handler !== extensionHandler.handler
    ) {
      throw new Error(
        `Repository application module extension handler changed during governed evaluation: ${opened.targetPath}`,
      );
    }
    assertLoaderOwnsCanonicalModuleCache(opened.targetPath, loadedModule);
    if (repositoryApplicationModuleCache.get(opened.targetPath) !== entry) {
      throw new Error(
        `Repository application module generation authority was replaced: ${opened.targetPath}`,
      );
    }
    assertRepositoryApplicationExecutionAuthorityCurrent(executionAuthority);
    const exportsValue: unknown = Reflect.get(loadedModule, 'exports');
    return exportsValue;
  } catch (error) {
    if (repositoryApplicationModuleCache.get(opened.targetPath) === entry) {
      repositoryApplicationModuleCache.delete(opened.targetPath);
    }
    if (
      readCommonJsModuleCache(executionAuthority.moduleCache, opened.targetPath) === loadedModule
    ) {
      deleteCommonJsModuleCache(executionAuthority.moduleCache, opened.targetPath);
    }
    throw errorFromUnknown('Repository application module evaluation failed', error);
  }
}

function openRepositoryApplicationModule(
  repositoryRoot: string,
  targetPath: string,
): RepositoryApplicationModuleDescriptorV1 {
  const canonicalRepositoryRoot = resolve(repositoryRoot);
  if (!isAbsolute(repositoryRoot) || canonicalRepositoryRoot !== repositoryRoot) {
    throw new TypeError('Repository application module authority requires one canonical root');
  }
  const applicationRoot = resolve(canonicalRepositoryRoot, 'apps');
  const canonicalTarget = resolve(targetPath);
  if (
    !isAbsolute(targetPath) ||
    canonicalTarget !== targetPath ||
    !isPathBelow(applicationRoot, canonicalTarget)
  ) {
    throw new TypeError(
      `Repository application module target must be one canonical path below ${applicationRoot}`,
    );
  }
  if (!REPOSITORY_APPLICATION_MODULE_EXTENSIONS.has(extname(canonicalTarget))) {
    throw new TypeError(
      `Repository application module target has no governed application extension: ${canonicalTarget}`,
    );
  }

  const parent = openAnchoredDirectoryChain(
    dirname(canonicalTarget),
    'Repository application module parent',
  );
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      `/proc/self/fd/${String(parent.descriptor)}/${basename(canonicalTarget)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const generation = assertDescriptorMatchesTarget(descriptor, canonicalTarget);
    assertAnchoredDirectoryChainIdentityCurrent(parent, 'Repository application module parent');
    return Object.freeze({
      descriptor,
      generation,
      parent,
      repositoryRoot: canonicalRepositoryRoot,
      targetPath: canonicalTarget,
    });
  } catch (error) {
    const primaryFailure = errorFromUnknown('Repository application module open failed', error);
    const cleanupErrors: Error[] = [];
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (cleanupError) {
        cleanupErrors.push(
          errorFromUnknown('Repository application module descriptor cleanup failed', cleanupError),
        );
      }
    }
    try {
      closeAnchoredDirectoryChain(parent);
    } catch (cleanupError) {
      cleanupErrors.push(
        errorFromUnknown('Repository application module parent cleanup failed', cleanupError),
      );
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [primaryFailure, ...cleanupErrors],
        'Repository application module open and cleanup both failed',
      );
    }
    throw primaryFailure;
  }
}

function closeRepositoryApplicationModule(opened: RepositoryApplicationModuleDescriptorV1): void {
  const failures: Error[] = [];
  try {
    closeSync(opened.descriptor);
  } catch (error) {
    failures.push(
      errorFromUnknown('Repository application module descriptor cleanup failed', error),
    );
  }
  try {
    closeAnchoredDirectoryChain(opened.parent);
  } catch (error) {
    failures.push(errorFromUnknown('Repository application module parent cleanup failed', error));
  }
  const onlyFailure = failures.length === 1 ? failures[0] : undefined;
  if (onlyFailure !== undefined) throw onlyFailure;
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Repository application module descriptor cleanup failed');
  }
}

function loadRepositoryApplicationModuleFromRoot(
  repositoryRoot: string,
  targetPath: string,
  beforeDescriptorLoad: (descriptor: number) => void,
): unknown {
  const opened = openRepositoryApplicationModule(repositoryRoot, targetPath);
  let result: unknown;
  let actionFailure: Error | undefined;
  try {
    beforeDescriptorLoad(opened.descriptor);
    assertDescriptorMatchesTarget(opened.descriptor, opened.targetPath, opened.generation);
    assertAnchoredDirectoryChainIdentityCurrent(
      opened.parent,
      'Repository application module parent',
    );
    result = loadOpenedRepositoryApplicationModule(opened);
    assertDescriptorMatchesTarget(opened.descriptor, opened.targetPath, opened.generation);
    assertAnchoredDirectoryChainIdentityCurrent(
      opened.parent,
      'Repository application module parent',
    );
  } catch (error) {
    actionFailure = errorFromUnknown('Repository application module load failed', error);
  }

  try {
    closeRepositoryApplicationModule(opened);
  } catch (cleanupCause) {
    const cleanupFailure = errorFromUnknown(
      'Repository application module cleanup failed',
      cleanupCause,
    );
    if (actionFailure !== undefined) {
      throw new AggregateError(
        [actionFailure, cleanupFailure],
        'Repository application module load and cleanup both failed',
      );
    }
    throw cleanupFailure;
  }
  if (actionFailure !== undefined) throw actionFailure;
  return result;
}

/**
 * The sole computed local-module capability used by repository test/build discovery. Targets are
 * descriptor-bound below this checkout's `apps/` authority; writer/control-plane modules are not
 * in its runtime domain.
 */
export function loadRepositoryApplicationModule(targetPath: string): unknown {
  return loadRepositoryApplicationModuleFromRoot(REPO_ROOT, targetPath, () => undefined);
}

/** Exact-import lifecycle seam owned only by this module's contract spec. */
export function testOnlyLoadRepositoryApplicationModuleFromRoot(
  repositoryRoot: string,
  targetPath: string,
  beforeDescriptorLoad: (descriptor: number) => void = () => undefined,
): unknown {
  return loadRepositoryApplicationModuleFromRoot(
    resolve(repositoryRoot),
    resolve(targetPath),
    beforeDescriptorLoad,
  );
}

/** Exact-import lifecycle cleanup seam owned only by this module's contract spec. */
export function testOnlyReleaseRepositoryApplicationModulesBelowRoot(repositoryRoot: string): void {
  if (repositoryApplicationEvaluationRoots.length !== 0) {
    throw new Error('Repository application fixture cleanup crossed an active evaluation graph');
  }
  const canonicalRoot = resolve(repositoryRoot);
  const authority = repositoryApplicationExecutionAuthority;
  for (const [targetPath, entry] of [...repositoryApplicationModuleCache.entries()]) {
    if (!isPathBelow(canonicalRoot, targetPath)) continue;
    if (
      authority !== undefined &&
      readCommonJsModuleCache(authority.moduleCache, targetPath) === entry.module
    ) {
      deleteCommonJsModuleCache(authority.moduleCache, targetPath);
    }
    repositoryApplicationModuleCache.delete(targetPath);
  }
}
