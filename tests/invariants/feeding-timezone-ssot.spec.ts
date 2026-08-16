import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import ts from 'typescript';

import { FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1 } from '../../libs/shared-contracts/src/farm-durable-mutation-authority';
import {
  FEEDING_AGGREGATE_MUTATION_WRITER_AUTHORITY_ID,
  FEEDING_MUTATION_AUTHORITY_CATALOG_V1,
} from '../../libs/feeding-contracts/src/feeding-mutation-catalog';

const REPO_ROOT = resolve(__dirname, '..', '..');
const TIMEZONE_AUTHORITY = 'libs/feeding-contracts/src/feeding-timezone.ts';
const GOVERNED_ROOTS = [
  'libs/feeding-contracts/src',
  'apps/farm-feeding-scheduler/src',
  'apps/farm-service/src/feeding-protocol',
] as const;
const EXPECTED_RAW_TIMEZONE_ADMISSION_CONSUMERS = [
  'apps/farm-feeding-scheduler/src/feeding-operation-target-compiler.service.ts',
  'apps/farm-service/src/feeding-protocol/services/feeding-timezone-authority.service.ts',
  'libs/feeding-contracts/src/feeding-operation-intent.ts',
  'libs/feeding-contracts/src/feeding-scheduler-dispatch.ts',
] as const;
const EXPECTED_MUTATION_INSTANT_MINT_IMPORTERS = [
  'apps/farm-service/src/__tests__/support/feeding-protocol-test-authority.ts:import_named:@aquaculture/backend-common/database/mutation-instant-authority',
  'apps/farm-service/src/feeding-protocol/feeding-operation-session.ts:import_named:@aquaculture/backend-common/database/mutation-instant-authority',
  'libs/backend-common/src/database/mutation-instant-authority.ts:export_named:./mutation-instant',
] as const;
const MUTATION_INSTANT_KERNEL = 'libs/backend-common/src/database/mutation-instant.ts';
const MUTATION_INSTANT_EXPORT = 'mintMutationInstantV1';
const TENANT_MUTATION_SESSION_KERNEL =
  'libs/backend-common/src/database/tenant-mutation-session.ts';
const TENANT_MUTATION_INSTANT_PIN_EXPORT = 'pinTenantMutationInstantV1';
const EXPECTED_TENANT_MUTATION_INSTANT_PIN_IMPORTERS = [
  'apps/farm-service/src/feeding-protocol/feeding-operation-session.ts:import_named:@aquaculture/backend-common/database',
  'libs/backend-common/src/database/__tests__/tenant-transaction.spec.ts:import_named:../tenant-mutation-session',
  'libs/backend-common/src/database/index.ts:export_named:./tenant-mutation-session',
] as const;
const FEEDING_AGGREGATE_MUTATION_PORT =
  'apps/farm-service/src/feeding-protocol/feeding-aggregate-mutation.writer.ts';
const BATCH_AGGREGATE_MUTATION_PORT =
  'apps/farm-service/src/batch/batch-aggregate-mutation.port.ts';

function governedProductionFiles(): string[] {
  return execFileSync('rg', ['--files', ...GOVERNED_ROOTS, '-g', '*.ts', '-g', '!*.spec.ts'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean)
    .sort();
}

function typescriptFilesUnder(roots: readonly string[], excludeSpecs: boolean): string[] {
  const runtimeExtensions = [
    ts.Extension.Ts,
    ts.Extension.Tsx,
    ts.Extension.Mts,
    ts.Extension.Cts,
  ] as const;
  return execFileSync(
    'rg',
    [
      '--files',
      ...roots,
      ...runtimeExtensions.flatMap((extension) => ['-g', `*${extension}`]),
      '-g',
      '!*.d.ts',
      '-g',
      '!*.d.mts',
      '-g',
      '!*.d.cts',
      ...(excludeSpecs
        ? runtimeExtensions.flatMap((extension) => ['-g', `!*.spec${extension}`])
        : []),
    ],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  )
    .split('\n')
    .filter(Boolean)
    .sort();
}

interface ResolvedSourceGraph {
  readonly sources: readonly ts.SourceFile[];
  readonly byFile: ReadonlyMap<string, ts.SourceFile>;
  resolveModule(source: ts.SourceFile, specifier: string): string | undefined;
}

function createResolvedSourceGraph(
  files: readonly string[],
  options: ts.CompilerOptions,
): ResolvedSourceGraph {
  const sources = files.map((file) => {
    const absolute = resolve(file);
    return ts.createSourceFile(
      absolute,
      readFileSync(absolute, 'utf8'),
      ts.ScriptTarget.Latest,
      false,
      absolute.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
  });
  const byFile = new Map(sources.map((source) => [resolve(source.fileName), source]));
  const resolutions = new Map<string, string | null>();
  const runtimeExtensions = ['.ts', '.tsx', '.mts', '.cts'] as const;
  const resolveSourceCandidate = (base: string): string | undefined => {
    const normalized = resolve(base);
    const hasRuntimeExtension = runtimeExtensions.some((candidate) =>
      normalized.endsWith(candidate),
    );
    const withoutJavaScriptExtension = normalized.replace(/\.(?:mjs|cjs|js|jsx)$/u, '');
    const candidates = [
      normalized,
      ...(hasRuntimeExtension
        ? []
        : runtimeExtensions.map((candidate) => `${normalized}${candidate}`)),
      ...runtimeExtensions.map((candidate) => `${withoutJavaScriptExtension}${candidate}`),
      ...runtimeExtensions.map((candidate) => join(normalized, `index${candidate}`)),
    ];
    return candidates.find((candidate) => byFile.has(candidate));
  };
  const mappedBases = (specifier: string): string[] => {
    const baseUrl = options.baseUrl ?? REPO_ROOT;
    const mapped: string[] = [];
    for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
      const wildcardIndex = pattern.indexOf('*');
      if (wildcardIndex < 0) {
        if (pattern === specifier) {
          mapped.push(...targets.map((target) => resolve(baseUrl, target)));
        }
        continue;
      }
      const prefix = pattern.slice(0, wildcardIndex);
      const suffix = pattern.slice(wildcardIndex + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
      const wildcard = specifier.slice(prefix.length, specifier.length - suffix.length);
      mapped.push(...targets.map((target) => resolve(baseUrl, target.replace('*', wildcard))));
    }
    mapped.push(resolve(baseUrl, specifier));
    return mapped;
  };
  return {
    sources,
    byFile,
    resolveModule(source, specifier) {
      const key = `${source.fileName}\u0000${specifier}`;
      const cached = resolutions.get(key);
      if (cached !== undefined) return cached ?? undefined;
      const bases = specifier.startsWith('.')
        ? [resolve(source.fileName, '..', specifier)]
        : mappedBases(specifier);
      const internal = bases
        .map(resolveSourceCandidate)
        .find((candidate) => candidate !== undefined);
      resolutions.set(key, internal ?? null);
      return internal;
    },
  };
}

interface RepositorySourceEntry {
  readonly file: string;
  readonly text: string;
}

interface RepositorySourceCatalog {
  readonly entries: readonly RepositorySourceEntry[];
  readonly options: ts.CompilerOptions;
}

let repositoryCatalog: RepositorySourceCatalog | undefined;
const repositoryGraphs = new Map<string, ResolvedSourceGraph>();

function scanSourceEntry(file: string): RepositorySourceEntry {
  return { file, text: readFileSync(file, 'utf8') };
}

function repositorySourceCatalog(): RepositorySourceCatalog {
  if (repositoryCatalog) return repositoryCatalog;
  const config = ts.readConfigFile(join(REPO_ROOT, 'tsconfig.base.json'), ts.sys.readFile);
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, REPO_ROOT).options;
  const files = typescriptFilesUnder(
    ['apps', 'libs', 'platform', 'web', 'tests', 'tools', 'scripts', 'agents', 'mcp'],
    false,
  ).map((file) => join(REPO_ROOT, file));
  repositoryCatalog = { entries: files.map(scanSourceEntry), options };
  return repositoryCatalog;
}

function repositoryAuthorityGraph(targetFile: string, exportName: string): ResolvedSourceGraph {
  const target = resolve(targetFile);
  const cacheKey = `${target}:${exportName}`;
  const cached = repositoryGraphs.get(cacheKey);
  if (cached) return cached;
  const catalog = repositorySourceCatalog();
  const names = new Set([exportName]);
  const targetStem = basename(target).replace(/\.(?:mts|cts|tsx|ts)$/u, '');
  const selected = new Set<string>([target]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of catalog.entries) {
      if (
        !selected.has(entry.file) &&
        (entry.text.includes(targetStem) || [...names].some((name) => entry.text.includes(name)))
      ) {
        selected.add(entry.file);
        changed = true;
      }
    }
    const graph = createResolvedSourceGraph([...selected], catalog.options);
    for (const source of graph.sources) {
      for (const statement of source.statements) {
        if (!ts.isExportDeclaration(statement) || statement.isTypeOnly || !statement.exportClause) {
          continue;
        }
        if (ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            const importedName = element.propertyName?.text ?? element.name.text;
            if (!element.isTypeOnly && names.has(importedName) && !names.has(element.name.text)) {
              names.add(element.name.text);
              changed = true;
            }
          }
        }
      }
    }
  }
  const graph = createResolvedSourceGraph([...selected], catalog.options);
  repositoryGraphs.set(cacheKey, graph);
  return graph;
}

type RuntimeSymbolEdgeKind =
  | 'import_named'
  | 'import_namespace'
  | 'import_equals'
  | 'import_dynamic'
  | 'require'
  | 'create_require'
  | 'module_require'
  | 'export_named'
  | 'export_namespace'
  | 'export_star'
  | 'export_equals';

interface RuntimeSymbolEdge {
  readonly file: string;
  readonly kind: RuntimeSymbolEdgeKind;
  readonly specifier: string;
}

function canonicalPath(path: string): string {
  return relative(REPO_ROOT, resolve(path)).replaceAll('\\', '/');
}

interface ModuleLoaderAuthority {
  readonly createRequireFactories: ReadonlySet<string>;
  readonly moduleNamespaces: ReadonlySet<string>;
  readonly createdRequireFunctions: ReadonlySet<string>;
}

interface ModuleLoaderCall {
  readonly kind: Extract<
    RuntimeSymbolEdgeKind,
    'import_dynamic' | 'require' | 'create_require' | 'module_require'
  >;
  readonly specifier: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral;
}

function literalModuleSpecifier(
  node: ts.Expression | undefined,
): ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node
    : undefined;
}

function moduleLoaderAuthority(source: ts.SourceFile): ModuleLoaderAuthority {
  const createRequireFactories = new Set<string>();
  const moduleNamespaces = new Set<string>();
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !['node:module', 'module'].includes(statement.moduleSpecifier.text)
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        if ((element.propertyName?.text ?? element.name.text) === 'createRequire') {
          createRequireFactories.add(element.name.text);
        }
      }
    } else if (bindings && ts.isNamespaceImport(bindings)) {
      moduleNamespaces.add(bindings.name.text);
    }
  }

  const isFactoryCall = (call: ts.CallExpression): boolean => {
    if (ts.isIdentifier(call.expression)) {
      return createRequireFactories.has(call.expression.text);
    }
    return (
      ts.isPropertyAccessExpression(call.expression) &&
      call.expression.name.text === 'createRequire' &&
      ts.isIdentifier(call.expression.expression) &&
      (moduleNamespaces.has(call.expression.expression.text) ||
        call.expression.expression.text === 'module')
    );
  };
  const createdRequireFunctions = new Set<string>();
  walk(source, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      isFactoryCall(node.initializer)
    ) {
      createdRequireFunctions.add(node.name.text);
    }
  });
  return { createRequireFactories, moduleNamespaces, createdRequireFunctions };
}

function moduleLoaderCall(
  call: ts.CallExpression,
  authority: ModuleLoaderAuthority,
): ModuleLoaderCall | undefined {
  const kind = moduleLoaderKind(call, authority);
  const specifier = literalModuleSpecifier(call.arguments[0]);
  return kind && specifier ? { kind, specifier } : undefined;
}

function moduleLoaderKind(
  call: ts.CallExpression,
  authority: ModuleLoaderAuthority,
): ModuleLoaderCall['kind'] | undefined {
  if (call.expression.kind === ts.SyntaxKind.ImportKeyword) {
    return 'import_dynamic';
  }
  if (ts.isIdentifier(call.expression) && call.expression.text === 'require') {
    return 'require';
  }
  if (
    ts.isPropertyAccessExpression(call.expression) &&
    ts.isIdentifier(call.expression.expression) &&
    call.expression.expression.text === 'module' &&
    call.expression.name.text === 'require'
  ) {
    return 'module_require';
  }
  if (
    ts.isIdentifier(call.expression) &&
    authority.createdRequireFunctions.has(call.expression.text)
  ) {
    return 'create_require';
  }
  if (ts.isCallExpression(call.expression)) {
    const factory = call.expression.expression;
    if (
      (ts.isIdentifier(factory) && authority.createRequireFactories.has(factory.text)) ||
      (ts.isPropertyAccessExpression(factory) &&
        factory.name.text === 'createRequire' &&
        ts.isIdentifier(factory.expression) &&
        (authority.moduleNamespaces.has(factory.expression.text) ||
          factory.expression.text === 'module'))
    ) {
      return 'create_require';
    }
  }
  return undefined;
}

/**
 * Reverse-import census for one runtime export. Module coordinates are resolved
 * with the committed TypeScript config, then named/star/namespace re-exports
 * are propagated to a fixed point. Aliases and intermediary barrels therefore
 * converge on the same target declaration without a regex/string authority.
 */
function runtimeSymbolEdges(
  graph: ResolvedSourceGraph,
  targetFile: string,
  exportName: string,
): RuntimeSymbolEdge[] {
  const target = resolve(targetFile);
  const targetSource = graph.byFile.get(target);
  if (!targetSource) throw new Error(`Runtime symbol target is absent: ${canonicalPath(target)}`);
  const declaresRuntimeExport = targetSource.statements.some((statement) => {
    const exported = (
      ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined
    )?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (!exported) return false;
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isEnumDeclaration(statement)) &&
      statement.name?.text === exportName
    ) {
      return true;
    }
    return (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === exportName,
      )
    );
  });
  if (!declaresRuntimeExport) {
    throw new Error(`Runtime symbol target has no direct export ${exportName}`);
  }

  const exposures = new Map<string, Set<string>>(
    graph.sources.map((source) => [resolve(source.fileName), new Set<string>()]),
  );
  const loaderAuthorities = new Map(
    graph.sources.map((source) => [resolve(source.fileName), moduleLoaderAuthority(source)]),
  );
  const exposedNames = new Set([exportName]);
  exposures.get(target)?.add(exportName);
  let changed = true;
  while (changed) {
    changed = false;
    for (const source of graph.sources) {
      const sourceExports = exposures.get(resolve(source.fileName));
      if (!sourceExports) continue;
      for (const statement of source.statements) {
        const add = (name: string): void => {
          if (!sourceExports.has(name)) {
            sourceExports.add(name);
            exposedNames.add(name);
            changed = true;
          }
        };
        if (ts.isExportAssignment(statement) && statement.isExportEquals) {
          if (ts.isCallExpression(statement.expression)) {
            const loader = moduleLoaderCall(
              statement.expression,
              loaderAuthorities.get(resolve(source.fileName)) ?? moduleLoaderAuthority(source),
            );
            const destination = loader
              ? graph.resolveModule(source, loader.specifier.text)
              : undefined;
            if (destination && (exposures.get(destination)?.size ?? 0) > 0) {
              add('default');
              add('export=');
            }
          }
          continue;
        }
        if (
          !ts.isExportDeclaration(statement) ||
          statement.isTypeOnly ||
          !statement.moduleSpecifier ||
          !ts.isStringLiteral(statement.moduleSpecifier)
        ) {
          continue;
        }
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          const couldExposeTarget = statement.exportClause.elements.some(
            (element) =>
              !element.isTypeOnly &&
              exposedNames.has(element.propertyName?.text ?? element.name.text),
          );
          if (!couldExposeTarget) continue;
        }
        const destination = graph.resolveModule(source, statement.moduleSpecifier.text);
        const destinationExports = destination ? exposures.get(destination) : undefined;
        if (!destinationExports || destinationExports.size === 0) continue;
        if (!statement.exportClause) {
          for (const name of destinationExports) if (name !== 'default') add(name);
        } else if (ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            if (element.isTypeOnly) continue;
            const importedName = element.propertyName?.text ?? element.name.text;
            if (destinationExports.has(importedName)) add(element.name.text);
          }
        } else if (ts.isNamespaceExport(statement.exportClause)) {
          add(statement.exportClause.name.text);
        }
      }
    }
  }

  const edges: RuntimeSymbolEdge[] = [];
  const record = (
    source: ts.SourceFile,
    kind: RuntimeSymbolEdgeKind,
    specifier: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral,
  ): void => {
    edges.push({ file: canonicalPath(source.fileName), kind, specifier: specifier.text });
  };

  for (const source of graph.sources) {
    if (source.isDeclarationFile) continue;
    for (const statement of source.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        if (statement.importClause?.isTypeOnly) continue;
        const bindings = statement.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
          const couldImportTarget = bindings.elements.some(
            (element) =>
              !element.isTypeOnly &&
              exposedNames.has(element.propertyName?.text ?? element.name.text),
          );
          if (!couldImportTarget && !statement.importClause?.name) continue;
        } else if (!bindings && !statement.importClause?.name) {
          continue;
        }
        const destination = graph.resolveModule(source, statement.moduleSpecifier.text);
        const destinationExports = destination ? exposures.get(destination) : undefined;
        if (!destinationExports || destinationExports.size === 0) continue;
        if (bindings && ts.isNamedImports(bindings)) {
          for (const element of bindings.elements) {
            const importedName = element.propertyName?.text ?? element.name.text;
            if (!element.isTypeOnly && destinationExports.has(importedName))
              record(source, 'import_named', statement.moduleSpecifier);
          }
        } else if (bindings && ts.isNamespaceImport(bindings)) {
          record(source, 'import_namespace', statement.moduleSpecifier);
        }
        if (statement.importClause?.name && destinationExports.has('default')) {
          record(source, 'import_named', statement.moduleSpecifier);
        }
      }
      if (
        ts.isImportEqualsDeclaration(statement) &&
        ts.isExternalModuleReference(statement.moduleReference) &&
        statement.moduleReference.expression &&
        ts.isStringLiteral(statement.moduleReference.expression)
      ) {
        const destination = graph.resolveModule(source, statement.moduleReference.expression.text);
        if (destination && (exposures.get(destination)?.size ?? 0) > 0) {
          record(source, 'import_equals', statement.moduleReference.expression);
        }
      }
      if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        if (statement.isTypeOnly) continue;
        if (
          statement.exportClause &&
          ts.isNamedExports(statement.exportClause) &&
          !statement.exportClause.elements.some(
            (element) =>
              !element.isTypeOnly &&
              exposedNames.has(element.propertyName?.text ?? element.name.text),
          )
        ) {
          continue;
        }
        const destination = graph.resolveModule(source, statement.moduleSpecifier.text);
        const destinationExports = destination ? exposures.get(destination) : undefined;
        if (!destinationExports || destinationExports.size === 0) continue;
        if (!statement.exportClause) {
          record(source, 'export_star', statement.moduleSpecifier);
        } else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) {
            const importedName = element.propertyName?.text ?? element.name.text;
            if (!element.isTypeOnly && destinationExports.has(importedName))
              record(source, 'export_named', statement.moduleSpecifier);
          }
        } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
          record(source, 'export_namespace', statement.moduleSpecifier);
        }
      }
      if (ts.isExportAssignment(statement) && statement.isExportEquals) {
        const loader = ts.isCallExpression(statement.expression)
          ? moduleLoaderCall(
              statement.expression,
              loaderAuthorities.get(resolve(source.fileName)) ?? moduleLoaderAuthority(source),
            )
          : undefined;
        if (loader) {
          const destination = graph.resolveModule(source, loader.specifier.text);
          if (destination && (exposures.get(destination)?.size ?? 0) > 0) {
            record(source, 'export_equals', loader.specifier);
          }
        }
      }
    }
    const loaderAuthority =
      loaderAuthorities.get(resolve(source.fileName)) ?? moduleLoaderAuthority(source);
    walk(source, (node) => {
      if (!ts.isCallExpression(node)) return;
      const loaderKind = moduleLoaderKind(node, loaderAuthority);
      if (!loaderKind) return;
      const loader = moduleLoaderCall(node, loaderAuthority);
      if (!loader) {
        throw new Error(
          `${canonicalPath(source.fileName)}:${loaderKind} has a non-literal module coordinate`,
        );
      }
      const destination = graph.resolveModule(source, loader.specifier.text);
      if (destination && (exposures.get(destination)?.size ?? 0) > 0) {
        record(source, loader.kind, loader.specifier);
      }
    });
  }
  return edges.sort((left, right) =>
    `${left.file}:${left.kind}:${left.specifier}`.localeCompare(
      `${right.file}:${right.kind}:${right.specifier}`,
    ),
  );
}

let fixtureEdges: RuntimeSymbolEdge[] | undefined;

function fixtureRuntimeSymbolEdges(): RuntimeSymbolEdge[] {
  if (fixtureEdges) return fixtureEdges;
  const root = mkdtempSync(join(tmpdir(), 'mutation-instant-census-'));
  try {
    const kernel = join(root, 'kernel.ts');
    writeFileSync(kernel, 'export function mintMutationInstantV1(): void {}\n');
    const fixtures = {
      'direct.ts': `import { mintMutationInstantV1 } from './kernel';\nvoid mintMutationInstantV1;`,
      'tsx-importer.tsx': `import * as Kernel from './kernel';\nexport const view = <div>{String(Kernel.mintMutationInstantV1)}</div>;`,
      'namespace.ts': `import * as Kernel from './kernel';\nvoid Kernel.mintMutationInstantV1;`,
      'import-equals.ts': `import Kernel = require('./kernel');\nvoid Kernel.mintMutationInstantV1;`,
      'dynamic.ts': `void import('./kernel');`,
      'require.ts': `void require('./kernel');`,
      'create-require.ts': `import { createRequire as makeRequire } from 'node:module';\nconst scopedRequire = makeRequire(import.meta.url);\nvoid scopedRequire('./kernel');`,
      'module-require.ts': `void module.require('./kernel');`,
      'named-re-export.ts': `export { mintMutationInstantV1 } from './kernel';`,
      'namespace-re-export.ts': `export * as Kernel from './kernel';`,
      'star-re-export.ts': `export * from './kernel';`,
      'export-equals.ts': `export = require('./kernel');`,
      'alias-barrel.ts': `export { mintMutationInstantV1 as issueMutationInstant } from './kernel';`,
      'alias-star-barrel.ts': `export * from './alias-barrel';`,
      'alias-consumer.ts': `import { issueMutationInstant as finalMint } from './alias-star-barrel';\nvoid finalMint;`,
    } as const;
    const files = [kernel];
    for (const [name, source] of Object.entries(fixtures)) {
      const file = join(root, name);
      writeFileSync(file, source);
      files.push(file);
    }
    const options = {
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2020,
    };
    fixtureEdges = runtimeSymbolEdges(
      createResolvedSourceGraph(files, options),
      kernel,
      MUTATION_INSTANT_EXPORT,
    );
    return fixtureEdges;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function fixtureUnresolvedLoaderError(): string {
  const root = mkdtempSync(join(tmpdir(), 'mutation-instant-unresolved-loader-'));
  try {
    const kernel = join(root, 'kernel.ts');
    const consumer = join(root, 'consumer.ts');
    writeFileSync(kernel, 'export function mintMutationInstantV1(): void {}\n');
    writeFileSync(consumer, `const target = './kernel';\nvoid import(target);\n`);
    const graph = createResolvedSourceGraph([kernel, consumer], {
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      target: ts.ScriptTarget.ES2020,
    });
    try {
      runtimeSymbolEdges(graph, kernel, MUTATION_INSTANT_EXPORT);
      return '';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function catalogMutationClockFiles(): string[] {
  const activeFarmMutations = FEEDING_MUTATION_AUTHORITY_CATALOG_V1.filter(
    (mutation) => mutation.lifecycle === 'active' && mutation.runtimeServiceId === 'farm-service',
  );
  const catalogWriters = new Set(
    activeFarmMutations.flatMap((mutation) => mutation.durableSinks.map((sink) => sink.writer)),
  );
  const requiredWriterPorts = [
    {
      writer: FEEDING_AGGREGATE_MUTATION_WRITER_AUTHORITY_ID,
      file: FEEDING_AGGREGATE_MUTATION_PORT,
      symbol: 'FeedingAggregateMutationPort',
    },
    {
      writer: FARM_DURABLE_MUTATION_AUTHORITY_IDS_V1.BATCH_AGGREGATE,
      file: BATCH_AGGREGATE_MUTATION_PORT,
      symbol: 'BatchAggregateMutationPort',
    },
  ] as const;
  const governed = new Set<string>();
  for (const port of requiredWriterPorts) {
    if (!catalogWriters.has(port.writer)) continue;
    const portFile = join(REPO_ROOT, port.file);
    const graph = repositoryAuthorityGraph(portFile, port.symbol);
    for (const edge of runtimeSymbolEdges(graph, portFile, port.symbol)) {
      if (
        (edge.file.startsWith('apps/farm-service/src/feeding/') ||
          edge.file.startsWith('apps/farm-service/src/feeding-protocol/')) &&
        !edge.file.includes('/__tests__/') &&
        !edge.file.endsWith('.spec.ts')
      ) {
        governed.add(edge.file);
      }
    }
  }

  const requiredCatalogOwnerSymbols = new Set(
    activeFarmMutations.flatMap((mutation) => [
      ...(mutation.commandHandler === null ? [] : [mutation.commandHandler]),
      mutation.transaction.provider,
      mutation.dispatchOwner.split('.')[0] ?? mutation.dispatchOwner,
    ]),
  );
  const resolvedRequiredOwners = new Set<string>();
  const catalog = repositorySourceCatalog();
  const ownerGraph = createResolvedSourceGraph(
    typescriptFilesUnder(
      ['apps/farm-service/src/feeding', 'apps/farm-service/src/feeding-protocol'],
      true,
    ).map((file) => join(REPO_ROOT, file)),
    catalog.options,
  );
  for (const source of ownerGraph.sources) {
    const path = canonicalPath(source.fileName);
    if (
      (!path.startsWith('apps/farm-service/src/feeding/') &&
        !path.startsWith('apps/farm-service/src/feeding-protocol/')) ||
      path.includes('/__tests__/') ||
      path.endsWith('.spec.ts')
    ) {
      continue;
    }
    let ownsCatalogMutation = false;
    for (const statement of source.statements) {
      const symbolName =
        (ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isFunctionDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)) &&
        statement.name
          ? statement.name.text
          : undefined;
      if (!symbolName) continue;
      if (requiredCatalogOwnerSymbols.has(symbolName)) {
        resolvedRequiredOwners.add(symbolName);
        ownsCatalogMutation = true;
      }
    }
    if (ownsCatalogMutation) {
      governed.add(path);
    }
  }
  const unresolvedOwners = [...requiredCatalogOwnerSymbols].filter(
    (owner) => !resolvedRequiredOwners.has(owner),
  );
  if (unresolvedOwners.length > 0) {
    throw new Error(`Catalog mutation clock owners are unresolved: ${unresolvedOwners.join(', ')}`);
  }
  return [...governed].sort();
}

function sourceFile(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(join(REPO_ROOT, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

describe('feeding timezone and clock authority', () => {
  it('keeps Intl and timezone admission behind one typed SSOT', () => {
    const rawIntlConsumers = new Set<string>();
    const rawAdmissionConsumers = new Set<string>();
    const processTimezoneConsumers = new Set<string>();

    for (const path of governedProductionFiles()) {
      walk(sourceFile(path), (node) => {
        if (
          (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.getText() === 'Intl' &&
          node.expression.name.text === 'DateTimeFormat'
        ) {
          rawIntlConsumers.add(path);
        }
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'compileFeedingTimezone' &&
          path !== TIMEZONE_AUTHORITY
        ) {
          rawAdmissionConsumers.add(path);
        }
        if (
          ts.isPropertyAccessExpression(node) &&
          node.name.text === 'TZ' &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.expression.getText() === 'process' &&
          node.expression.name.text === 'env'
        ) {
          processTimezoneConsumers.add(path);
        }
      });
    }

    expect([...rawIntlConsumers]).toEqual([TIMEZONE_AUTHORITY]);
    expect([...rawAdmissionConsumers].sort()).toEqual(
      [...EXPECTED_RAW_TIMEZONE_ADMISSION_CONSUMERS].sort(),
    );
    expect([...processTimezoneConsumers]).toEqual([]);
  });

  it('forbids duplicate feeding calendar helper authorities', () => {
    const forbiddenDeclarations = new Set(['calendarDayIn', 'zonedWallTimeToUtc']);
    const violations: string[] = [];
    for (const path of governedProductionFiles()) {
      walk(sourceFile(path), (node) => {
        if (
          (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) &&
          node.name &&
          ts.isIdentifier(node.name) &&
          forbiddenDeclarations.has(node.name.text)
        ) {
          violations.push(`${path}:${node.name.text}`);
        }
      });
    }
    expect(violations).toEqual([]);
  });

  it('creates scheduler cuts through the explicit clock port', () => {
    const ingressPath = 'apps/farm-feeding-scheduler/src/feeding-schedule-ingress.service.ts';
    const calls: string[] = [];
    walk(sourceFile(ingressPath), (node) => {
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'Date' &&
        (node.arguments?.length ?? 0) === 0
      ) {
        calls.push(node.getText());
      }
    });
    const source = readFileSync(join(REPO_ROOT, ingressPath), 'utf8');
    expect(calls).toEqual([]);
    expect(source).toContain('@Inject(FEEDING_CLOCK_PORT)');
    expect(source).toContain('this.clock.now()');
  });

  it('keeps mutation-instant minting behind the exact resolved-symbol authority graph', () => {
    const importers = runtimeSymbolEdges(
      repositoryAuthorityGraph(join(REPO_ROOT, MUTATION_INSTANT_KERNEL), MUTATION_INSTANT_EXPORT),
      join(REPO_ROOT, MUTATION_INSTANT_KERNEL),
      MUTATION_INSTANT_EXPORT,
    ).map((edge) => `${edge.file}:${edge.kind}:${edge.specifier}`);

    expect(importers).toEqual([...EXPECTED_MUTATION_INSTANT_MINT_IMPORTERS].sort());
  });

  it('keeps persisted-operation clock pinning behind one exact coordinator authority graph', () => {
    const importers = runtimeSymbolEdges(
      repositoryAuthorityGraph(
        join(REPO_ROOT, TENANT_MUTATION_SESSION_KERNEL),
        TENANT_MUTATION_INSTANT_PIN_EXPORT,
      ),
      join(REPO_ROOT, TENANT_MUTATION_SESSION_KERNEL),
      TENANT_MUTATION_INSTANT_PIN_EXPORT,
    ).map((edge) => `${edge.file}:${edge.kind}:${edge.specifier}`);

    expect(importers).toEqual([...EXPECTED_TENANT_MUTATION_INSTANT_PIN_IMPORTERS].sort());
  });

  it.each([
    ['direct relative import', 'direct.ts', 'import_named'],
    ['TSX namespace import', 'tsx-importer.tsx', 'import_namespace'],
    ['namespace import', 'namespace.ts', 'import_namespace'],
    ['ImportEquals', 'import-equals.ts', 'import_equals'],
    ['dynamic import()', 'dynamic.ts', 'import_dynamic'],
    ['CommonJS require', 'require.ts', 'require'],
    ['createRequire alias', 'create-require.ts', 'create_require'],
    ['module.require', 'module-require.ts', 'module_require'],
    ['named re-export', 'named-re-export.ts', 'export_named'],
    ['namespace re-export', 'namespace-re-export.ts', 'export_namespace'],
    ['star re-export', 'star-re-export.ts', 'export_star'],
    ['export equals', 'export-equals.ts', 'export_equals'],
  ] as const)(
    'detects mutation-instant mint authority evasion through %s',
    (_label, file, kind) => {
      expect(
        fixtureRuntimeSymbolEdges().filter((edge) => basename(edge.file) === file),
      ).toContainEqual({ file: expect.stringContaining(file), kind, specifier: './kernel' });
    },
  );

  it('follows an aliased re-export chain through its final runtime consumer', () => {
    const edges = fixtureRuntimeSymbolEdges();
    expect(
      edges
        .filter((edge) => basename(edge.file).startsWith('alias-'))
        .map((edge) => `${basename(edge.file)}:${edge.kind}:${edge.specifier}`),
    ).toEqual([
      'alias-barrel.ts:export_named:./kernel',
      'alias-consumer.ts:import_named:./alias-star-barrel',
      'alias-star-barrel.ts:export_star:./alias-barrel',
    ]);
  });

  it('rejects a non-literal loader coordinate instead of assuming it cannot reach the mint', () => {
    expect(fixtureUnresolvedLoaderError()).toContain(
      'consumer.ts:import_dynamic has a non-literal module coordinate',
    );
  });

  it('forbids process-clock fallbacks in operation-owned mutation code', () => {
    const violations: string[] = [];
    for (const path of catalogMutationClockFiles()) {
      walk(sourceFile(path), (node) => {
        if (
          ts.isNewExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'Date' &&
          (node.arguments?.length ?? 0) === 0
        ) {
          violations.push(`${path}:new Date()`);
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === 'Date' &&
          node.expression.name.text === 'now'
        ) {
          violations.push(`${path}:Date.now()`);
        }
      });
    }
    expect(violations).toEqual([]);
  });
});
