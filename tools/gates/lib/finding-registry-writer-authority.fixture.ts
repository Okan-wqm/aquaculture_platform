import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import {
  FINDING_WRITER_DYNAMIC_MODULE_LOADER_AUTHORITY,
  FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY,
  FINDING_WRITER_SENSITIVE_READ_ONLY_EXPORTS,
} from './finding-registry-writer-authority';

function fixtureModuleSpecifier(importer: string, target: string): string {
  const relativeTarget = relative(dirname(importer), target)
    .replaceAll('\\', '/')
    .replace(/\.[cm]?[jt]sx?$/, '');
  return relativeTarget.startsWith('.') ? relativeTarget : `./${relativeTarget}`;
}

export function renderFindingWriterSensitiveFixtureModule(path: string, body = ''): string {
  const importsByTarget = new Map<string, string[]>();
  for (const authority of FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY) {
    if (!authority.importers.includes(path)) continue;
    const symbols = importsByTarget.get(authority.target) ?? [];
    symbols.push(authority.symbol);
    importsByTarget.set(authority.target, symbols);
  }
  const imports = [...importsByTarget]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(
      ([target, symbols]) =>
        `import { ${[...new Set(symbols)].sort().join(', ')} } from '${fixtureModuleSpecifier(
          path,
          target,
        )}';`,
    );
  const runtimeExports = [
    ...FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY.filter(
      (authority) => authority.target === path,
    ).map((authority) => ({
      symbol: authority.symbol,
      declaration: `export const ${authority.symbol} = true;`,
    })),
    ...FINDING_WRITER_SENSITIVE_READ_ONLY_EXPORTS.filter(
      (readOnlyExport) => readOnlyExport.target === path,
    ).map((readOnlyExport) => ({
      symbol: readOnlyExport.symbol,
      declaration:
        readOnlyExport.reexport === undefined
          ? `export const ${readOnlyExport.symbol} = true;`
          : `export { ${readOnlyExport.reexport.symbol}${
              readOnlyExport.reexport.symbol === readOnlyExport.symbol
                ? ''
                : ` as ${readOnlyExport.symbol}`
            } } from '${readOnlyExport.reexport.specifier}';`,
    })),
  ]
    .sort((left, right) => left.symbol.localeCompare(right.symbol))
    .map((runtimeExport) => runtimeExport.declaration);
  return [...imports, ...runtimeExports, body, ''].filter((line) => line.length > 0).join('\n');
}

export function writeFindingWriterSensitiveFixtureModule(
  root: string,
  path: string,
  body = '',
): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, renderFindingWriterSensitiveFixtureModule(path, body), 'utf8');
}

export function writeFindingWriterSensitiveAuthorityFixture(root: string): void {
  const paths = new Set<string>();
  for (const authority of FINDING_WRITER_SENSITIVE_IMPORT_AUTHORITY) {
    paths.add(authority.target);
    for (const importer of authority.importers) paths.add(importer);
  }
  for (const readOnlyExport of FINDING_WRITER_SENSITIVE_READ_ONLY_EXPORTS) {
    paths.add(readOnlyExport.target);
  }
  for (const path of [...paths].sort()) {
    writeFindingWriterSensitiveFixtureModule(root, path);
  }
  for (const authority of FINDING_WRITER_DYNAMIC_MODULE_LOADER_AUTHORITY) {
    const absolute = join(root, authority.path);
    mkdirSync(dirname(absolute), { recursive: true });
    const registryHandlers = authority.targetPolicy.registryHandlers;
    appendFileSync(
      absolute,
      [
        "import { createRequire, Module } from 'node:module';",
        'const repositoryRequire = createRequire(__filename);',
        `const REPOSITORY_APPLICATION_MODULE_EXTENSIONS = new Set([${registryHandlers
          .map((handler) => JSON.stringify(handler.extension))
          .join(', ')}]);`,
        `function ${authority.targetPolicy.guardFunction}(): { readonly descriptor: number } {`,
        '  return Object.freeze({ descriptor: 0 });',
        '}',
        'function currentCommonJsResolver(): unknown {',
        "  return Reflect.get(Module, '_resolveFilename');",
        '}',
        'function currentCommonJsLoader(): unknown {',
        "  return Reflect.get(Module, '_load');",
        '}',
        'function currentCommonJsExtensionRegistry(): unknown {',
        "  return Reflect.get(Module, '_extensions');",
        '}',
        'function currentCommonJsModuleCache(): unknown {',
        "  return Reflect.get(Module, '_cache');",
        '}',
        'function readCommonJsModuleCache(cache: object, targetPath: string): unknown {',
        '  return Reflect.get(cache, targetPath);',
        '}',
        'function writeCommonJsModuleCache(',
        '  cache: object,',
        '  targetPath: string,',
        '  loadedModule: NodeJS.Module,',
        '): void {',
        '  void Reflect.set(cache, targetPath, loadedModule);',
        '}',
        'function deleteCommonJsModuleCache(cache: object, targetPath: string): void {',
        '  void Reflect.deleteProperty(cache, targetPath);',
        '}',
        'function createCommonJsResolverProbe(): NodeJS.Module {',
        "  return new Module('repository-application-execution-resolver-probe');",
        '}',
        'function resolveRepositoryAliasCoordinate(',
        '  resolver: Function,',
        '  resolverProbe: NodeJS.Module,',
        '  request: string,',
        '): unknown {',
        '  return Reflect.apply(resolver, Module, [request, resolverProbe, false]);',
        '}',
        'function createRepositoryApplicationModule(identity: string): NodeJS.Module {',
        '  return new Module(identity);',
        '}',
        'function compileRepositoryApplicationCommonJs(loadedModule: NodeJS.Module): unknown {',
        "  return Reflect.get(loadedModule, '_compile');",
        '}',
        'function assertRepositoryApplicationExecutionRuntimeCurrent(',
        '  authority: {',
        '    readonly extensionRegistry: object;',
        ...registryHandlers.map(
          (handler) => `    readonly ${handler.handler}: (...args: unknown[]) => unknown;`,
        ),
        '  },',
        '): void {',
        '  if (',
        ...registryHandlers.flatMap((handler, index) => [
          `    Reflect.get(authority.extensionRegistry, ${JSON.stringify(handler.extension)}) !== authority.${handler.handler}${
            index === registryHandlers.length - 1 ? '' : ' ||'
          }`,
        ]),
        '  ) throw new Error("fixture handler currentness drifted");',
        '}',
        'function assertRepositoryApplicationExecutionRuntimeInactive(',
        '  authority: {',
        '    readonly extensionRegistry: object;',
        ...registryHandlers.map((handler) => `    readonly ${handler.previousHandler}: unknown;`),
        '  },',
        '): void {',
        '  if (',
        ...registryHandlers.flatMap((handler, index) => [
          `    Reflect.get(authority.extensionRegistry, ${JSON.stringify(handler.extension)}) !== authority.${handler.previousHandler}${
            index === registryHandlers.length - 1 ? '' : ' ||'
          }`,
        ]),
        '  ) throw new Error("fixture inactive handler currentness drifted");',
        '}',
        'function restoreRepositoryApplicationExecutionRuntime(authority: {',
        '  readonly extensionRegistry: object;',
        ...registryHandlers.flatMap((handler) => [
          `  readonly ${handler.handler}: (...args: unknown[]) => unknown;`,
          `  readonly ${handler.previousHandler}: unknown;`,
        ]),
        '  readonly loader: (...args: never[]) => unknown;',
        '  readonly previousLoader: (...args: never[]) => unknown;',
        '  readonly previousResolver: (...args: never[]) => unknown;',
        '  readonly resolver: (...args: never[]) => unknown;',
        '}): void {',
        "  if (currentCommonJsLoader() === authority.loader) Reflect.set(Module, '_load', authority.previousLoader);",
        "  else if (currentCommonJsLoader() !== authority.previousLoader) Reflect.set(Module, '_load', authority.previousLoader);",
        '  for (const [extension, installedHandler, previousHandler, label] of [',
        ...registryHandlers.map(
          (handler) =>
            `    [${JSON.stringify(handler.extension)}, authority.${handler.handler}, authority.${handler.previousHandler}, ${JSON.stringify(handler.label)}],`,
        ),
        '  ] as const) {',
        '    if (Reflect.get(authority.extensionRegistry, extension) === installedHandler) {',
        '      if (previousHandler === undefined) {',
        '        Reflect.deleteProperty(authority.extensionRegistry, extension);',
        '      } else {',
        '        Reflect.set(authority.extensionRegistry, extension, previousHandler);',
        '      }',
        '    } else if (Reflect.get(authority.extensionRegistry, extension) !== previousHandler) {',
        '      if (previousHandler === undefined) {',
        '        Reflect.deleteProperty(authority.extensionRegistry, extension);',
        '      } else {',
        '        Reflect.set(authority.extensionRegistry, extension, previousHandler);',
        '      }',
        '      void label;',
        '    }',
        '    if (Reflect.get(authority.extensionRegistry, extension) !== previousHandler) void 0;',
        '  }',
        "  if (currentCommonJsResolver() === authority.resolver) Reflect.set(Module, '_resolveFilename', authority.previousResolver);",
        "  else if (currentCommonJsResolver() !== authority.previousResolver) Reflect.set(Module, '_resolveFilename', authority.previousResolver);",
        '}',
        'function installRepositoryApplicationExecutionRuntime(authority: {',
        '  readonly extensionRegistry: object;',
        ...registryHandlers.map(
          (handler) => `  readonly ${handler.handler}: (...args: unknown[]) => unknown;`,
        ),
        '  readonly loader: (...args: never[]) => unknown;',
        '  readonly resolver: (...args: never[]) => unknown;',
        '}): void {',
        "  Reflect.set(Module, '_resolveFilename', authority.resolver);",
        ...registryHandlers.map(
          (handler) =>
            `  Reflect.set(authority.extensionRegistry, ${JSON.stringify(handler.extension)}, authority.${handler.handler});`,
        ),
        "  Reflect.set(Module, '_load', authority.loader);",
        '}',
        'function ensureRepositoryApplicationExecutionAuthority(): void {',
        "  void repositoryRequire.resolve('ts-node/package.json');",
        "  void repositoryRequire.resolve('tsconfig-paths/package.json');",
        "  void repositoryRequire('tsconfig-paths');",
        "  void repositoryRequire('ts-node');",
        '  const compileTypeScript = (): string => "";',
        '  const service = Object.freeze({});',
        ...registryHandlers.flatMap((handler) =>
          handler.handler === 'typescriptHandler'
            ? [
                `  const ${handler.handler} = (): unknown => {`,
                '    return Reflect.apply(compileTypeScript, service, []);',
                '  };',
              ]
            : [`  const ${handler.handler} = (): unknown => undefined;`],
        ),
        '  const extensionRegistry = Object.freeze({});',
        '  const moduleCache = Object.freeze({});',
        ...registryHandlers.map(
          (handler) =>
            `  const ${handler.previousHandler} = Reflect.get(extensionRegistry, ${JSON.stringify(handler.extension)});`,
        ),
        '  const previousLoader = currentCommonJsLoader();',
        '  const previousResolver = currentCommonJsResolver();',
        '  const resolverProbe = createCommonJsResolverProbe();',
        '  const installedResolver = (): unknown => undefined;',
        '  const governedLoader = function (',
        '    this: unknown,',
        '    request: unknown,',
        '    parent: unknown,',
        '    isMain: unknown,',
        '  ): unknown {',
        '    Reflect.apply(installedResolver, Module, [request, parent, isMain]);',
        '    return Reflect.apply(previousLoader, this, [request, parent, isMain]);',
        '  };',
        '  const registerPaths = (): unknown => undefined;',
        '  const pathPackage = Object.freeze({});',
        '  Reflect.apply(registerPaths, pathPackage, []);',
        '  const unregisterPathsValue = (): void => undefined;',
        '  Reflect.apply(unregisterPathsValue, undefined, []);',
        "  Reflect.set(Module, '_resolveFilename', previousResolver);",
        '  const authority = {',
        '    extensionRegistry,',
        ...registryHandlers.flatMap((handler) => [
          `    ${handler.handler},`,
          `    ${handler.previousHandler},`,
        ]),
        '    loader: governedLoader,',
        '    previousLoader,',
        '    previousResolver,',
        '    resolver: installedResolver,',
        '  };',
        '  assertRepositoryApplicationExecutionRuntimeCurrent(authority);',
        '  assertRepositoryApplicationExecutionRuntimeInactive(authority);',
        '  installRepositoryApplicationExecutionRuntime(authority);',
        '  restoreRepositoryApplicationExecutionRuntime(authority);',
        '  void moduleCache;',
        '  void resolverProbe;',
        '}',
        'function withFixtureEvaluationRoot<T>(action: () => T): T {',
        '  return action();',
        '}',
        `function ${authority.targetPolicy.enclosingFunction}(`,
        '  loadedModule: NodeJS.Module,',
        '  handlerCoordinate: string,',
        '  extensionHandler: { readonly handler: (target: NodeJS.Module, path: string) => unknown },',
        '): unknown {',
        "  const originalCompile = Reflect.get(loadedModule, '_compile');",
        "  Reflect.set(loadedModule, '_compile', compileWithCanonicalIdentity);",
        `  return withFixtureEvaluationRoot(() => ${authority.loaderBinding}(loadedModule, ${authority.argumentExpression}));`,
        '}',
        'function compileWithCanonicalIdentity(): void {}',
        `void ${authority.targetPolicy.guardFunction}();`,
        'void currentCommonJsResolver;',
        'void currentCommonJsLoader;',
        'void currentCommonJsExtensionRegistry;',
        'void REPOSITORY_APPLICATION_MODULE_EXTENSIONS;',
        'void currentCommonJsModuleCache;',
        'void readCommonJsModuleCache;',
        'void writeCommonJsModuleCache;',
        'void deleteCommonJsModuleCache;',
        'void createCommonJsResolverProbe;',
        'void resolveRepositoryAliasCoordinate;',
        'void createRepositoryApplicationModule;',
        'void compileRepositoryApplicationCommonJs;',
        'void assertRepositoryApplicationExecutionRuntimeCurrent;',
        'void assertRepositoryApplicationExecutionRuntimeInactive;',
        'void installRepositoryApplicationExecutionRuntime;',
        'void restoreRepositoryApplicationExecutionRuntime;',
        'void ensureRepositoryApplicationExecutionAuthority;',
        `void ${authority.targetPolicy.enclosingFunction};`,
        '',
      ].join('\n'),
      'utf8',
    );
  }
}
