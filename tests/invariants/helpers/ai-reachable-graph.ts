/**
 * The AI-reachable code graph (K10 layer 4, PR-T1 — V-T1b-2).
 *
 * WHY an AST walk and not a regex: the data-layer guarantee is "code an AI
 * subject reaches can read only through the TenantScope the responder
 * skeleton opened". A regex over one file cannot see a collaborator of a
 * collaborator, a repository held under an unusual property name, a static
 * helper on a service that holds a DataSource, or a process-wide cache. This
 * module parses every reachable source with the TypeScript compiler and
 * follows, from each AI responder:
 *   - constructor-injected collaborators (whole class),
 *   - dispatched queries/commands (to their one @QueryHandler/@CommandHandler),
 *   - classes instantiated with `new`,
 *   - imported functions and static methods (that function/method only).
 *
 * Every node is checked for the ways out of the scope: injecting a
 * DataSource / repository / EntityManager / QueryRunner / ModuleRef / a scope
 * opener, opening a boundary itself, reaching the connection behind the
 * manager, schema-qualified SQL or search_path changes, and state that
 * outlives one request (a process-wide cache).
 *
 * The walker takes a source reader, so its own spec can feed it synthetic
 * sources and prove each rule fires.
 */
import { dirname, join, normalize } from 'node:path';

import * as ts from 'typescript';

export type SourceReader = (path: string) => string | null;

/** Injected types that may appear in the AI graph, with the reviewed reason. */
export const AI_GRAPH_ALLOWED_EXTERNAL_TYPES: Readonly<Record<string, string>> = {
  QueryBus: 'routes each query to its one handler, which the walk follows',
  CommandBus: 'routes each command to its one handler, which the walk follows',
  OutboxPublisher: 'writes only through the EntityManager the caller hands it (the write scope)',
  ConfigService: 'reads process configuration; holds no tenant data',
};

/**
 * Local classes the walk stops at, with the reviewed reason. The responder
 * skeleton is the one place that opens a scope on the AI path.
 */
export const AI_GRAPH_TERMINALS: Readonly<Record<string, string>> = {
  FarmAiResponder:
    'the responder skeleton: opens the tenant scope, resolves owned ids, reads the served tenant back',
};

/** Types whose injection gives code a way to read outside the scope. */
const BANNED_INJECTED_TYPES = new Set([
  'DataSource',
  'EntityManager',
  'QueryRunner',
  'Repository',
  'TreeRepository',
  'MongoRepository',
  'TenantAwareRepository',
  'TenantScopedRepository',
  'ModuleRef',
  'FarmTenantScopes',
  'TenantScope',
  'RedisService',
  'ClientProxy',
]);

/** Decorators that inject a data handle. */
const BANNED_PARAM_DECORATORS = new Set([
  'InjectRepository',
  'InjectDataSource',
  'InjectEntityManager',
  'InjectConnection',
  'Inject',
]);

/**
 * Functions that open a boundary of their own, route by ambient context, build
 * schema names, or reach TypeORM's global connection.
 */
const BANNED_FUNCTIONS = new Set([
  'runInTenantRead',
  'runInTenantTransaction',
  'runInSourceRead',
  'getScopedRepository',
  'withTenantContext',
  'forEachTenantSchema',
  'listTenantSchemas',
  'getTenantSchemaName',
  'getRepository',
  'getConnection',
  'getManager',
]);

/**
 * Methods that open a second connection or read through ambient context.
 * (`scope.manager.getRepository(Entity)` stays allowed: that repository is
 * bound to the scope's own connection.)
 */
const BANNED_METHODS = new Set([
  'createQueryRunner',
  'getScopedRepository',
  'runInTenantRead',
  'runInTenantTransaction',
  'runInSourceRead',
]);

/** Property reads that reach past the scope to the connection or the pool. */
const BANNED_PROPERTIES = new Set(['connection', 'queryRunner', 'dataSource', 'driver']);

/** Schema-qualified SQL or a search_path / RLS change inside a string. */
const SCHEMA_QUALIFIED_SQL =
  /"(?:farm|public|shared|platform|auth|sensor|alert|hr|messaging|hydroponics|ai|admin|billing|notification|event_store|config|tenant_[a-z0-9_]+)"\s*\.\s*"?[A-Za-z_]|\b(?:FROM|JOIN|INTO|UPDATE)\s+(?:farm|public|shared|platform|auth|tenant_[a-z0-9_]+)\s*\.|search_path|app\.current_tenant|app\.bypass_rls/i;

/** `new X()` that builds a long-lived, request-spanning container. */
const CACHE_CONSTRUCTORS = new Set(['Map', 'WeakMap', 'LRUCache', 'Set']);

export interface GraphViolation {
  readonly node: string;
  readonly reason: string;
}

interface ImportBinding {
  readonly module: string;
  readonly importedName: string;
  readonly typeOnly: boolean;
}

interface ParsedFile {
  readonly path: string;
  readonly source: ts.SourceFile;
  readonly imports: ReadonlyMap<string, ImportBinding>;
}

type Declaration =
  | { readonly kind: 'class'; readonly file: ParsedFile; readonly node: ts.ClassDeclaration }
  | { readonly kind: 'function'; readonly file: ParsedFile; readonly node: ts.Node };

export class AiReachableGraph {
  private readonly parsed = new Map<string, ParsedFile | null>();
  private readonly visited = new Set<string>();
  private readonly handlerIndex = new Map<string, string[]>();

  constructor(
    private readonly read: SourceReader,
    /** Every source file of the app, for locating @QueryHandler(X) / @CommandHandler(X). */
    private readonly appFiles: readonly string[],
  ) {}

  /**
   * Walk from one responder class and return every violation reachable from it.
   * `nodes` receives every node the walk entered (for sanity assertions).
   */
  walkFromClass(file: string, className: string, nodes: Set<string> = new Set()): GraphViolation[] {
    this.visited.clear();
    const parsed = this.parse(file);
    if (parsed === null) return [{ node: `${file}#${className}`, reason: 'source not readable' }];
    const decl = findClass(parsed.source, className);
    if (decl === undefined) return [{ node: `${file}#${className}`, reason: 'class not found' }];
    const violations: GraphViolation[] = [];
    this.visitClass(parsed, decl, violations, nodes, true);
    return violations;
  }

  private parse(path: string): ParsedFile | null {
    const cached = this.parsed.get(path);
    if (cached !== undefined) return cached;
    const text = this.read(path);
    if (text === null) {
      this.parsed.set(path, null);
      return null;
    }
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const parsed: ParsedFile = { path, source, imports: collectImports(source) };
    this.parsed.set(path, parsed);
    return parsed;
  }

  /** The .ts file a relative module specifier names, or null for a package import. */
  private resolveModule(from: ParsedFile, specifier: string): string | null {
    if (!specifier.startsWith('.')) return null;
    const base = normalize(join(dirname(from.path), specifier));
    for (const candidate of [`${base}.ts`, join(base, 'index.ts')]) {
      if (this.read(candidate) !== null) return candidate;
    }
    return null;
  }

  /** Where an imported (or same-file) identifier is declared, following re-exports. */
  private resolveIdentifier(file: ParsedFile, name: string, depth = 0): Declaration | null {
    if (depth > 8) return null;
    const local = findDeclaration(file, name);
    if (local !== null) return local;
    const binding = file.imports.get(name);
    if (binding === undefined || binding.typeOnly) return null;
    const target = this.resolveModule(file, binding.module);
    if (target === null) return null;
    const parsed = this.parse(target);
    if (parsed === null) return null;
    const found = findDeclaration(parsed, binding.importedName);
    if (found !== null) return found;
    // barrel: export { X } from './y' / export * from './y'
    for (const statement of parsed.source.statements) {
      if (!ts.isExportDeclaration(statement) || statement.moduleSpecifier === undefined) continue;
      const spec = (statement.moduleSpecifier as ts.StringLiteral).text;
      const named =
        statement.exportClause === undefined ||
        (ts.isNamedExports(statement.exportClause) &&
          statement.exportClause.elements.some((e) => e.name.text === binding.importedName));
      if (!named) continue;
      const next = this.resolveModule(parsed, spec);
      const nextParsed = next === null ? null : this.parse(next);
      if (nextParsed === null) continue;
      const decl = findDeclaration(nextParsed, binding.importedName);
      if (decl !== null) return decl;
    }
    return null;
  }

  /** Is `name` imported from a package (not walked)? */
  private isExternal(file: ParsedFile, name: string): boolean {
    const binding = file.imports.get(name);
    return binding !== undefined && !binding.module.startsWith('.');
  }

  private handlerFor(kind: 'Query' | 'Command', className: string): string[] {
    const key = `${kind}:${className}`;
    const cached = this.handlerIndex.get(key);
    if (cached !== undefined) return cached;
    const pattern = new RegExp(`@${kind}Handler\\(\\s*${className}\\s*\\)`);
    const found: string[] = [];
    for (const file of this.appFiles) {
      const text = this.read(file);
      if (text === null || !pattern.test(text)) continue;
      const parsed = this.parse(file);
      if (parsed === null) continue;
      for (const statement of parsed.source.statements) {
        if (!ts.isClassDeclaration(statement) || statement.name === undefined) continue;
        const decorated = (ts.getDecorators(statement) ?? []).some((d) =>
          pattern.test(d.getText(parsed.source)),
        );
        if (decorated) found.push(`${file}#${statement.name.text}`);
      }
    }
    this.handlerIndex.set(key, found);
    return found;
  }

  /**
   * @param singleton - the class is a DI singleton (an injected collaborator,
   *   a dispatched handler, the responder): one instance serves every tenant,
   *   so instance state it keeps outlives the request. A class built with
   *   `new` inside a request (an entity, a value object) is not.
   */
  private visitClass(
    file: ParsedFile,
    decl: ts.ClassDeclaration,
    violations: GraphViolation[],
    nodes: Set<string>,
    singleton: boolean,
  ): void {
    const name = decl.name?.text ?? '<anonymous>';
    const id = `${file.path}#${name}`;
    if (this.visited.has(id)) return;
    this.visited.add(id);
    nodes.add(id);
    const push = (reason: string): void => {
      violations.push({ node: id, reason });
    };

    const ctor = decl.members.find(ts.isConstructorDeclaration);
    for (const param of ctor?.parameters ?? []) {
      const paramName = param.name.getText(file.source);
      for (const decorator of ts.getDecorators(param) ?? []) {
        const callee = decoratorName(decorator);
        if (callee !== null && BANNED_PARAM_DECORATORS.has(callee)) {
          push(`constructor parameter ${paramName} is injected with @${callee}()`);
        }
      }
      const typeName = typeReferenceName(param.type);
      if (typeName === null) {
        push(`constructor parameter ${paramName} has no class type`);
        continue;
      }
      if (BANNED_INJECTED_TYPES.has(typeName)) {
        push(`injects ${typeName} (${paramName}) — a way to read outside the TenantScope`);
        continue;
      }
      if (typeName in AI_GRAPH_TERMINALS) continue;
      if (this.isExternal(file, typeName)) {
        if (!(typeName in AI_GRAPH_ALLOWED_EXTERNAL_TYPES)) {
          push(`injects ${typeName} from a package that is not reviewed for the AI graph`);
        }
        continue;
      }
      const target = this.resolveIdentifier(file, typeName);
      if (target === null || target.kind !== 'class') {
        push(`injected ${typeName} could not be resolved to a class`);
        continue;
      }
      this.visitClass(target.file, target.node, violations, nodes, true);
    }

    for (const member of singleton ? decl.members : []) {
      if (ts.isPropertyDeclaration(member) && member.initializer !== undefined) {
        const cache = cacheConstructor(member.initializer);
        if (cache !== null) {
          push(
            `field ${member.name.getText(file.source)} holds a ${cache} that outlives one request`,
          );
        }
      }
    }
    this.scanBody(file, decl, id, violations, nodes, singleton ? ctor : decl);
  }

  private visitFunction(
    file: ParsedFile,
    node: ts.Node,
    id: string,
    violations: GraphViolation[],
    nodes: Set<string>,
  ): void {
    if (this.visited.has(id)) return;
    this.visited.add(id);
    nodes.add(id);
    this.scanBody(file, node, id, violations, nodes, undefined);
  }

  private visitStatic(
    file: ParsedFile,
    cls: ts.ClassDeclaration,
    method: string,
    violations: GraphViolation[],
    nodes: Set<string>,
  ): void {
    const member = cls.members.find(
      (m) =>
        (ts.isMethodDeclaration(m) || ts.isPropertyDeclaration(m)) &&
        m.name.getText(file.source) === method &&
        (ts.getModifiers(m) ?? []).some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword),
    );
    const id = `${file.path}#${cls.name?.text ?? '?'}.${method}`;
    if (member === undefined) {
      violations.push({ node: id, reason: 'static member not found' });
      return;
    }
    this.visitFunction(file, member, id, violations, nodes);
  }

  /** Check one body for escapes and follow what it calls. */
  private scanBody(
    file: ParsedFile,
    root: ts.Node,
    id: string,
    violations: GraphViolation[],
    nodes: Set<string>,
    /** Where `this.x =` is allowed: the singleton's constructor, or the whole class of a per-request instance. */
    stateScope: ts.Node | undefined,
  ): void {
    const push = (reason: string): void => {
      violations.push({ node: id, reason });
    };
    const src = file.source;
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node) || ts.isTemplateExpression(node)) {
        const text = node.getText(src);
        if (SCHEMA_QUALIFIED_SQL.test(text)) {
          push(`SQL names a schema or changes search_path/RLS: ${text.slice(0, 80)}`);
        }
      }
      if (ts.isPropertyAccessExpression(node) && BANNED_PROPERTIES.has(node.name.text)) {
        push(`reads .${node.name.text} — reaches past the scope to the connection`);
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(node.left) &&
        node.left.expression.kind === ts.SyntaxKind.ThisKeyword &&
        !isInside(node, stateScope)
      ) {
        push(
          `assigns this.${node.left.name.text} outside the constructor — state that outlives one request`,
        );
      }
      if (ts.isCallExpression(node)) this.onCall(file, node, push, violations, nodes);
      if (ts.isNewExpression(node)) this.onNew(file, node, push, violations, nodes);
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(root, visit);
  }

  private onCall(
    file: ParsedFile,
    node: ts.CallExpression,
    push: (reason: string) => void,
    violations: GraphViolation[],
    nodes: Set<string>,
  ): void {
    const callee = node.expression;
    if (ts.isIdentifier(callee)) {
      if (BANNED_FUNCTIONS.has(callee.text)) push(`calls ${callee.text}()`);
      const decl = this.resolveIdentifier(file, callee.text);
      if (decl?.kind === 'function') {
        this.visitFunction(
          decl.file,
          decl.node,
          `${decl.file.path}#${callee.text}`,
          violations,
          nodes,
        );
      }
      return;
    }
    if (!ts.isPropertyAccessExpression(callee)) return;
    const method = callee.name.text;
    if (BANNED_METHODS.has(method)) push(`calls .${method}()`);
    if (ts.isIdentifier(callee.expression)) {
      const owner = callee.expression.text;
      if (owner === 'TenantScope' && (method === 'read' || method === 'write')) {
        push(`opens a boundary itself with TenantScope.${method}()`);
      }
      const decl = this.resolveIdentifier(file, owner);
      if (decl?.kind === 'class') this.visitStatic(decl.file, decl.node, method, violations, nodes);
    }
  }

  private onNew(
    file: ParsedFile,
    node: ts.NewExpression,
    push: (reason: string) => void,
    violations: GraphViolation[],
    nodes: Set<string>,
  ): void {
    if (!ts.isIdentifier(node.expression)) return;
    const name = node.expression.text;
    const dispatched = /(Query|Command)$/.exec(name);
    if (dispatched !== null && !this.isExternal(file, name)) {
      const handlers = this.handlerFor(dispatched[1] === 'Query' ? 'Query' : 'Command', name);
      if (handlers.length !== 1) {
        push(`${name}: ${handlers.length} handlers found (expected exactly one)`);
        return;
      }
      const [handler] = handlers;
      const [handlerFile, handlerClass] = (handler ?? '').split('#');
      const parsed = this.parse(handlerFile ?? '');
      const cls = parsed === null ? undefined : findClass(parsed.source, handlerClass ?? '');
      if (parsed !== null && cls !== undefined)
        this.visitClass(parsed, cls, violations, nodes, true);
      return;
    }
    const decl = this.resolveIdentifier(file, name);
    if (decl?.kind === 'class') this.visitClass(decl.file, decl.node, violations, nodes, false);
  }
}

function collectImports(source: ts.SourceFile): Map<string, ImportBinding> {
  const imports = new Map<string, ImportBinding>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || statement.importClause === undefined) continue;
    const module = (statement.moduleSpecifier as ts.StringLiteral).text;
    const clause = statement.importClause;
    const clauseTypeOnly = clause.isTypeOnly;
    if (clause.name !== undefined) {
      imports.set(clause.name.text, { module, importedName: 'default', typeOnly: clauseTypeOnly });
    }
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        imports.set(element.name.text, {
          module,
          importedName: element.propertyName?.text ?? element.name.text,
          typeOnly: clauseTypeOnly || element.isTypeOnly,
        });
      }
    }
  }
  return imports;
}

function findClass(source: ts.SourceFile, name: string): ts.ClassDeclaration | undefined {
  return source.statements.find(
    (s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === name,
  );
}

function findDeclaration(file: ParsedFile, name: string): Declaration | null {
  for (const statement of file.source.statements) {
    if (ts.isClassDeclaration(statement) && statement.name?.text === name) {
      return { kind: 'class', file, node: statement };
    }
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return { kind: 'function', file, node: statement };
    }
    if (ts.isVariableStatement(statement)) {
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer !== undefined) {
          const init = d.initializer;
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            return { kind: 'function', file, node: init };
          }
        }
      }
    }
  }
  return null;
}

function decoratorName(decorator: ts.Decorator): string | null {
  const expr = decorator.expression;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) return expr.expression.text;
  if (ts.isIdentifier(expr)) return expr.text;
  return null;
}

function typeReferenceName(type: ts.TypeNode | undefined): string | null {
  if (type === undefined || !ts.isTypeReferenceNode(type)) return null;
  const name = type.typeName;
  return ts.isIdentifier(name) ? name.text : name.right.text;
}

function cacheConstructor(init: ts.Expression): string | null {
  if (!ts.isNewExpression(init) || !ts.isIdentifier(init.expression)) return null;
  const ctor = init.expression.text;
  if (!CACHE_CONSTRUCTORS.has(ctor)) return null;
  // A Set built from a literal list is static configuration, not a cache.
  if (ctor === 'Set' && (init.arguments?.length ?? 0) > 0) return null;
  return ctor;
}

function isInside(node: ts.Node, container: ts.Node | undefined): boolean {
  if (container === undefined) return false;
  return node.pos >= container.pos && node.end <= container.end;
}
