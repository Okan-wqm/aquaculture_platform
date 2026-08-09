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
  observeStableRegularFile,
  openAnchoredDirectoryChain,
  sameBigIntFileObservation,
  type AnchoredDirectoryChainV1,
  type StableRegularFileObservationV1,
} from './anchored-filesystem';
import { errorFromUnknown } from './error-cause';
import { REPO_ROOT } from './repo-root';

const repositoryRequire = createRequire(__filename);
const REPOSITORY_APPLICATION_MODULE_EXTENSIONS = new Set(['.ts']);
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

interface RepositoryApplicationModuleCacheEntryV1 {
  readonly digestSha256: string;
  readonly extensionHandler: RepositoryApplicationExtensionHandlerV1;
  readonly generation: BigIntStats;
  readonly module: NodeJS.Module;
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
  readonly loader: CommonJsLoaderV1;
  readonly moduleCache: object;
  readonly pathMappings: Readonly<Record<string, readonly string[]>>;
  readonly resolver: CommonJsResolverV1;
  readonly resolverProbe: NodeJS.Module;
  readonly service: object;
  readonly typescriptHandler: RepositoryApplicationExtensionHandlerV1['handler'];
  readonly unregisterPaths: () => void;
}

let repositoryApplicationExecutionAuthority: RepositoryApplicationExecutionAuthorityV1 | undefined;

function withRepositoryApplicationEvaluationRoot<T>(
  repositoryRoot: string,
  action: (frame: RepositoryApplicationEvaluationFrameV1) => T,
): T {
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
  if (actionFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [actionFailure, cleanupFailure],
      'Repository application evaluation and root capability cleanup failed',
    );
  }
  if (actionFailure !== undefined) throw actionFailure;
  if (cleanupFailure !== undefined) throw cleanupFailure;
  return result as T;
}

function requireRepositoryApplicationEvaluationRoot(): string {
  const frame = repositoryApplicationEvaluationRoots.at(-1);
  if (frame === undefined) {
    throw new Error('Repository TypeScript handler escaped a governed evaluation root');
  }
  return frame.repositoryRoot;
}

function requireRepositoryApplicationEvaluationToken(): object {
  const frame = repositoryApplicationEvaluationRoots.at(-1);
  if (frame === undefined) {
    throw new Error('Repository TypeScript handler escaped a governed evaluation generation');
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
        `Repository application module LOADING authority escaped its graph: ${targetPath}`,
      );
    }
  } else if (
    entry.state !== 'LOADED' ||
    !entry.module.loaded ||
    entry.loadingEvaluationToken !== undefined
  ) {
    throw new Error(
      `Repository application module LOADED authority is inconsistent: ${targetPath}`,
    );
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
  if (extname(coordinate) !== '.ts') {
    throw new Error(`Repository application dependency is not governed TypeScript: ${coordinate}`);
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

function assertRepositoryApplicationExecutionRuntimeCurrent(
  authority: RepositoryApplicationExecutionAuthorityV1,
): void {
  if (
    currentCommonJsExtensionRegistry() !== authority.extensionRegistry ||
    Reflect.get(authority.extensionRegistry, '.ts') !== authority.typescriptHandler ||
    currentCommonJsLoader() !== authority.loader ||
    currentCommonJsModuleCache() !== authority.moduleCache ||
    currentCommonJsResolver() !== authority.resolver ||
    Reflect.get(authority.service, 'compile') !== authority.compiler
  ) {
    throw new Error('Repository application execution authority generation changed');
  }
}

function assertRepositoryApplicationExecutionAuthorityCurrent(
  authority: RepositoryApplicationExecutionAuthorityV1,
): void {
  assertRepositoryExecutionCoordinatesCurrent(authority.coordinates);
  assertRepositoryApplicationExecutionRuntimeCurrent(authority);
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
  const typescriptHandler = (loadedModule: NodeJS.Module, filename: string): unknown => {
    const activeAuthority = repositoryApplicationExecutionAuthority;
    if (activeAuthority === undefined) {
      throw new Error('Repository TypeScript handler has no active execution authority');
    }
    assertRepositoryApplicationExecutionRuntimeCurrent(activeAuthority);
    const source = observeStableRegularFile(
      filename,
      MAX_REPOSITORY_APPLICATION_MODULE_BYTES,
      'Repository TypeScript execution source',
    );
    const evaluationRoot = requireRepositoryApplicationEvaluationRoot();
    const canonicalModuleFilename = resolve(loadedModule.filename);
    const governedDependency =
      resolve(filename) === filename &&
      isPathBelow(evaluationRoot, filename) &&
      extname(filename) === '.ts';
    if (
      !governedDependency &&
      (canonicalModuleFilename !== loadedModule.filename ||
        !isPathBelow(evaluationRoot, canonicalModuleFilename))
    ) {
      throw new Error(`Repository TypeScript source escaped its evaluation root: ${filename}`);
    }
    let dependencyEntry: RepositoryApplicationModuleCacheEntryV1 | undefined;
    if (governedDependency) {
      if (readCommonJsModuleCache(activeAuthority.moduleCache, filename) !== loadedModule) {
        throw new Error(
          `Repository TypeScript dependency has no canonical cache ownership: ${filename}`,
        );
      }
      const existing = repositoryApplicationModuleCache.get(filename);
      if (existing !== undefined) {
        throw new Error(
          `Repository TypeScript dependency duplicated its governed load: ${filename}`,
        );
      }
      dependencyEntry = {
        digestSha256: source.sha256,
        extensionHandler: Object.freeze({ extension: '.ts', handler: typescriptHandler }),
        generation: source.stat,
        loadingEvaluationToken: requireRepositoryApplicationEvaluationToken(),
        module: loadedModule,
        sourceObservation: source,
        state: 'LOADING',
      };
      repositoryApplicationModuleCache.set(filename, dependencyEntry);
    }
    let actionFailure: Error | undefined;
    let result: unknown;
    try {
      const compiled: unknown = Reflect.apply(compileTypeScript, service, [
        source.content.toString('utf8'),
        filename,
      ]);
      if (typeof compiled !== 'string') {
        throw new Error('Repository TypeScript compiler returned no JavaScript source');
      }
      assertRepositoryApplicationExecutionRuntimeCurrent(activeAuthority);
      result = compileRepositoryApplicationCommonJs(
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
      assertStableRegularFileCurrent(
        source,
        MAX_REPOSITORY_APPLICATION_MODULE_BYTES,
        'Repository TypeScript execution source',
      );
      if (dependencyEntry !== undefined) {
        if (
          repositoryApplicationModuleCache.get(filename) !== dependencyEntry ||
          readCommonJsModuleCache(activeAuthority.moduleCache, filename) !== loadedModule
        ) {
          throw new Error(`Repository TypeScript dependency authority changed: ${filename}`);
        }
        loadedModule.loaded = true;
        dependencyEntry.state = 'LOADED';
        dependencyEntry.loadingEvaluationToken = undefined;
      }
    } catch (error) {
      actionFailure = errorFromUnknown('Repository TypeScript dependency evaluation failed', error);
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
          errorFromUnknown('Repository TypeScript dependency cache cleanup failed', error),
        );
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [actionFailure, ...cleanupFailures],
        'Repository TypeScript dependency evaluation and cache cleanup failed',
      );
    }
    throw actionFailure;
  };
  const extensionRegistry = currentCommonJsExtensionRegistry();
  const moduleCache = currentCommonJsModuleCache();
  const previousTypeScriptHandler: unknown = Reflect.get(extensionRegistry, '.ts');
  const previousLoader = currentCommonJsLoader();
  const previousResolver = currentCommonJsResolver();
  const resolverProbe = createCommonJsResolverProbe();
  let installedUnregisterPaths: TypeScriptPathUnregisterV1 | undefined;
  let installedResolver: CommonJsResolverV1 | undefined;
  let loaderInstalled = false;
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
  try {
    const unregisterPathsValue: unknown = Reflect.apply(registerPaths, pathPackage, [
      { baseUrl: REPO_ROOT, paths },
    ]);
    assertRuntimeCallable<TypeScriptPathUnregisterV1>(
      unregisterPathsValue,
      'Repository TypeScript path authority returned no cleanup capability',
    );
    installedUnregisterPaths = unregisterPathsValue;
    installedResolver = currentCommonJsResolver();
    if (!Reflect.set(extensionRegistry, '.ts', typescriptHandler)) {
      throw new Error('Repository TypeScript handler installation was rejected');
    }
    if (!Reflect.set(Module, '_load', governedLoader)) {
      throw new Error('Repository CommonJS dependency loader installation was rejected');
    }
    loaderInstalled = true;
    const aliasCoordinates = resolveRepositoryAliasCoordinates(
      installedResolver,
      resolverProbe,
      paths,
    );
    assertRepositoryExecutionCoordinatesCurrent(coordinates);
    const unregisterPaths = (): void => {
      Reflect.apply(unregisterPathsValue, undefined, []);
    };
    const authority = Object.freeze({
      aliasCoordinates,
      compiler: compileTypeScript,
      coordinates,
      extensionRegistry,
      loader: governedLoader,
      moduleCache,
      pathMappings: paths,
      resolver: installedResolver,
      resolverProbe,
      service,
      typescriptHandler,
      unregisterPaths,
    });
    repositoryApplicationExecutionAuthority = authority;
    assertRepositoryApplicationExecutionAuthorityCurrent(authority);
    return authority;
  } catch (error) {
    actionFailure = errorFromUnknown(
      'Repository application execution authority installation failed',
      error,
    );
  }
  if (repositoryApplicationExecutionAuthority?.loader === governedLoader) {
    repositoryApplicationExecutionAuthority = undefined;
  }
  const rollbackFailures: Error[] = [];
  try {
    let cleanupViolation: Error | undefined;
    if (loaderInstalled && currentCommonJsLoader() === governedLoader) {
      if (!Reflect.set(Module, '_load', previousLoader)) {
        throw new Error('Repository CommonJS dependency loader rollback was rejected');
      }
    } else if (currentCommonJsLoader() !== previousLoader) {
      cleanupViolation = new Error(
        'Repository CommonJS dependency loader changed during authority rollback',
      );
      if (!Reflect.set(Module, '_load', previousLoader)) {
        throw new Error('Repository CommonJS dependency loader fallback rollback was rejected');
      }
    }
    if (currentCommonJsLoader() !== previousLoader) {
      throw new Error(
        'Repository CommonJS dependency loader rollback did not restore the prior generation',
      );
    }
    if (cleanupViolation !== undefined) throw cleanupViolation;
  } catch (error) {
    rollbackFailures.push(
      errorFromUnknown('Repository CommonJS dependency loader rollback failed', error),
    );
  }
  try {
    if (Reflect.get(extensionRegistry, '.ts') === typescriptHandler) {
      if (previousTypeScriptHandler === undefined) {
        if (!Reflect.deleteProperty(extensionRegistry, '.ts')) {
          throw new Error('Repository TypeScript handler rollback deletion was rejected');
        }
      } else {
        if (!Reflect.set(extensionRegistry, '.ts', previousTypeScriptHandler)) {
          throw new Error('Repository TypeScript handler rollback restoration was rejected');
        }
      }
    } else if (Reflect.get(extensionRegistry, '.ts') !== previousTypeScriptHandler) {
      throw new Error('Repository TypeScript handler changed during authority rollback');
    }
    if (Reflect.get(extensionRegistry, '.ts') !== previousTypeScriptHandler) {
      throw new Error(
        'Repository TypeScript handler rollback did not restore the prior generation',
      );
    }
    if (currentCommonJsExtensionRegistry() !== extensionRegistry) {
      throw new Error('Repository CommonJS extension registry changed during authority rollback');
    }
  } catch (error) {
    rollbackFailures.push(errorFromUnknown('Repository TypeScript handler rollback failed', error));
  }
  try {
    let cleanupViolation: Error | undefined;
    if (installedUnregisterPaths !== undefined && currentCommonJsResolver() === installedResolver) {
      Reflect.apply(installedUnregisterPaths, undefined, []);
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
    rollbackFailures.push(
      errorFromUnknown('Repository TypeScript path resolver rollback failed', error),
    );
  }
  if (rollbackFailures.length > 0) {
    throw new AggregateError(
      [actionFailure, ...rollbackFailures],
      'Repository application execution authority install and rollback failed',
    );
  }
  if (actionFailure === undefined) {
    throw new Error('Repository application execution authority installation lost its failure');
  }
  throw actionFailure;
}

function requireEffectiveUserId(): bigint {
  const getEffectiveUserId = process.geteuid;
  if (typeof getEffectiveUserId !== 'function') {
    throw new Error('Repository application module loader requires a POSIX effective user ID');
  }
  return BigInt(getEffectiveUserId());
}

function requireRepositoryApplicationExtensionHandler(
  _targetPath: string,
): RepositoryApplicationExtensionHandlerV1 {
  const executionAuthority = ensureRepositoryApplicationExecutionAuthority();
  return Object.freeze({ extension: '.ts', handler: executionAuthority.typescriptHandler });
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
      return extensionHandler.handler(loadedModule, handlerCoordinate);
    });
    assertRepositoryApplicationModuleSnapshot(handlerCoordinate, sourceContent, sourceDigestSha256);
    loadedModule.loaded = true;
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
    entry.state = 'LOADED';
    entry.loadingEvaluationToken = undefined;
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
      `Repository application module target has no governed TypeScript application extension: ${canonicalTarget}`,
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
