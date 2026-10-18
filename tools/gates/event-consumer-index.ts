/**
 * event-consumer-index — which application consumes which event, read from the code (ARIA-HIGH-313).
 * ==================================================================================================
 *
 * A service consumes an event through the platform event bus, which creates a durable JetStream
 * pull consumer (platform/libs/event-bus/src/nats/nats-event-bus.ts, `subscribeTo` ->
 * `durable_name`). Such a consumer receives through `$JS.API.CONSUMER.>` and its inbox, so its NATS
 * subscribe grants (infrastructure/nats/services.yaml) never name the event: notification-service
 * handles UserInvited while no grant of its identity mentions it. A closure built from ACL grants
 * therefore missed most real consumers and named every catch-all holder (`events.>`) instead. ACL
 * grants record permission, not consumption.
 *
 * The code is the owner of "who consumes what". This module reads it at run time; nothing is
 * generated or committed, so there is no cache to go stale:
 *
 *   - Candidates: non-test `.ts` under apps/<app>/src, libs/<lib>/src and platform/libs/<lib>/src
 *     whose text contains a subscription-shaped call (`subscribe…(`, `SubscribeTo(`,
 *     `EventPattern(`, `EventHandler(`). The text filter only bounds the program; it decides nothing.
 *   - Sites are recognised by the type checker, not by name: a call whose resolved signature is
 *     declared by the event bus (`subscribe`, `subscribeWildcard`, `subscribeForTenant` take an
 *     event type; `subscribeTo` takes a subject) or by the NATS client (`subscribe`, a subject), and
 *     the decorators `@SubscribeTo` (subject), `@EventHandler` (event type) from the event bus and
 *     `@EventPattern` (subject) from @nestjs/microservices. An rxjs `.subscribe(` is ignored because
 *     its signature is not one of those. `@MessagePattern` is request/reply, not event consumption.
 *   - The subscribed value is folded statically (`foldValues`): literals, string-literal types
 *     (including `as const` lookups and string enums), const bindings, templates whose parts fold,
 *     for-of / forEach over a foldable iterable (`Object.keys` / `Object.values` of an object,
 *     arrays, tuples), a parameter of a private or unexported function whose every call in its file
 *     passes a foldable argument, and `<types>.map(buildWildcardEventSubject |
 *     buildRoutedWildcardSubject)`, which yields the event types themselves so subject formatting
 *     is never re-implemented here. A value that does not fold is reported as `unresolved`, which
 *     the plan-coverage witness turns into an uncovered node: an unknown consumer is a gap, never a
 *     silent pass.
 *   - FORWARDING_SITES are the bus's and the transport's own forwarding layers (a `subscribe` that
 *     only passes its caller's value on); they are listed explicitly, and the spec pins that every
 *     entry still holds a site, so the list cannot go stale.
 *   - Attribution: a site under apps/<app>/src belongs to that app (its nx project name, the same
 *     namespace as services.yaml `application:`). A library site belongs to every app whose
 *     non-test source references the site's enclosing class, or a library `@Module` class that
 *     references it, closed over library modules (imports and re-exports do not count as
 *     references). Over-attribution only adds a waivable node; a library site no app wires is
 *     `unattributed`.
 *
 * `eventConsumersFor` is the one consumer-set function: the code sites for an event type, united
 * with the subscribe grants that name it (a grant is still the only source for a non-TypeScript
 * consumer); catch-all grants are returned separately as permissions.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import {
  aclEventRipple,
  eventSubjectsFor,
  filtersOverlap,
  type GrantMatch,
  type NatsServiceEntry,
} from './nats-services';

/** What a subscription's argument names: an event type (the bus builds the subject) or a subject. */
export type ConsumerValueKind = 'event_type' | 'subject';

/** One recognised subscription site, before attribution. */
export interface ScannedSite {
  /** Repo-relative path and 1-based line, e.g. `apps/x/src/y.ts:12`. */
  readonly site: string;
  readonly file: string;
  readonly api: string;
  readonly kind: ConsumerValueKind;
  /** The folded values, or null when the argument does not fold. */
  readonly values: readonly string[] | null;
  /** Source text of the argument (for unresolved reports). */
  readonly form: string;
  /** The enclosing method or function declaration, by name (null at top level). */
  readonly function: string | null;
  /** True when the site is one of FORWARDING_SITES (the bus's own plumbing). */
  readonly forwarding: boolean;
}

export interface EventConsumerEntry {
  readonly application: string;
  readonly kind: ConsumerValueKind;
  readonly value: string;
  readonly site: string;
  readonly api: string;
}

export interface UnresolvedConsumerSite {
  /** The owning application, or null for a library site. */
  readonly application: string | null;
  readonly site: string;
  readonly api: string;
  readonly form: string;
}

export interface EventConsumerIndex {
  readonly entries: readonly EventConsumerEntry[];
  readonly unresolved: readonly UnresolvedConsumerSite[];
  /** Library sites no application wires (dead code or a module nobody imports). */
  readonly unattributed: readonly string[];
  /** Every recognised site, forwarding sites included. */
  readonly sites: readonly ScannedSite[];
  readonly filesScanned: number;
}

/** The forwarding layers of the bus and the NATS transport: their subscribe passes a value on. */
export const FORWARDING_SITES: readonly { readonly file: string; readonly function: string }[] = [
  // subscribe -> subscribeWildcard -> subscribeTo, subscribeForTenant -> subscribeTo.
  { file: 'platform/libs/event-bus/src/nats/nats-event-bus.ts', function: 'subscribe' },
  { file: 'platform/libs/event-bus/src/nats/nats-event-bus.ts', function: 'subscribeWildcard' },
  { file: 'platform/libs/event-bus/src/nats/nats-event-bus.ts', function: 'subscribeForTenant' },
  // The registrar of @EventHandler / @SubscribeTo: the decorators are the sites.
  { file: 'platform/libs/event-bus/src/nats/nats.module.ts', function: 'registerEventHandlers' },
  // Request/reply responders (`respond()`): a command subject, not event consumption.
  {
    file: 'platform/libs/event-bus/src/nats/nats-request-reply.ts',
    function: 'createResponderSubscription',
  },
  // NestJS transport: @EventPattern / @MessagePattern are the sites; the client's reply inbox.
  { file: 'libs/backend-common/src/nats/nats-v3-server.strategy.ts', function: 'bindHandlers' },
  { file: 'libs/backend-common/src/nats/nats-v3-client.proxy.ts', function: 'publish' },
];

const SOURCE_ROOTS: readonly string[] = ['apps', 'libs', join('platform', 'libs')];
const CANDIDATE_TEXT = /\b(?:subscribe\w*|SubscribeTo|EventPattern|EventHandler)\s*\(/;
const EVENT_BUS_DECLARATION = /[\\/]platform[\\/]libs[\\/]event-bus[\\/]src[\\/]/;
const NATS_CLIENT_DECLARATION = /[\\/]node_modules[\\/](?:nats|@nats-io[\\/][^\\/]+)[\\/]/;
const NEST_MICROSERVICES_DECLARATION = /[\\/]node_modules[\\/]@nestjs[\\/]microservices[\\/]/;
const EVENT_BUS_METHODS: ReadonlyMap<string, ConsumerValueKind> = new Map([
  ['subscribe', 'event_type'],
  ['subscribeWildcard', 'event_type'],
  ['subscribeForTenant', 'event_type'],
  ['subscribeTo', 'subject'],
]);
const EVENT_BUS_DECORATORS: ReadonlyMap<string, ConsumerValueKind> = new Map([
  ['SubscribeTo', 'subject'],
  ['EventHandler', 'event_type'],
]);
/** Event-bus functions that turn an event type into its subject (`.map(builder)` folds to types). */
const SUBJECT_BUILDERS: ReadonlySet<string> = new Set([
  'buildWildcardEventSubject',
  'buildRoutedWildcardSubject',
]);
const MAX_FOLD_DEPTH = 8;

const toPosix = (path: string): string => path.split(sep).join('/');

function isTestFile(name: string): boolean {
  return /\.(?:spec|test|d)\.ts$/.test(name);
}

/** Non-test `.ts` files under `<repoRoot>/<base>/<pkg>/src` for every source root. */
function sourceFiles(repoRoot: string, bases: readonly string[]): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !isTestFile(entry.name)) {
        files.push(path);
      }
    }
  };
  for (const base of bases) {
    const baseDir = join(repoRoot, base);
    if (!existsSync(baseDir)) continue;
    for (const pkg of readdirSync(baseDir, { withFileTypes: true })) {
      const src = join(baseDir, pkg.name, 'src');
      if (pkg.isDirectory() && existsSync(src)) walk(src);
    }
  }
  return files.sort();
}

/** apps/<dir> -> its nx project name (project.json `name`, else the directory). */
function applicationNames(repoRoot: string): Map<string, string> {
  const names = new Map<string, string>();
  const appsDir = join(repoRoot, 'apps');
  if (!existsSync(appsDir)) return names;
  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let name = entry.name;
    const projectJson = join(appsDir, entry.name, 'project.json');
    if (existsSync(projectJson)) {
      const parsed: unknown = JSON.parse(readFileSync(projectJson, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null && 'name' in parsed) {
        const declared = parsed.name;
        if (typeof declared === 'string' && declared.length > 0) name = declared;
      }
    }
    names.set(entry.name, name);
  }
  return names;
}

function compilerOptions(repoRoot: string): ts.CompilerOptions {
  const base: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    experimentalDecorators: true,
    esModuleInterop: true,
  };
  const configPath = join(repoRoot, 'tsconfig.base.json');
  if (existsSync(configPath)) {
    const read = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
    if (read.error !== undefined) {
      throw new Error(
        `${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`,
      );
    }
    Object.assign(base, ts.parseJsonConfigFileContent(read.config, ts.sys, repoRoot).options);
  }
  // Only the checker is needed: no emit, no ambient type packages, no library checking.
  return { ...base, noEmit: true, skipLibCheck: true, types: [] };
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

interface Folded {
  readonly values: readonly string[];
  /** True when the values are event types recovered from `<types>.map(subjectBuilder)`. */
  readonly eventTypes: boolean;
}

const plain = (values: readonly string[]): Folded => ({ values, eventTypes: false });

/** Static values of subscription arguments, through the type checker (see the module header). */
class ValueFolder {
  constructor(private readonly checker: ts.TypeChecker) {}

  fold(expression: ts.Expression, depth = 0): Folded | null {
    if (depth > MAX_FOLD_DEPTH) return null;
    const node = unwrap(expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return plain([node.text]);
    }
    const typed = this.literalValues(this.checker.getTypeAtLocation(node));
    if (typed !== null) return plain(typed);
    if (ts.isTemplateExpression(node)) return this.foldTemplate(node, depth);
    if (ts.isConditionalExpression(node)) {
      const whenTrue = this.fold(node.whenTrue, depth + 1);
      const whenFalse = this.fold(node.whenFalse, depth + 1);
      if (whenTrue === null || whenFalse === null) return null;
      if (whenTrue.eventTypes !== whenFalse.eventTypes) return null;
      return { values: [...whenTrue.values, ...whenFalse.values], eventTypes: whenTrue.eventTypes };
    }
    if (ts.isIdentifier(node)) return this.foldIdentifier(node, depth);
    return null;
  }

  private literalValues(type: ts.Type): string[] | null {
    const parts = type.isUnion() ? type.types : [type];
    if (parts.length === 0) return null;
    const values: string[] = [];
    for (const part of parts) {
      if (!part.isStringLiteral()) return null;
      values.push(part.value);
    }
    return values;
  }

  private foldTemplate(node: ts.TemplateExpression, depth: number): Folded | null {
    let combos: string[] = [node.head.text];
    for (const span of node.templateSpans) {
      const part = this.fold(span.expression, depth + 1);
      if (part === null || part.eventTypes) return null;
      const next: string[] = [];
      for (const prefix of combos) {
        for (const value of part.values) next.push(`${prefix}${value}${span.literal.text}`);
      }
      combos = next;
    }
    return plain(combos);
  }

  private declarationOf(node: ts.Node): ts.Declaration | undefined {
    let symbol = this.checker.getSymbolAtLocation(node);
    if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
      symbol = this.checker.getAliasedSymbol(symbol);
    }
    return symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  }

  private foldIdentifier(node: ts.Identifier, depth: number): Folded | null {
    const declaration = this.declarationOf(node);
    if (declaration === undefined) return null;
    if (ts.isVariableDeclaration(declaration)) {
      const list = declaration.parent;
      if (ts.isVariableDeclarationList(list) && ts.isForOfStatement(list.parent)) {
        return this.iterate(list.parent.expression, depth + 1);
      }
      const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
      if (isConst && declaration.initializer !== undefined) {
        return this.fold(declaration.initializer, depth + 1);
      }
      return null;
    }
    if (ts.isParameter(declaration)) return this.foldParameter(declaration, depth + 1);
    return null;
  }

  /** The values an iterable yields (for-of, forEach). */
  iterate(expression: ts.Expression, depth: number): Folded | null {
    if (depth > MAX_FOLD_DEPTH) return null;
    const node = unwrap(expression);
    if (ts.isArrayLiteralExpression(node)) {
      const values: string[] = [];
      for (const element of node.elements) {
        const folded = ts.isSpreadElement(element)
          ? this.iterate(element.expression, depth + 1)
          : this.fold(element, depth + 1);
        if (folded === null || folded.eventTypes) return null;
        values.push(...folded.values);
      }
      return plain(values);
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      const target = node.arguments[0];
      if (ts.isIdentifier(callee.expression) && callee.expression.text === 'Object' && target) {
        if (callee.name.text === 'keys') return this.objectKeys(target);
        if (callee.name.text === 'values') return this.objectValues(target, depth);
        return null;
      }
      if (callee.name.text === 'map' && target !== undefined && this.isSubjectBuilder(target)) {
        const types = this.iterate(callee.expression, depth + 1);
        return types === null || types.eventTypes
          ? null
          : { values: types.values, eventTypes: true };
      }
    }
    const type = this.checker.getTypeAtLocation(node);
    if (this.checker.isTupleType(type)) {
      const elements = this.checker.getTypeArguments(type as ts.TypeReference);
      const values: string[] = [];
      for (const element of elements) {
        const literal = this.literalValues(element);
        if (literal === null) return null;
        values.push(...literal);
      }
      if (values.length > 0) return plain(values);
    } else if (this.checker.isArrayType(type)) {
      const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
      const literal = element === undefined ? null : this.literalValues(element);
      if (literal !== null) return plain(literal);
    }
    if (ts.isIdentifier(node)) {
      const declaration = this.declarationOf(node);
      if (
        declaration !== undefined &&
        ts.isVariableDeclaration(declaration) &&
        declaration.initializer !== undefined &&
        ts.isVariableDeclarationList(declaration.parent) &&
        (declaration.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        return this.iterate(declaration.initializer, depth + 1);
      }
    }
    return null;
  }

  private objectLiteralOf(target: ts.Expression): ts.ObjectLiteralExpression | null {
    const node = unwrap(target);
    if (ts.isObjectLiteralExpression(node)) return node;
    if (!ts.isIdentifier(node)) return null;
    const declaration = this.declarationOf(node);
    if (
      declaration === undefined ||
      !ts.isVariableDeclaration(declaration) ||
      declaration.initializer === undefined
    ) {
      return null;
    }
    const initializer = unwrap(declaration.initializer);
    return ts.isObjectLiteralExpression(initializer) ? initializer : null;
  }

  private propertyName(name: ts.PropertyName): string | null {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
      return name.text;
    }
    return null;
  }

  private objectKeys(target: ts.Expression): Folded | null {
    const type = this.checker.getTypeAtLocation(target);
    const hasIndex =
      this.checker.getIndexInfosOfType(type).length > 0 || type.getProperties().length === 0;
    if (!hasIndex) return plain(type.getProperties().map((property) => property.getName()));
    // Record<string, …>: the declared type has no keys; the const initializer has them.
    const literal = this.objectLiteralOf(target);
    if (literal === null) return null;
    const keys: string[] = [];
    for (const property of literal.properties) {
      if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) {
        return null;
      }
      const key = this.propertyName(property.name);
      if (key === null) return null;
      keys.push(key);
    }
    return plain(keys);
  }

  private objectValues(target: ts.Expression, depth: number): Folded | null {
    const literal = this.objectLiteralOf(target);
    if (literal === null) return null;
    const values: string[] = [];
    for (const property of literal.properties) {
      if (!ts.isPropertyAssignment(property)) return null;
      const folded = this.fold(property.initializer, depth + 1);
      if (folded === null || folded.eventTypes) return null;
      values.push(...folded.values);
    }
    return plain(values);
  }

  /** `buildWildcardEventSubject`, or `(type) => buildWildcardEventSubject(type)`. */
  private isSubjectBuilder(expression: ts.Expression): boolean {
    const node = unwrap(expression);
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      const [parameter] = node.parameters;
      if (node.parameters.length !== 1 || parameter === undefined) return false;
      let body: ts.Node = node.body;
      if (ts.isBlock(body)) {
        const [only] = body.statements;
        if (body.statements.length !== 1 || only === undefined || !ts.isReturnStatement(only)) {
          return false;
        }
        if (only.expression === undefined) return false;
        body = only.expression;
      }
      const call = ts.isExpression(body) ? unwrap(body) : body;
      return (
        ts.isCallExpression(call) &&
        call.arguments.length === 1 &&
        call.arguments[0] !== undefined &&
        ts.isIdentifier(unwrap(call.arguments[0])) &&
        ts.isIdentifier(parameter.name) &&
        (unwrap(call.arguments[0]) as ts.Identifier).text === parameter.name.text &&
        this.isSubjectBuilder(call.expression)
      );
    }
    if (!ts.isIdentifier(node) && !ts.isPropertyAccessExpression(node)) return false;
    const declaration = this.declarationOf(ts.isIdentifier(node) ? node : node.name);
    if (declaration === undefined || !ts.isFunctionDeclaration(declaration)) return false;
    const name = declaration.name?.text ?? '';
    return (
      SUBJECT_BUILDERS.has(name) && EVENT_BUS_DECLARATION.test(declaration.getSourceFile().fileName)
    );
  }

  /**
   * A parameter folds when its function cannot be called from another file (private member or
   * unexported function) and every call in its file passes a foldable argument; or when it is the
   * element parameter of a `forEach` / `map` callback over a foldable iterable.
   */
  private foldParameter(parameter: ts.ParameterDeclaration, depth: number): Folded | null {
    const fn = parameter.parent;
    const index = fn.parameters.indexOf(parameter);
    if (
      (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) &&
      index === 0 &&
      ts.isCallExpression(fn.parent) &&
      fn.parent.arguments[0] === fn &&
      ts.isPropertyAccessExpression(fn.parent.expression) &&
      ['forEach', 'map'].includes(fn.parent.expression.name.text)
    ) {
      return this.iterate(fn.parent.expression.expression, depth + 1);
    }
    if (!(ts.isMethodDeclaration(fn) || ts.isFunctionDeclaration(fn)) || fn.name === undefined) {
      return null;
    }
    const modifiers = ts.getCombinedModifierFlags(fn);
    const fileLocal = ts.isMethodDeclaration(fn)
      ? (modifiers & ts.ModifierFlags.Private) !== 0 || ts.isPrivateIdentifier(fn.name)
      : (modifiers & ts.ModifierFlags.Export) === 0;
    if (!fileLocal) return null;
    const target = this.checker.getSymbolAtLocation(fn.name);
    if (target === undefined) return null;
    const values: string[] = [];
    let calls = 0;
    let foldable = true;
    const visit = (node: ts.Node): void => {
      if (!foldable) return;
      if (ts.isCallExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name
          : node.expression;
        if (this.checker.getSymbolAtLocation(callee) === target) {
          calls += 1;
          const argument = node.arguments[index];
          const folded = argument === undefined ? null : this.fold(argument, depth + 1);
          if (folded === null || folded.eventTypes) foldable = false;
          else values.push(...folded.values);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.getSourceFile());
    return foldable && calls > 0 ? plain(values) : null;
  }
}

/** Name of the nearest enclosing method / function declaration (for FORWARDING_SITES). */
function enclosingFunctionName(node: ts.Node): string | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) {
      return current.name !== undefined && ts.isIdentifier(current.name) ? current.name.text : null;
    }
    if (ts.isConstructorDeclaration(current)) return 'constructor';
  }
  return null;
}

function enclosingClassName(node: ts.Node): string | null {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (ts.isClassDeclaration(current)) return current.name?.text ?? null;
  }
  return null;
}

/**
 * The declaration a callee resolves to, through the type checker: its name and the file that
 * declares it. Aliases (imports) are followed, so a re-export cannot hide the owner.
 */
function resolvedCallee(
  checker: ts.TypeChecker,
  callee: ts.Node,
): { readonly name: string; readonly file: string } | null {
  let symbol = checker.getSymbolAtLocation(callee);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = checker.getAliasedSymbol(symbol);
  }
  const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (symbol === undefined || declaration === undefined) return null;
  return { name: symbol.getName(), file: declaration.getSourceFile().fileName };
}

interface RawSite {
  readonly file: string;
  readonly line: number;
  readonly api: string;
  readonly kind: ConsumerValueKind;
  readonly argument: ts.Expression | undefined;
  readonly node: ts.Node;
}

/** The subscription sites of one source file, recognised by their resolved declarations. */
function sitesIn(sourceFile: ts.SourceFile, checker: ts.TypeChecker, file: string): RawSite[] {
  const sites: RawSite[] = [];
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text.startsWith('subscribe')
    ) {
      const callee = resolvedCallee(checker, node.expression.name);
      const busKind = callee === null ? undefined : EVENT_BUS_METHODS.get(callee.name);
      let api: string | null = null;
      let kind: ConsumerValueKind | null = null;
      if (callee !== null && busKind !== undefined && EVENT_BUS_DECLARATION.test(callee.file)) {
        api = `event-bus:${callee.name}`;
        kind = busKind;
      } else if (callee?.name === 'subscribe' && NATS_CLIENT_DECLARATION.test(callee.file)) {
        api = 'nats:subscribe';
        kind = 'subject';
      }
      if (api !== null && kind !== null) {
        const line = lineOf(node.expression.name);
        sites.push({ file, line, api, kind, argument: node.arguments[0], node });
      }
    }
    if (ts.isDecorator(node) && ts.isCallExpression(node.expression)) {
      const callee = resolvedCallee(checker, node.expression.expression);
      const busKind = callee === null ? undefined : EVENT_BUS_DECORATORS.get(callee.name);
      let kind: ConsumerValueKind | null = null;
      if (callee !== null && busKind !== undefined && EVENT_BUS_DECLARATION.test(callee.file)) {
        kind = busKind;
      } else if (
        callee?.name === 'EventPattern' &&
        NEST_MICROSERVICES_DECLARATION.test(callee.file)
      ) {
        kind = 'subject';
      }
      if (callee !== null && kind !== null) {
        let argument = node.expression.arguments[0];
        if (argument !== undefined && ts.isObjectLiteralExpression(argument)) {
          const key = callee.name === 'EventHandler' ? 'eventName' : 'topic';
          const property = argument.properties.find(
            (candidate): candidate is ts.PropertyAssignment =>
              ts.isPropertyAssignment(candidate) && candidate.name.getText(sourceFile) === key,
          );
          argument = property?.initializer;
        }
        sites.push({ file, line: lineOf(node), api: `@${callee.name}`, kind, argument, node });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/** Identifiers a file uses, outside import and export declarations. */
function referencedNames(path: string): Set<string> {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest);
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isImportEqualsDeclaration(node)) return;
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

interface LibraryModule {
  readonly name: string;
  readonly path: string;
}

/** Classes decorated with `@Module(` in library sources. */
function libraryModules(libraryFiles: readonly string[]): LibraryModule[] {
  const modules: LibraryModule[] = [];
  for (const path of libraryFiles) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('@Module(')) continue;
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name !== undefined) {
        const decorated = (ts.getDecorators(node) ?? []).some(
          (decorator) =>
            ts.isCallExpression(decorator.expression) &&
            decorator.expression.expression.getText(source) === 'Module',
        );
        if (decorated) modules.push({ name: node.name.text, path });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return modules;
}

/**
 * Applications that wire a library class: the class, closed over library `@Module` classes that
 * reference a member of the set, then every app whose non-test source references a member.
 */
class LibraryAttribution {
  private readonly references = new Map<string, Set<string>>();
  private modules: LibraryModule[] | null = null;

  constructor(
    private readonly libraryFiles: readonly string[],
    private readonly appFiles: ReadonlyMap<string, readonly string[]>,
  ) {}

  private namesIn(path: string): Set<string> {
    let names = this.references.get(path);
    if (names === undefined) {
      names = referencedNames(path);
      this.references.set(path, names);
    }
    return names;
  }

  applicationsWiring(className: string): string[] {
    this.modules ??= libraryModules(this.libraryFiles);
    const wired = new Set<string>([className]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const module of this.modules) {
        if (wired.has(module.name)) continue;
        const names = this.namesIn(module.path);
        if ([...wired].some((name) => names.has(name))) {
          wired.add(module.name);
          grew = true;
        }
      }
    }
    const applications: string[] = [];
    for (const [application, files] of this.appFiles) {
      const uses = files.some((path) => {
        const text = readFileSync(path, 'utf8');
        if (![...wired].some((name) => text.includes(name))) return false;
        const names = this.namesIn(path);
        return [...wired].some((name) => names.has(name));
      });
      if (uses) applications.push(application);
    }
    return applications.sort();
  }
}

function isForwarding(file: string, node: ts.Node): boolean {
  const name = enclosingFunctionName(node);
  return FORWARDING_SITES.some((entry) => entry.file === file && entry.function === name);
}

/** Order `path:line` sites by file, then by line as a number (`x.ts:8` before `x.ts:12`). */
export function compareSites(a: string, b: string): number {
  const [fileA = '', lineA = '0'] = a.split(/:(?=\d+$)/);
  const [fileB = '', lineB = '0'] = b.split(/:(?=\d+$)/);
  return fileA.localeCompare(fileB) || Number(lineA) - Number(lineB);
}

/** Scan `repoRoot`'s TypeScript sources for event consumers (see the module header). */
export function scanEventConsumers(repoRoot: string): EventConsumerIndex {
  const root = resolve(repoRoot);
  const allFiles = sourceFiles(root, SOURCE_ROOTS);
  const candidates = allFiles.filter((path) => CANDIDATE_TEXT.test(readFileSync(path, 'utf8')));
  const program = ts.createProgram(candidates, compilerOptions(root));
  const checker = program.getTypeChecker();
  const folder = new ValueFolder(checker);
  const appNames = applicationNames(root);

  const appOf = (file: string): string | null => {
    const match = /^apps\/([^/]+)\/src\//.exec(file);
    return match?.[1] === undefined ? null : (appNames.get(match[1]) ?? match[1]);
  };
  const appFiles = new Map<string, string[]>();
  const libraryFiles: string[] = [];
  for (const path of allFiles) {
    const application = appOf(toPosix(relative(root, path)));
    if (application === null) libraryFiles.push(path);
    else appFiles.set(application, [...(appFiles.get(application) ?? []), path]);
  }
  const attribution = new LibraryAttribution(libraryFiles, appFiles);

  const sites: ScannedSite[] = [];
  const entries: EventConsumerEntry[] = [];
  const unresolved: UnresolvedConsumerSite[] = [];
  const unattributed: string[] = [];
  for (const path of candidates) {
    const sourceFile = program.getSourceFile(path);
    if (sourceFile === undefined) throw new Error(`event-consumer-index: ${path} not in program`);
    const file = toPosix(relative(root, path));
    for (const raw of sitesIn(sourceFile, checker, file)) {
      const folded = raw.argument === undefined ? null : folder.fold(raw.argument);
      const kind = folded?.eventTypes === true ? 'event_type' : raw.kind;
      const site: ScannedSite = {
        site: `${file}:${raw.line}`,
        file,
        api: raw.api,
        kind,
        values: folded === null ? null : [...new Set(folded.values)].sort(),
        form: raw.argument?.getText(sourceFile) ?? '<no argument>',
        function: enclosingFunctionName(raw.node),
        forwarding: isForwarding(file, raw.node),
      };
      sites.push(site);
      if (site.forwarding) continue;
      const application = appOf(file);
      if (site.values === null) {
        unresolved.push({ application, site: site.site, api: site.api, form: site.form });
        continue;
      }
      let applications: string[];
      if (application !== null) applications = [application];
      else {
        const owner = enclosingClassName(raw.node);
        applications = owner === null ? [] : attribution.applicationsWiring(owner);
      }
      if (applications.length === 0) unattributed.push(site.site);
      for (const app of applications) {
        for (const value of site.values) {
          entries.push({ application: app, kind, value, site: site.site, api: site.api });
        }
      }
    }
  }
  const bySite = (a: { site: string }, b: { site: string }): number => compareSites(a.site, b.site);
  return {
    entries: entries.sort(
      (a, b) =>
        a.application.localeCompare(b.application) ||
        a.value.localeCompare(b.value) ||
        bySite(a, b),
    ),
    unresolved: unresolved.sort(bySite),
    unattributed: unattributed.sort(compareSites),
    sites: sites.sort(bySite),
    filesScanned: candidates.length,
  };
}

export type ConsumerSource = 'code_subscription' | 'acl_grant';

export interface ConsumerMatch {
  readonly application: string;
  readonly sources: readonly ConsumerSource[];
  /** Code sites (`path:line`) subscribing to the event, sorted. */
  readonly codeSites: readonly string[];
  /** The subscribe grant naming the event, when the SSoT holds one. */
  readonly acl: GrantMatch | null;
  /** The subscribed filter: the grant, else the code site's subject, else the event subject. */
  readonly matchingPattern: string;
  /** The event subject the consumer receives on. */
  readonly subject: string;
}

export interface EventConsumers {
  readonly subjects: readonly string[];
  readonly consumers: readonly ConsumerMatch[];
  /** Catch-all grants (`events.>`): permission to receive, not consumption; never consumers. */
  readonly aclCatchAll: readonly GrantMatch[];
}

/**
 * The one consumer set of an event type: code subscriptions (event-type equality, or a subscribed
 * subject overlapping one of the event's subjects) united with the subscribe grants that name the
 * event. Catch-all grants are returned apart.
 */
export function eventConsumersFor(
  eventType: string,
  index: EventConsumerIndex,
  services: readonly NatsServiceEntry[],
  subjects: readonly string[] = eventSubjectsFor(eventType, services).subjects,
): EventConsumers {
  // The bus subscribes an event type on the subject its route registry derives; tools cannot load
  // that registry, so an event-type match is reported on the event's first declared subject.
  const [defaultSubject] = subjects;
  if (defaultSubject === undefined) {
    throw new Error(`eventConsumersFor(${eventType}): an event travels on at least one subject`);
  }
  interface Draft {
    sources: Set<ConsumerSource>;
    codeSites: Set<string>;
    acl: GrantMatch | null;
    codePattern: string | null;
    subject: string;
  }
  const drafts = new Map<string, Draft>();
  const draftFor = (application: string, subject: string): Draft => {
    let draft = drafts.get(application);
    if (draft === undefined) {
      draft = { sources: new Set(), codeSites: new Set(), acl: null, codePattern: null, subject };
      drafts.set(application, draft);
    }
    return draft;
  };
  for (const entry of index.entries) {
    let subject: string | undefined;
    if (entry.kind === 'event_type') {
      if (entry.value === eventType) subject = defaultSubject;
    } else {
      subject = subjects.find((candidate) => filtersOverlap(entry.value, candidate));
    }
    if (subject === undefined) continue;
    const draft = draftFor(entry.application, subject);
    draft.sources.add('code_subscription');
    draft.codeSites.add(entry.site);
    if (entry.kind === 'subject') draft.codePattern ??= entry.value;
  }
  const aclCatchAll: GrantMatch[] = [];
  for (const grant of aclEventRipple(eventType, services, subjects).aclSubscribers) {
    if (grant.catchAll) {
      aclCatchAll.push(grant);
      continue;
    }
    const draft = draftFor(grant.service.application, grant.subject);
    draft.sources.add('acl_grant');
    draft.acl = grant;
    draft.subject = grant.subject;
  }
  const order: readonly ConsumerSource[] = ['code_subscription', 'acl_grant'];
  const consumers = [...drafts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([application, draft]): ConsumerMatch => ({
        application,
        sources: order.filter((source) => draft.sources.has(source)),
        codeSites: [...draft.codeSites].sort(compareSites),
        acl: draft.acl,
        matchingPattern: draft.acl?.grant ?? draft.codePattern ?? draft.subject,
        subject: draft.subject,
      }),
    );
  return { subjects, consumers, aclCatchAll };
}
