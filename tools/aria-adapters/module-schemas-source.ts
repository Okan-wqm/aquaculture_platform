import { posix } from 'node:path';

import ts from 'typescript';

import {
  applicationNames,
  SourceTreeUnavailable,
  type TrackedTree,
  trackedTree,
} from '../gates/event-consumer-index';

import {
  containedWorkspace,
  isWorkspaceRelativePath,
  normalizeWorkspacePath,
  type ContainedWorkspace,
} from './adapter-fs';

/**
 * ARIA-MEDIUM-588 — the one adapter-side reader of `MODULE_SCHEMAS`.
 *
 * `MODULE_SCHEMAS` (libs/backend-common/src/database/schema-manager.service.ts)
 * is the single source of truth for each module's per-tenant tables, reference
 * data tables and cross-tenant infrastructure tables. The RUNTIME value spreads
 * an imported constant into every module entry
 * (`...TENANT_ERASURE_PROOF_INFRASTRUCTURE_TABLES`, whose element
 * `TENANT_ERASURE_TARGET_PROOF_LEDGER_TABLE` itself arrives from
 * `@platform/outbox` through the tsconfig path map). Adapters must observe the
 * workspace under analysis — fixtures included — so they cannot `import` the
 * declaration and execute it; they read it as source text. The previous
 * text reader kept only string-literal array elements, so every spread entry
 * was silently dropped: `tenant_erasure_target_proofs` disappeared from the
 * adapter-side registry while the runtime kept treating it as infrastructure,
 * and every adapter consumer (the entity-schema ownership policy, the
 * module_schema declared-table diff, and any projection of the tenant-aware
 * qualified-DDL guard) silently disagreed with the runtime verdicts.
 *
 * This reader resolves what the declaration actually says:
 *   - string literals, wherever they sit;
 *   - `...IDENT` spreads of identifiers bound to `[…] as const` array literals
 *     in the same file;
 *   - identifiers bound to string constants, in the same file or imported from
 *     a workspace module — resolved through the workspace's own
 *     `tsconfig.base.json` path map (so `@platform/outbox` resolves exactly as
 *     the compiler resolves it), following named and star re-exports.
 *
 * An element it cannot resolve is returned as a NAMED parse error, never
 * dropped: a registry that is silently partial is the defect this module
 * exists to remove. All file access goes through `containedWorkspace`
 * (adapter-fs), so a symlinked import target is refused, never followed.
 *
 * The same reading carries `TENANT_SCOPED_MODULES` (formerly a second parser in
 * typeorm-entity-schema-adapter.ts, which dropped a non-literal element).
 *
 * `--facts --repo-root <tree>` (`moduleFacts`) is the module entry of the
 * code-fact bridge (service-expertise PLAN §3.2, SE-3; SO-19): per service, its
 * schema and table placement, joined to the owning service by SCHEMA_REGISTRY
 * (apps/db-migrate/src/schema-registry.ts, read as source text too). Each owner
 * is keyed by the SE-1 service key, read by the event entry's one reader
 * (`applicationNames`, tools/gates/event-consumer-index.ts), so both entries
 * name a service the same way; that reader enumerates the tree's tracked files
 * and refuses a symlinked project.json, so the module entry keeps its
 * containment. The same tracked set (`trackedTree`) is the entry's read
 * policy: the registries and every module their imports reach must be
 * tracked regular files, so an ignored or untracked module never becomes
 * placement facts. The kernel runs it on a diff's base tree
 * (`K/plan_coverage.py` `compute_service_facts`); registries it cannot read
 * completely, whose ownership is ambiguous, or whose applications cannot be
 * read (SourceTreeUnavailable), exit 2 with nothing on stdout.
 */
export const MODULE_SCHEMAS_SOURCE_PATH =
  'libs/backend-common/src/database/schema-manager.service.ts';

/** Where the workspace's TypeScript path aliases live (`@platform/*`…). */
export const TSCONFIG_BASE_PATH = 'tsconfig.base.json';

/** One module entry of the adapter-side MODULE_SCHEMAS reading. */
export interface ModuleSchemaSourceRecord {
  readonly moduleName: string;
  readonly sourceSchema: string;
  readonly strictOwnership: boolean;
  readonly tables: readonly string[];
  readonly referenceDataTables: readonly string[];
  readonly infrastructureTables: readonly string[];
  readonly path: string;
  readonly line: number;
}

/** A named resolution failure. The element is reported, never dropped. */
export interface ModuleSchemaSourceError {
  readonly message: string;
  readonly path: string;
  readonly line: number;
}

export interface ModuleSchemasSource {
  /** The SSoT file the registry was read from (workspace-relative). */
  readonly path: string;
  readonly modules: readonly ModuleSchemaSourceRecord[];
  /**
   * TENANT_SCOPED_MODULES from the same file: the modules whose `tables` are cloned into every
   * `tenant_<uuid>` schema (ADR-011). Null when the declaration is absent, so callers fail closed.
   */
  readonly tenantScopedModules: ReadonlySet<string> | null;
  readonly errors: readonly ModuleSchemaSourceError[];
  /**
   * Every workspace file the reading touched, workspace-relative and sorted:
   * the SSoT, the tsconfig the path map came from, and each module file an
   * imported constant was resolved through. Adapters surface this as their
   * `read_paths` so the observation names what its verdicts came from.
   */
  readonly readPaths: readonly string[];
}

interface TsconfigPaths {
  readonly baseUrl: string;
  readonly paths: ReadonlyMap<string, readonly string[]>;
}

const MAX_RESOLUTION_HOPS = 16;
const MODULE_EXTENSIONS = ['.ts', '.tsx', '.js', '/index.ts', '/index.js'] as const;

class Resolver {
  private readonly sourceCache = new Map<string, ts.SourceFile | null>();
  private readonly tsconfigPaths: TsconfigPaths | null;
  private readonly readPaths = new Set<string>();

  constructor(
    private readonly workspace: ContainedWorkspace,
    private readonly errors: ModuleSchemaSourceError[],
    private readonly pathAllowed: (path: string) => boolean,
  ) {
    this.tsconfigPaths = this.readTsconfigPaths();
  }

  /** The path map from the workspace's tsconfig.base.json, or null. */
  private readTsconfigPaths(): TsconfigPaths | null {
    if (
      this.workspace.entry(TSCONFIG_BASE_PATH) !== 'file' ||
      !this.pathAllowed(TSCONFIG_BASE_PATH)
    ) {
      return null;
    }
    let config: ts.JsonSourceFile;
    try {
      const text = this.workspace.readFile(TSCONFIG_BASE_PATH);
      this.readPaths.add(TSCONFIG_BASE_PATH);
      config = ts.parseJsonText(TSCONFIG_BASE_PATH, text);
    } catch {
      return null;
    }
    // Walk the JSON AST for `compilerOptions.paths` / `compilerOptions.baseUrl`
    // directly: the compiler's config parser normalises `baseUrl` against the
    // process cwd and wants a filesystem host, while the reader needs the map
    // exactly as written (workspace-relative), from the workspace's own file.
    let paths: ReadonlyMap<string, readonly string[]> | null = null;
    let baseUrl = '.';
    const root = jsonRootObject(config);
    const compilerOptions = root === null ? null : jsonObjectProperty(root, 'compilerOptions');
    if (compilerOptions !== null && ts.isObjectLiteralExpression(compilerOptions)) {
      const rawBaseUrl = jsonObjectProperty(compilerOptions, 'baseUrl');
      if (rawBaseUrl !== null && ts.isStringLiteralLike(rawBaseUrl)) {
        baseUrl = rawBaseUrl.text;
      }
      const rawPaths = jsonObjectProperty(compilerOptions, 'paths');
      if (rawPaths !== null && ts.isObjectLiteralExpression(rawPaths)) {
        const map = new Map<string, readonly string[]>();
        for (const property of rawPaths.properties) {
          if (
            !ts.isPropertyAssignment(property) ||
            !ts.isStringLiteralLike(property.name) ||
            !ts.isArrayLiteralExpression(property.initializer)
          ) {
            continue;
          }
          const targets = property.initializer.elements.filter(
            (element): element is ts.StringLiteralLike => ts.isStringLiteralLike(element),
          );
          if (targets.length > 0) {
            map.set(
              property.name.text,
              targets.map((element) => element.text),
            );
          }
        }
        paths = map;
      }
    }
    if (paths === null) {
      return null;
    }
    return { baseUrl, paths };
  }

  hasPathMap(): boolean {
    return this.tsconfigPaths !== null;
  }

  noteRead(path: string): void {
    this.readPaths.add(path);
  }

  observedReadPaths(): readonly string[] {
    return [...this.readPaths].sort();
  }

  loadSource(path: string): ts.SourceFile | null {
    if (this.sourceCache.has(path)) {
      return this.sourceCache.get(path) ?? null;
    }
    let source: ts.SourceFile | null = null;
    if (this.workspace.entry(path) === 'file' && this.pathAllowed(path)) {
      try {
        source = ts.createSourceFile(
          path,
          this.workspace.readFile(path),
          ts.ScriptTarget.Latest,
          true,
        );
      } catch {
        source = null;
      }
    }
    this.sourceCache.set(path, source);
    return source;
  }

  /**
   * A module specifier as the compiler would resolve it INSIDE the workspace:
   * relative specifiers against the importing file, non-relative ones through
   * the tsconfig path map. Bare specifiers the map does not cover are external
   * packages — there is nothing workspace-internal to read.
   */
  resolveSpecifier(specifier: string, fromFile: string): string | null {
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      const base = specifier.startsWith('/')
        ? specifier.slice(1)
        : posix.join(posix.dirname(fromFile), specifier);
      return this.probeFile(base);
    }
    if (this.tsconfigPaths === null) {
      return null;
    }
    const { baseUrl, paths } = this.tsconfigPaths;
    const candidates: string[] = [];
    const exact = paths.get(specifier);
    if (exact !== undefined) {
      candidates.push(...exact);
    } else {
      // Longest prefix wins, as the compiler does. A pattern key has exactly
      // one `*`; `@platform/outbox` matches `@platform/outbox` before
      // `@platform/*` ever needs to.
      for (const key of [...paths.keys()].sort((a, b) => b.length - a.length)) {
        const star = key.indexOf('*');
        if (star < 0) continue;
        const [prefix, suffix] = [key.slice(0, star), key.slice(star + 1)];
        if (
          specifier.length >= prefix.length + suffix.length &&
          specifier.startsWith(prefix) &&
          specifier.endsWith(suffix)
        ) {
          const substituted = `${prefix}${specifier.slice(
            prefix.length,
            specifier.length - suffix.length,
          )}${suffix}`;
          for (const target of paths.get(key) ?? []) {
            candidates.push(target.replace('*', substituted));
          }
          break;
        }
      }
    }
    for (const candidate of candidates) {
      const resolved = this.probeFile(posix.normalize(posix.join(baseUrl, candidate)));
      if (resolved !== null) {
        return resolved;
      }
    }
    return null;
  }

  /**
   * The file a specifier's path names: itself, or with a module extension. The read policy
   * (`pathAllowed`) is asked about each file the probe would read, never about the extensionless
   * path, which names no file: a policy of files (the module entry's tracked set) admits
   * `outbox-migration.ts`, not `outbox-migration`.
   */
  private probeFile(path: string): string | null {
    if (!isWorkspaceRelativePath(path)) {
      return null;
    }
    if (this.pathAllowed(path) && this.workspace.entry(path) === 'file') {
      return path;
    }
    for (const extension of MODULE_EXTENSIONS) {
      const candidate = normalizeWorkspacePath(`${path}${extension}`);
      if (this.pathAllowed(candidate) && this.workspace.entry(candidate) === 'file') {
        return candidate;
      }
    }
    return null;
  }
}

/**
 * The value of `key` in an object literal of a parsed-JSON config, or null.
 * The JSON AST shares node kinds with the regular AST (ObjectLiteralExpression,
 * PropertyAssignment, StringLiteral), so the regular guards apply; names
 * appear quoted or bare and both spell the same key.
 */
function jsonObjectProperty(object: ts.ObjectLiteralExpression, key: string): ts.Expression | null {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const name = ts.isStringLiteralLike(property.name)
      ? property.name.text
      : ts.isIdentifier(property.name)
        ? property.name.text
        : null;
    if (name === key) {
      return property.initializer;
    }
  }
  return null;
}

/** The root object of a parsed-JSON config file, or null. */
function jsonRootObject(config: ts.JsonSourceFile): ts.ObjectLiteralExpression | null {
  const object = config.statements[0]?.expression ?? null;
  return object !== null && ts.isObjectLiteralExpression(object) ? object : null;
}

/** Unwrap `as const`, type assertions, parentheses and `satisfies`. */
function unwrapExpression(expression: ts.Expression | undefined): ts.Expression | undefined {
  let current = expression;
  while (current !== undefined) {
    if (
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isParenthesizedExpression(current) ||
      ts.isSatisfiesExpression(current)
    ) {
      current = current.expression;
      continue;
    }
    return current;
  }
  return undefined;
}

interface Binding {
  readonly kind: 'local' | 'imported';
  /** For `import { original as local }`: the name the source module exports. */
  readonly importedName?: string;
  readonly initializer?: ts.Expression;
  readonly specifier?: string;
  readonly file: string;
  readonly line: number;
}

/** The file's top-level bindings a value identifier could refer to. */
function collectBindings(sourceFile: ts.SourceFile, file: string): Map<string, Binding> {
  const bindings = new Map<string, Binding>();
  for (const statement of sourceFile.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const line =
          sourceFile.getLineAndCharacterOfPosition(declaration.getStart(sourceFile)).line + 1;
        bindings.set(declaration.name.text, {
          kind: 'local',
          initializer: declaration.initializer,
          file,
          line,
        });
      }
      continue;
    }
    if (ts.isImportDeclaration(statement) && statement.importClause?.namedBindings !== undefined) {
      const specifier = ts.isStringLiteral(statement.moduleSpecifier)
        ? statement.moduleSpecifier.text
        : null;
      if (specifier === null) continue;
      const line =
        sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1;
      if (ts.isNamedImports(statement.importClause.namedBindings)) {
        for (const element of statement.importClause.namedBindings.elements) {
          bindings.set(element.name.text, {
            kind: 'imported',
            importedName: element.propertyName?.text ?? element.name.text,
            specifier,
            file,
            line,
          });
        }
      }
    }
  }
  return bindings;
}

/**
 * An exported binding of a module file: the initializer of `export const NAME`,
 * or — through `export { … } from` / `export * from` chains — the binding the
 * re-exported module itself exports under that name.
 */
function findExportedBinding(
  resolver: Resolver,
  file: string,
  name: string,
  seen: ReadonlySet<string>,
  errors: ModuleSchemaSourceError[],
): ts.Expression | null {
  const key = `${file}:${name}`;
  if (seen.has(key)) {
    return null;
  }
  seen = new Set([...seen, key]);
  const sourceFile = resolver.loadSource(file);
  if (sourceFile === null) {
    return null;
  }
  resolver.noteRead(file);
  for (const statement of sourceFile.statements) {
    if (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ===
        true
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
          return declaration.initializer ?? null;
        }
      }
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause !== undefined) {
      if (!ts.isNamedExports(statement.exportClause)) continue;
      for (const element of statement.exportClause.elements) {
        // `export { original as exported }`: `name` is what this file exports.
        if (element.name.text !== name) continue;
        const specifier = statement.moduleSpecifier;
        if (specifier !== undefined && ts.isStringLiteral(specifier)) {
          const target = resolver.resolveSpecifier(specifier.text, file);
          const innerName = element.propertyName?.text ?? name;
          if (target === null) {
            errors.push({
              message: `cannot resolve re-export '${specifier.text}' (from ${file}) while looking up '${name}'`,
              path: file,
              line:
                sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1,
            });
            return null;
          }
          return findExportedBinding(resolver, target, innerName, seen, errors);
        }
        // `export { local }` without `from`: the local binding in this file.
        const local = collectBindings(sourceFile, file).get(element.propertyName?.text ?? name);
        if (local?.initializer !== undefined) {
          return local.initializer;
        }
        return null;
      }
      continue;
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause === undefined &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      // `export * from '…'`: the name is re-exported iff the source exports it.
      const target = resolver.resolveSpecifier(statement.moduleSpecifier.text, file);
      if (target === null) {
        errors.push({
          message: `cannot resolve star re-export '${statement.moduleSpecifier.text}' (from ${file}) while looking up '${name}'`,
          path: file,
          line: sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1,
        });
        continue;
      }
      const through = findExportedBinding(resolver, target, name, seen, errors);
      if (through !== null) {
        return through;
      }
    }
  }
  return null;
}

interface ResolutionContext {
  readonly module: string;
  readonly property: string;
}

class ValueResolver {
  constructor(
    private readonly resolver: Resolver,
    private readonly errors: ModuleSchemaSourceError[],
  ) {}

  private fail(context: ResolutionContext, expression: ts.Expression, why: string): void {
    const sourceFile = expression.getSourceFile();
    this.errors.push({
      message: `module '${context.module}': ${context.property}: ${why}`,
      path: sourceFile.fileName,
      line: sourceFile.getLineAndCharacterOfPosition(expression.getStart(sourceFile)).line + 1,
    });
  }

  /** The strings of a string-array expression, spreads and imports resolved. */
  readStringArray(
    expression: ts.Expression,
    context: ResolutionContext,
    hops: number,
    seen: ReadonlySet<string>,
  ): readonly string[] {
    const values: string[] = [];
    const array = unwrapExpression(expression);
    if (array === undefined || !ts.isArrayLiteralExpression(array)) {
      this.fail(context, expression, 'expected an array literal');
      return values;
    }
    for (const element of array.elements) {
      if (ts.isOmittedExpression(element)) {
        continue;
      }
      if (ts.isStringLiteralLike(element)) {
        values.push(element.text);
        continue;
      }
      if (ts.isSpreadElement(element)) {
        const spread = unwrapExpression(element.expression);
        if (spread === undefined) {
          this.fail(context, element, 'cannot unwrap the spread expression');
          continue;
        }
        const nested = this.readStringsFromExpression(spread, context, hops - 1, seen);
        values.push(...nested);
        continue;
      }
      if (ts.isIdentifier(element)) {
        const single = this.readStringsFromExpression(element, context, hops - 1, seen);
        values.push(...single);
        continue;
      }
      this.fail(context, element, `unsupported element kind ${ts.SyntaxKind[element.kind]}`);
    }
    return values;
  }

  /**
   * The strings a single expression contributes: a string literal is itself; an
   * array literal contributes its elements; an identifier resolves to the
   * constant it is bound to — locally, or through an import specifier and the
   * workspace's tsconfig path map.
   */
  private readStringsFromExpression(
    expression: ts.Expression,
    context: ResolutionContext,
    hops: number,
    seen: ReadonlySet<string>,
  ): readonly string[] {
    if (hops <= 0) {
      this.fail(context, expression, 'resolution chain exceeded the hop budget');
      return [];
    }
    const key = `${expression.getSourceFile().fileName}@${expression.getStart(expression.getSourceFile())}`;
    if (seen.has(key)) {
      this.fail(context, expression, 'cyclic constant reference');
      return [];
    }
    seen = new Set([...seen, key]);
    const unwrapped = unwrapExpression(expression);
    if (unwrapped === undefined) {
      this.fail(context, expression, 'cannot unwrap the expression');
      return [];
    }
    if (ts.isStringLiteralLike(unwrapped)) {
      return [unwrapped.text];
    }
    if (ts.isArrayLiteralExpression(unwrapped)) {
      return this.readStringArray(unwrapped, context, hops - 1, seen);
    }
    if (ts.isIdentifier(unwrapped)) {
      const sourceFile = unwrapped.getSourceFile();
      const bindings = collectBindings(sourceFile, sourceFile.fileName);
      const binding = bindings.get(unwrapped.text);
      if (binding === undefined) {
        this.fail(
          context,
          unwrapped,
          `'${unwrapped.text}' is not bound to a constant the reader can follow`,
        );
        return [];
      }
      if (binding.kind === 'local') {
        if (binding.initializer === undefined) {
          this.fail(context, unwrapped, `'${unwrapped.text}' has no initializer`);
          return [];
        }
        return this.readStringsFromExpression(binding.initializer, context, hops - 1, seen);
      }
      // An imported constant: resolve the specifier, then the export.
      const specifier = binding.specifier;
      if (specifier === undefined) {
        this.fail(context, unwrapped, `'${unwrapped.text}' carries no import specifier`);
        return [];
      }
      const target = this.resolver.resolveSpecifier(specifier, binding.file);
      if (target === null) {
        this.fail(
          context,
          unwrapped,
          `'${unwrapped.text}' is imported from '${specifier}' which resolves to no workspace file` +
            (this.resolver.hasPathMap()
              ? ''
              : ' (the workspace has no tsconfig.base.json path map)'),
        );
        return [];
      }
      const importedName = binding.importedName ?? unwrapped.text;
      const initializer = findExportedBinding(
        this.resolver,
        target,
        importedName,
        new Set([...seen]),
        this.errors,
      );
      if (initializer === null) {
        this.fail(context, unwrapped, `'${importedName}' is not an exported constant of ${target}`);
        return [];
      }
      return this.readStringsFromExpression(initializer, context, hops - 1, seen);
    }
    this.fail(context, unwrapped, `unsupported expression kind ${ts.SyntaxKind[unwrapped.kind]}`);
    return [];
  }
}

function isPropertyNamed(name: ts.PropertyName, expected: string): boolean {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text === expected;
  }
  return false;
}

function readStringProperty(
  object: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.Expression | null {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property) || !isPropertyNamed(property.name, propertyName)) {
      continue;
    }
    return property.initializer;
  }
  return null;
}

/** The array literal a declaration `name` is bound to (MODULE_SCHEMAS…), or null when absent. */
function findArrayDeclaration(
  sourceFile: ts.SourceFile,
  name: string,
): ts.ArrayLiteralExpression | null {
  let found: ts.ArrayLiteralExpression | null = null;
  visit(sourceFile, (node) => {
    if (
      found !== null ||
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      node.name.text !== name
    ) {
      return;
    }
    const initializer = unwrapExpression(node.initializer);
    if (initializer !== undefined && ts.isArrayLiteralExpression(initializer)) {
      found = initializer;
    }
  });
  return found;
}

/**
 * TENANT_SCOPED_MODULES (`new Set(['farm', …])`) out of the SSoT source. Null when the declaration
 * is absent; an element that is not a string literal is a named error, never dropped.
 */
function readTenantScopedModules(
  sourceFile: ts.SourceFile,
  path: string,
  errors: ModuleSchemaSourceError[],
): ReadonlySet<string> | null {
  let found: Set<string> | null = null;
  visit(sourceFile, (node) => {
    if (
      found !== null ||
      !ts.isVariableDeclaration(node) ||
      !ts.isIdentifier(node.name) ||
      node.name.text !== 'TENANT_SCOPED_MODULES'
    ) {
      return;
    }
    const initializer = unwrapExpression(node.initializer);
    if (
      initializer === undefined ||
      !ts.isNewExpression(initializer) ||
      !ts.isIdentifier(initializer.expression) ||
      initializer.expression.text !== 'Set'
    ) {
      return;
    }
    const firstArg = initializer.arguments?.[0];
    if (firstArg === undefined || !ts.isArrayLiteralExpression(firstArg)) {
      return;
    }
    const modules = new Set<string>();
    for (const element of firstArg.elements) {
      if (ts.isStringLiteralLike(element)) {
        modules.add(element.text);
        continue;
      }
      errors.push({
        message: `TENANT_SCOPED_MODULES element is not a string literal (${element.getText(sourceFile)})`,
        path,
        line: sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line + 1,
      });
    }
    found = modules;
  });
  return found;
}

function visit(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, (child) => visit(child, visitor));
}

/**
 * Reads the workspace's MODULE_SCHEMAS declaration as source text. The SSoT
 * file must exist and be reachable through `containedWorkspace`; a missing
 * file throws (the caller decides what "the SSoT is not readable" means for
 * its check), while every element-level failure is a named error in the
 * result, never a silent drop.
 *
 * `options.pathAllowed` (optional) is the caller's read policy — the adapter
 * passes its repo-snapshot allowance so the import-chain resolution never
 * reads a path the snapshot does not permit. A disallowed path resolves to
 * nothing, which surfaces as a named error naming the specifier.
 */
export function readModuleSchemasSource(
  workspaceRoot: string,
  ssotPath: string = MODULE_SCHEMAS_SOURCE_PATH,
  options: { readonly pathAllowed?: (path: string) => boolean } = {},
): ModuleSchemasSource {
  const workspace = containedWorkspace(workspaceRoot);
  const errors: ModuleSchemaSourceError[] = [];
  const resolver = new Resolver(workspace, errors, options.pathAllowed ?? (() => true));
  const ssotText = workspace.readFile(ssotPath);
  resolver.noteRead(ssotPath);
  const sourceFile = ts.createSourceFile(ssotPath, ssotText, ts.ScriptTarget.Latest, true);
  const valueResolver = new ValueResolver(resolver, errors);

  const arrayLiteral = findArrayDeclaration(sourceFile, 'MODULE_SCHEMAS');
  const tenantScopedModules = readTenantScopedModules(sourceFile, ssotPath, errors);

  const modules: ModuleSchemaSourceRecord[] = [];
  if (arrayLiteral === null) {
    errors.push({
      message: 'MODULE_SCHEMAS is not declared as an array literal in the SSoT file',
      path: ssotPath,
      line: 1,
    });
    return {
      path: ssotPath,
      modules,
      tenantScopedModules,
      errors,
      readPaths: resolver.observedReadPaths(),
    };
  }

  for (const element of arrayLiteral.elements) {
    if (!ts.isObjectLiteralExpression(element)) {
      errors.push({
        message: `MODULE_SCHEMAS entry is not an object literal (${ts.SyntaxKind[element.kind]})`,
        path: ssotPath,
        line: sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line + 1,
      });
      continue;
    }
    const moduleNameExpression = readStringProperty(element, 'moduleName');
    const moduleName =
      moduleNameExpression !== null && ts.isStringLiteralLike(moduleNameExpression)
        ? moduleNameExpression.text
        : null;
    if (moduleName === null) {
      errors.push({
        message: 'MODULE_SCHEMAS entry has no literal moduleName',
        path: ssotPath,
        line: sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line + 1,
      });
      continue;
    }
    const context: ResolutionContext = { module: moduleName, property: '' };
    const readArray = (property: string): readonly string[] => {
      const initializer = readStringProperty(element, property);
      if (initializer === null) {
        return [];
      }
      return valueResolver.readStringArray(
        initializer,
        { ...context, property },
        MAX_RESOLUTION_HOPS,
        new Set(),
      );
    };
    const sourceSchemaExpression = readStringProperty(element, 'sourceSchema');
    const sourceSchema =
      sourceSchemaExpression !== null && ts.isStringLiteralLike(sourceSchemaExpression)
        ? sourceSchemaExpression.text
        : moduleName;
    const strictOwnershipExpression = readStringProperty(element, 'strictOwnership');
    const strictOwnership =
      strictOwnershipExpression !== null &&
      strictOwnershipExpression.kind === ts.SyntaxKind.TrueKeyword;
    modules.push({
      moduleName,
      sourceSchema,
      strictOwnership,
      tables: readArray('tables'),
      referenceDataTables: readArray('referenceDataTables'),
      infrastructureTables: readArray('infrastructureTables'),
      path: ssotPath,
      line: sourceFile.getLineAndCharacterOfPosition(element.getStart(sourceFile)).line + 1,
    });
  }

  return {
    path: ssotPath,
    modules,
    tenantScopedModules,
    errors,
    readPaths: resolver.observedReadPaths(),
  };
}

// --- The module entry of the code-fact bridge (`--facts`, service-expertise PLAN §3.2, SE-3) ----

/** Where SCHEMA_REGISTRY, the owner of "which service owns which schema", is declared. */
export const SCHEMA_REGISTRY_SOURCE_PATH = 'apps/db-migrate/src/schema-registry.ts';

/** One SCHEMA_REGISTRY entry: the service that owns a schema. */
export interface SchemaOwnerRecord {
  readonly service: string;
  readonly schema: string;
  readonly path: string;
  readonly line: number;
}

/**
 * SCHEMA_REGISTRY read as source text, as MODULE_SCHEMAS is: the workspace under analysis (a base
 * tree, a fixture) is observed, never imported. An entry whose `service` or `schema` is not a
 * string literal is a named error, never dropped.
 */
export function readSchemaOwners(workspaceRoot: string): {
  readonly owners: readonly SchemaOwnerRecord[];
  readonly errors: readonly ModuleSchemaSourceError[];
} {
  const path = SCHEMA_REGISTRY_SOURCE_PATH;
  const sourceFile = ts.createSourceFile(
    path,
    containedWorkspace(workspaceRoot).readFile(path),
    ts.ScriptTarget.Latest,
    true,
  );
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const registry = findArrayDeclaration(sourceFile, 'SCHEMA_REGISTRY');
  const owners: SchemaOwnerRecord[] = [];
  const errors: ModuleSchemaSourceError[] = [];
  if (registry === null) {
    errors.push({ message: 'SCHEMA_REGISTRY is not declared as an array literal', path, line: 1 });
    return { owners, errors };
  }
  for (const element of registry.elements) {
    const service = ts.isObjectLiteralExpression(element)
      ? readStringProperty(element, 'service')
      : null;
    const schema = ts.isObjectLiteralExpression(element)
      ? readStringProperty(element, 'schema')
      : null;
    if (
      service === null ||
      schema === null ||
      !ts.isStringLiteralLike(service) ||
      !ts.isStringLiteralLike(schema)
    ) {
      errors.push({
        message: 'SCHEMA_REGISTRY entry has no literal service and schema',
        path,
        line: lineOf(element),
      });
      continue;
    }
    owners.push({ service: service.text, schema: schema.text, path, line: lineOf(element) });
  }
  return { owners, errors };
}

/** The tenant placement of one service's schema, from its MODULE_SCHEMAS entry. */
export interface ServiceTenantFacts {
  readonly service: string;
  readonly module: string;
  readonly schema: string;
  /** In TENANT_SCOPED_MODULES: its `tables` are cloned into every `tenant_<uuid>` schema. */
  readonly tenant_scoped: boolean;
  /** Tables that live in `tenant_<uuid>` (the module's `tables` when tenant-scoped). */
  readonly per_tenant_tables: readonly string[];
  /** Tables that live in the named schema: `infrastructureTables`, plus `tables` when not scoped. */
  readonly cross_tenant_tables: readonly string[];
  readonly reference_data_tables: readonly string[];
  /** The MODULE_SCHEMAS entry, `path:line`. */
  readonly ref: string;
}

export interface ModuleFacts {
  readonly schema: 'aria/module_facts/v1';
  readonly services: readonly ServiceTenantFacts[];
  /** MODULE_SCHEMAS entries whose schema no SCHEMA_REGISTRY service owns (e.g. `platform`). */
  readonly modules_without_owner: readonly {
    readonly module: string;
    readonly schema: string;
    readonly ref: string;
  }[];
  /**
   * SCHEMA_REGISTRY owners whose schema no MODULE_SCHEMAS entry declares: the service owns a
   * schema whose placement the tree does not state. Listed, never dropped, so "placement unknown"
   * never reads as "owns no schema"; not refused, because the platform invariants allow it (a
   * module manifest is required only for a tenant-aware schema). `ref` is the registry entry.
   */
  readonly owners_without_module: readonly {
    readonly service: string;
    readonly schema: string;
    readonly ref: string;
  }[];
}

/** The tree's registries cannot give complete facts: the kernel holds the change by name. */
export class ModuleFactsUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModuleFactsUnavailable';
  }
}

/**
 * The schema -> owning service map of SCHEMA_REGISTRY, or the named reasons it is not one.
 *
 * Every owner must be an nx application of the tree, by the SE-1 key (`applicationNames`); a
 * schema claimed by two services, or a service listed twice, has no single owner. Keeping the
 * last entry would drop a service from the facts with exit 0, so each is an error by name.
 */
function schemaOwnership(
  tree: TrackedTree,
  owners: readonly SchemaOwnerRecord[],
): { readonly ownerOf: ReadonlyMap<string, string>; readonly errors: readonly string[] } {
  const applications = new Set(applicationNames(tree).values());
  const errors: string[] = [];
  const grouped = (key: (owner: SchemaOwnerRecord) => string): Map<string, SchemaOwnerRecord[]> => {
    const groups = new Map<string, SchemaOwnerRecord[]>();
    for (const owner of owners) groups.set(key(owner), [...(groups.get(key(owner)) ?? []), owner]);
    return groups;
  };
  const at = (claims: readonly SchemaOwnerRecord[]): string =>
    claims.map((claim) => `${claim.service} (${claim.path}:${claim.line})`).join(', ');
  for (const [schema, claims] of grouped((owner) => owner.schema)) {
    if (claims.length > 1) errors.push(`schema '${schema}' is claimed by ${at(claims)}`);
  }
  for (const [service, claims] of grouped((owner) => owner.service)) {
    if (claims.length > 1)
      errors.push(`service '${service}' is listed ${claims.length} times: ${at(claims)}`);
  }
  for (const owner of owners) {
    if (!applications.has(owner.service)) {
      errors.push(
        `owner '${owner.service}' (${owner.path}:${owner.line}) is not an nx application under apps/`,
      );
    }
  }
  return {
    ownerOf: new Map(owners.map((owner) => [owner.schema, owner.service] as const)),
    errors,
  };
}

/**
 * The schema and table placement of each service of the tree at `workspaceRoot` (the diff's base
 * tree): MODULE_SCHEMAS and TENANT_SCOPED_MODULES through this module's one reading, joined to the
 * owning service by SCHEMA_REGISTRY. A registry that is absent, read with named errors, or whose
 * ownership is ambiguous or names no nx application throws ModuleFactsUnavailable: partial
 * placement facts are never returned. The join's leftovers on either side are listed by name:
 * a module no service owns (`modules_without_owner`) and an owner whose schema no module declares
 * (`owners_without_module`).
 */
export function moduleFacts(workspaceRoot: string): ModuleFacts {
  // The tree's tracked content, the one enumeration the event entry reads too: the registries and
  // every module their imports reach must be tracked regular files, so an ignored or untracked
  // module never becomes placement facts stamped with the base commit (SE-3-R2 round-2 RB).
  const tracked = trackedTree(workspaceRoot);
  for (const path of [MODULE_SCHEMAS_SOURCE_PATH, SCHEMA_REGISTRY_SOURCE_PATH]) {
    if (!tracked.holdsFile(path)) {
      throw new ModuleFactsUnavailable(`${path} is not a file the tree tracks`);
    }
  }
  const source = readModuleSchemasSource(workspaceRoot, MODULE_SCHEMAS_SOURCE_PATH, {
    pathAllowed: (path) => tracked.holdsFile(path),
  });
  const registry = readSchemaOwners(workspaceRoot);
  const errors = [...source.errors, ...registry.errors];
  if (errors.length > 0) {
    throw new ModuleFactsUnavailable(
      errors.map((error) => `${error.path}:${error.line} ${error.message}`).join('; '),
    );
  }
  const scoped = source.tenantScopedModules;
  if (scoped === null) {
    throw new ModuleFactsUnavailable(`${source.path} declares no TENANT_SCOPED_MODULES set`);
  }
  const ownership = schemaOwnership(tracked, registry.owners);
  if (ownership.errors.length > 0) {
    throw new ModuleFactsUnavailable(
      `${SCHEMA_REGISTRY_SOURCE_PATH}: ${ownership.errors.join('; ')}`,
    );
  }
  const { ownerOf } = ownership;
  const services: ServiceTenantFacts[] = [];
  const unowned: { module: string; schema: string; ref: string }[] = [];
  for (const module of source.modules) {
    const ref = `${module.path}:${module.line}`;
    const service = ownerOf.get(module.sourceSchema);
    if (service === undefined) {
      unowned.push({ module: module.moduleName, schema: module.sourceSchema, ref });
      continue;
    }
    const tenantScoped = scoped.has(module.moduleName);
    services.push({
      service,
      module: module.moduleName,
      schema: module.sourceSchema,
      tenant_scoped: tenantScoped,
      per_tenant_tables: tenantScoped ? module.tables : [],
      cross_tenant_tables: tenantScoped
        ? module.infrastructureTables
        : [...module.tables, ...module.infrastructureTables],
      reference_data_tables: module.referenceDataTables,
      ref,
    });
  }
  const declared = new Set(source.modules.map((module) => module.sourceSchema));
  return {
    schema: 'aria/module_facts/v1',
    services: services.sort((a, b) => a.service.localeCompare(b.service)),
    modules_without_owner: unowned,
    owners_without_module: registry.owners
      .filter((owner) => !declared.has(owner.schema))
      .map((owner) => ({
        service: owner.service,
        schema: owner.schema,
        ref: `${owner.path}:${owner.line}`,
      }))
      .sort((a, b) => a.service.localeCompare(b.service)),
  };
}

/**
 * `--facts --repo-root <tree>`: the tree's tenant placement facts as one JSON object on stdout,
 * exit 0. Registries that cannot give complete facts, or a bad invocation: exit 2, nothing on
 * stdout, so the kernel holds the change by name instead of reading partial facts.
 */
function main(argv: readonly string[]): number {
  const rootFlag = argv.indexOf('--repo-root');
  const repoRoot = rootFlag === -1 ? undefined : argv[rootFlag + 1];
  if (!argv.includes('--facts') || repoRoot === undefined || argv.length !== 3) {
    process.stderr.write('usage: module-schemas-source.ts --facts --repo-root <tree>\n');
    return 2;
  }
  let facts: ModuleFacts;
  try {
    facts = moduleFacts(repoRoot);
  } catch (error) {
    if (error instanceof ModuleFactsUnavailable) {
      process.stderr.write(`module-schemas-source --facts: ${error.message}\n`);
      return 2;
    }
    // The SE-1 key reader cannot read the tree's applications (a tracked symlinked or non-JSON
    // project.json): its message names the path, never the content.
    if (error instanceof SourceTreeUnavailable) {
      process.stderr.write(`module-schemas-source --facts: ${error.name}: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
  process.stdout.write(`${JSON.stringify(facts)}\n`);
  return 0;
}

if (require.main === module) {
  // exitCode, never process.exit(): stdout to a pipe is written asynchronously, and exiting at once
  // cuts the facts at the pipe buffer (64 KiB) while the exit code still says 0.
  process.exitCode = main(process.argv.slice(2));
}
