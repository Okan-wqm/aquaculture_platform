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
 *   - Candidates: tracked (`git ls-files`) non-test `.ts` under apps/<app>/src, libs/<lib>/src
 *     and platform/libs/<lib>/src whose text contains a subscription-shaped call (`subscribe…(`,
 *     `SubscribeTo(`, `EventPattern(`, `EventHandler(`). The text filter only bounds the program;
 *     it decides nothing. Everything a scan reads is the tree's tracked content (`TrackedTree`):
 *     the scans enumerate its tracked files, never the disk, and the type checker's compiler host
 *     (adapter-ts `containedCompilerHost`, the one host builder, given the tracked view) resolves
 *     imports only inside that tracked set, the workspace node_modules and the TypeScript lib
 *     directory. So an ignored or untracked file is never a source, never a module
 *     an import reaches, and an apps/<dir> with no tracked file is never an application; a
 *     symlink at any level of a tracked path is refused, never followed (`SourceTreeUnavailable`
 *     for a file a scan reads, an unresolved import for the checker).
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
 *
 * `scanEventProducers` is the one owner of "who produces event T" in code (service-expertise PLAN
 * §2, SE-3). Every event is built through `createBaseEvent` (the branded EventId makes it the only
 * construction path), so a producer site is a call the checker resolves to that declaration in
 * libs/event-contracts, whatever the callee is spelled. Its first argument is folded exactly as a
 * subscription value is; a value that does not fold is `unresolved`, never dropped. Attribution is
 * the consumers' rule, over-attribution included: a library site whose argument folds to a union
 * (the tenant-erasure executor's per-target outcome types) is a fact of every wiring app for every
 * member, a wrong fact tracked as ARIA-MEDIUM-792. ACL publish grants are permission, not
 * production, and are never read as producers. It is the owner, not yet the only reader: a
 * reader that keeps its own rule (the e2e NATS publish coverage, CONTRACT-MEDIUM-015) is listed
 * by its open finding in the single-owner pin (event-consumer-index.spec.ts), which reads every
 * tracked *.ts and *.py file, so a new one fails until it is folded or tracked.
 *
 * `--facts --repo-root <tree>` (`eventFacts`) is the code-fact bridge entry the kernel runs on a
 * diff's base tree (`K/plan_coverage.py` `compute_service_facts`): per application, the produced
 * and consumed event sites, code producer x code subscription edges, the services.yaml grants as
 * permission facts with their lines (never edges, SK-09), the NATS identity, and the event
 * definition sites in libs/event-contracts. A code subscription whose subject names no known event
 * type is listed under its application's `subjects_consumed`, never dropped. Each entry carries a
 * per-section `state`: an application without TypeScript sources (a Rust app) has its code
 * sections `unavailable:no_typescript_sources`, so its empty lists never read as "produces
 * nothing". Every input is the given tree's tracked content: its sources, applications,
 * services.yaml and tsconfig.base.json, and every module the checker resolves. A services.yaml its
 * schema refuses, or a tree the scans cannot read as its tracked content (a tracked symlink, an
 * untracked services.yaml, a project.json that is not JSON), exits 2 with nothing on
 * stdout and a message that names paths, never file content, so the kernel holds the change by
 * name instead of reading empty facts.
 *
 * Invoke via:
 *   ts-node --project tools/gates/tsconfig.json tools/gates/event-consumer-index.ts --facts --repo-root <tree>
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

import {
  containedWorkspace,
  type ContainedWorkspace,
  type WorkspaceEntry,
} from '../aria-adapters/adapter-fs';
import {
  containedCompilerHost,
  type InTreeView,
  type TrackedContent,
} from '../aria-adapters/adapter-ts';

import { hermeticGitEnv } from './hermetic-git';
import {
  aclEventRipple,
  eventSubjectsFor,
  filtersOverlap,
  type GrantMatch,
  loadNatsServicesLocated,
  NATS_SERVICES_YAML,
  type NatsServiceEntry,
  NatsServicesInvalid,
  type NatsServiceSourceLines,
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
/** The one event constructor (libs/event-contracts/src/base-event.ts) and where it is declared. */
const EVENT_CONSTRUCTOR = 'createBaseEvent';
const EVENT_CONTRACTS_DECLARATION = /[\\/]libs[\\/]event-contracts[\\/]src[\\/]/;
const PRODUCER_CANDIDATE_TEXT = /\bcreateBaseEvent\b/;
/** The event-contracts source tree: the one place event types are defined (CLAUDE.md, ADR-006). */
export const EVENT_CONTRACTS_ROOT = 'libs/event-contracts/src';

const toPosix = (path: string): string => path.split(sep).join('/');

function isTestFile(name: string): boolean {
  return /\.(?:spec|test|d)\.ts$/.test(name);
}

/**
 * The tree a scan reads cannot be read as its tracked content: git cannot list it, or a tracked
 * file the scan reads is not a regular file (a symlink is refused, never followed) or, for a
 * project.json, not JSON. Both `--facts` entries exit 2 on it by name. The message names paths,
 * never file content, because the kernel copies the entry's stderr into its hold record.
 */
export class SourceTreeUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceTreeUnavailable';
  }
}

/** `git -C <root> <args>` with no inherited GIT_* variable; its NUL-separated output. */
function gitPaths(root: string, args: readonly string[]): string[] {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    env: hermeticGitEnv(),
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error !== undefined || result.status !== 0) {
    const reason = result.error?.message ?? `exit ${String(result.status)}`;
    throw new SourceTreeUnavailable(`${root}: git ${args[0] ?? ''} failed (${reason})`);
  }
  return result.stdout.split('\0').filter((path) => path.length > 0);
}

/**
 * The tracked content of one tree: the one enumeration every scan, the SE-1 key reader, the type
 * checker's view and the module entry read (SE-3-R2 corrective R1 and round-2 RB).
 *
 * `paths` are the files of the tree's index that are present in the work tree (`git ls-files`
 * minus deleted files, with no inherited GIT_* variable), repo-relative and posix. A path is read
 * only when it is in `paths` and the containment owner (adapter-fs `containedWorkspace`, whose
 * component walk classifies with the one lstat classifier `entryKindAt`) finds it a regular file
 * reached through real directories: a symlink at any level is refused, never followed. So an
 * ignored or untracked file, an empty directory, an apps/<dir> holding only ignored files, a
 * module behind a symlinked directory or at an absolute path is never a source, an application or
 * a module the checker resolves (the checker reads the tree through the tracked view of adapter-ts
 * `containedCompilerHost`, SE-3-R2 appellate RC). On the kernel's clean base checkout the index is
 * the base commit and the disk is its content (`K/plan_coverage.py` `_base_tree_error`), so every
 * fact is the base's. A subdirectory of a work tree lists its own tracked files, so a committed
 * fixture tree reads as a tree.
 */
export class TrackedTree implements TrackedContent {
  readonly root: string;
  readonly paths: ReadonlySet<string>;
  /** Every directory that holds a tracked path, repo-relative ('' is the root). */
  private readonly directories: ReadonlySet<string>;
  private readonly workspace: ContainedWorkspace;
  /** The containment owner's answer per path, asked once. */
  private readonly entries = new Map<string, WorkspaceEntry>();

  constructor(repoRoot: string) {
    this.root = resolve(repoRoot);
    const deleted = new Set(gitPaths(this.root, ['ls-files', '-z', '--deleted']));
    this.paths = new Set(
      gitPaths(this.root, ['ls-files', '-z', '--cached']).filter((path) => !deleted.has(path)),
    );
    const directories = new Set<string>(['']);
    for (const path of this.paths) {
      const segments = path.split('/');
      for (let depth = 1; depth < segments.length; depth += 1) {
        directories.add(segments.slice(0, depth).join('/'));
      }
    }
    this.directories = directories;
    this.workspace = containedWorkspace(this.root);
  }

  /** What a repo-relative path is on disk, every component checked without following it. */
  private entryOf(path: string): WorkspaceEntry {
    const known = this.entries.get(path);
    if (known !== undefined) return known;
    const entry = this.workspace.entry(path);
    this.entries.set(path, entry);
    return entry;
  }

  /** `path` is tracked and a regular file reached through real directories only. */
  holdsFile(path: string): boolean {
    return this.paths.has(path) && this.entryOf(path) === 'file';
  }

  /** `path` holds a tracked path and is a real directory reached through real directories. */
  holdsDirectory(path: string): boolean {
    return path === '' || (this.directories.has(path) && this.entryOf(path) === 'directory');
  }

  /** The absolute path of a tracked regular file; anything else is SourceTreeUnavailable. */
  file(path: string): string {
    if (!this.paths.has(path)) {
      throw new SourceTreeUnavailable(`${path} is not a tracked file of ${this.root}`);
    }
    if (this.entryOf(path) !== 'file') {
      throw new SourceTreeUnavailable(
        `${path} is not a regular file; a tracked symlink is refused, never followed`,
      );
    }
    return join(this.root, path);
  }
}

/** The tracked content of the tree at `repoRoot` (see `TrackedTree`). */
export function trackedTree(repoRoot: string): TrackedTree {
  return new TrackedTree(repoRoot);
}

/** The type checker's view of a tree: its tracked content and the installed toolchain only. */
function trackedView(tree: TrackedTree): InTreeView {
  return { kind: 'tracked', tree };
}

const SOURCE_FILE = /^(?:apps|libs|platform\/libs)\/[^/]+\/src\/(?:.+\/)?[^/]+\.ts$/;

/** A tracked path is a source: a non-test `.ts` file under `<base>/<pkg>/src` of a source root. */
function isSourcePath(path: string): boolean {
  if (!SOURCE_FILE.test(path)) return false;
  const segments = path.split('/');
  const name = segments[segments.length - 1] ?? '';
  return !(isTestFile(name) || segments.includes('node_modules') || segments.includes('__tests__'));
}

/** The tree's tracked paths that `admits`, as absolute paths of regular files, sorted. */
function trackedFiles(tree: TrackedTree, admits: (path: string) => boolean): string[] {
  return [...tree.paths]
    .filter(admits)
    .map((path) => tree.file(path))
    .sort();
}

/** Non-test tracked `.ts` files under `<base>/<pkg>/src` for every source root, absolute. */
function sourceFiles(tree: TrackedTree): string[] {
  return trackedFiles(tree, isSourcePath);
}

/**
 * The files event types are defined in: the tree's sources under EVENT_CONTRACTS_ROOT, absolute
 * and sorted. The one selection rule the one definition rule (`eventDefinitionsIn`) reads over,
 * for the code facts, `scanEventDefinitions` and the event-contracts adapter alike (SE-3-R2
 * appellate R2-A), so the three answer one set of definitions on every tree.
 */
export function eventContractFiles(tree: TrackedTree): string[] {
  return trackedFiles(
    tree,
    (path) => isSourcePath(path) && path.startsWith(`${EVENT_CONTRACTS_ROOT}/`),
  );
}

/**
 * apps/<dir> -> its nx project name (project.json `name`, else the directory): the one TypeScript
 * reader of the SE-1 service key. An application is a directory under apps/ holding a tracked
 * file; its project.json is read only when tracked and a regular file. The module entry of the
 * code-fact bridge (tools/aria-adapters/module-schemas-source.ts) resolves its owners through it
 * too, so both entries key services in one vocabulary. Throws SourceTreeUnavailable when the tree
 * cannot be read this way.
 */
export function applicationNames(tree: TrackedTree): Map<string, string> {
  const directories = new Set<string>();
  for (const path of tree.paths) {
    const match = /^apps\/([^/]+)\/./.exec(path);
    if (match?.[1] !== undefined) directories.add(match[1]);
  }
  const names = new Map<string, string>();
  for (const directory of [...directories].sort()) {
    let name = directory;
    const projectJson = `apps/${directory}/project.json`;
    if (tree.paths.has(projectJson)) {
      const text = readFileSync(tree.file(projectJson), 'utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        // Node's message quotes the text it could not parse: name the file, never its content.
        if (!(error instanceof SyntaxError)) throw error;
        throw new SourceTreeUnavailable(`${projectJson} is not valid JSON`);
      }
      if (typeof parsed === 'object' && parsed !== null && 'name' in parsed) {
        const declared = parsed.name;
        if (typeof declared === 'string' && declared.length > 0) name = declared;
      }
    }
    names.set(directory, name);
  }
  return names;
}

/** The tracked TypeScript sources and the applications of one tree, read once per scan. */
interface SourceTree {
  readonly tracked: TrackedTree;
  readonly root: string;
  /** Absolute paths of the non-test tracked sources (`sourceFiles`). */
  readonly files: readonly string[];
  /** apps/<dir> -> nx project name (`applicationNames`). */
  readonly applications: ReadonlyMap<string, string>;
}

function sourceTree(tracked: TrackedTree): SourceTree {
  return {
    tracked,
    root: tracked.root,
    files: sourceFiles(tracked),
    applications: applicationNames(tracked),
  };
}

const TSCONFIG_BASE = 'tsconfig.base.json';

/** The checker's options: the tree's tracked tsconfig.base.json, read through the tracked view. */
function compilerOptions(tree: TrackedTree): ts.CompilerOptions {
  const base: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    experimentalDecorators: true,
    esModuleInterop: true,
  };
  if (tree.paths.has(TSCONFIG_BASE)) {
    const configPath = tree.file(TSCONFIG_BASE);
    // The config and its `extends` chain are read through the checker's own view.
    const host = containedCompilerHost(trackedView(tree), base);
    const read = ts.readConfigFile(configPath, (path) => host.readFile(path));
    if (read.error !== undefined) {
      throw new Error(
        `${configPath}: ${ts.flattenDiagnosticMessageText(read.error.messageText, '\n')}`,
      );
    }
    // The file list is not used.
    const parseHost: ts.ParseConfigHost = {
      useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
      readDirectory: () => [],
      fileExists: (path) => host.fileExists(path),
      readFile: (path) => host.readFile(path),
    };
    Object.assign(base, ts.parseJsonConfigFileContent(read.config, parseHost, tree.root).options);
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

/** The values of a string-literal type or a union of them; null for any other type. */
function stringLiteralValues(type: ts.Type): string[] | null {
  const parts = type.isUnion() ? type.types : [type];
  if (parts.length === 0) return null;
  const values: string[] = [];
  for (const part of parts) {
    if (!part.isStringLiteral()) return null;
    values.push(part.value);
  }
  return values;
}

/** Static values of subscription arguments, through the type checker (see the module header). */
class ValueFolder {
  constructor(private readonly checker: ts.TypeChecker) {}

  fold(expression: ts.Expression, depth = 0): Folded | null {
    if (depth > MAX_FOLD_DEPTH) return null;
    const node = unwrap(expression);
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return plain([node.text]);
    }
    const typed = stringLiteralValues(this.checker.getTypeAtLocation(node));
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
        const literal = stringLiteralValues(element);
        if (literal === null) return null;
        values.push(...literal);
      }
      if (values.length > 0) return plain(values);
    } else if (this.checker.isArrayType(type)) {
      const element = this.checker.getIndexTypeOfType(type, ts.IndexKind.Number);
      const literal = element === undefined ? null : stringLiteralValues(element);
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

/**
 * One type-checked view of the repository's TypeScript sources, shared by the consumer scan, the
 * producer scan and the event definitions: the program over the given candidate files, the value
 * folder, and attribution of a site to the applications it runs in.
 */
class SourceScan {
  readonly root: string;
  readonly allFiles: readonly string[];
  readonly program: ts.Program;
  readonly checker: ts.TypeChecker;
  readonly folder: ValueFolder;
  /** apps/<dir> -> nx project name, for every application directory. */
  readonly applications: ReadonlyMap<string, string>;
  private readonly attribution: LibraryAttribution;

  /** `programFiles` are the absolute files (of `tree.files`) the checker is built over. */
  constructor(tree: SourceTree, programFiles: readonly string[]) {
    this.root = tree.root;
    this.allFiles = tree.files;
    const options = compilerOptions(tree.tracked);
    this.program = ts.createProgram({
      rootNames: [...programFiles],
      options,
      host: containedCompilerHost(trackedView(tree.tracked), options),
    });
    this.checker = this.program.getTypeChecker();
    this.folder = new ValueFolder(this.checker);
    this.applications = tree.applications;
    const appFiles = new Map<string, string[]>();
    const libraryFiles: string[] = [];
    for (const path of this.allFiles) {
      const application = this.appOf(this.relative(path));
      if (application === null) libraryFiles.push(path);
      else appFiles.set(application, [...(appFiles.get(application) ?? []), path]);
    }
    this.attribution = new LibraryAttribution(libraryFiles, appFiles);
  }

  relative(path: string): string {
    return toPosix(relative(this.root, path));
  }

  /** The application owning a repo-relative file under apps/<app>/src, else null (a library). */
  appOf(file: string): string | null {
    const match = /^apps\/([^/]+)\/src\//.exec(file);
    return match?.[1] === undefined ? null : (this.applications.get(match[1]) ?? match[1]);
  }

  /** The applications a site runs in: its own app, else every app wiring its library class. */
  applicationsFor(file: string, node: ts.Node): string[] {
    const application = this.appOf(file);
    if (application !== null) return [application];
    const owner = enclosingClassName(node);
    return owner === null ? [] : this.attribution.applicationsWiring(owner);
  }

  sourceFile(path: string): ts.SourceFile {
    const sourceFile = this.program.getSourceFile(path);
    if (sourceFile === undefined) throw new Error(`event-consumer-index: ${path} not in program`);
    return sourceFile;
  }
}

const textMatches =
  (pattern: RegExp) =>
  (path: string): boolean =>
    pattern.test(readFileSync(path, 'utf8'));

const bySite = (a: { site: string }, b: { site: string }): number => compareSites(a.site, b.site);

/** The consumer index of the candidate files of `scan` (see the module header). */
function consumerIndex(scan: SourceScan, candidates: readonly string[]): EventConsumerIndex {
  const sites: ScannedSite[] = [];
  const entries: EventConsumerEntry[] = [];
  const unresolved: UnresolvedConsumerSite[] = [];
  const unattributed: string[] = [];
  for (const path of candidates) {
    const sourceFile = scan.sourceFile(path);
    const file = scan.relative(path);
    for (const raw of sitesIn(sourceFile, scan.checker, file)) {
      const folded = raw.argument === undefined ? null : scan.folder.fold(raw.argument);
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
      if (site.values === null) {
        unresolved.push({
          application: scan.appOf(file),
          site: site.site,
          api: site.api,
          form: site.form,
        });
        continue;
      }
      const applications = scan.applicationsFor(file, raw.node);
      if (applications.length === 0) unattributed.push(site.site);
      for (const app of applications) {
        for (const value of site.values) {
          entries.push({ application: app, kind, value, site: site.site, api: site.api });
        }
      }
    }
  }
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

/** Scan `repoRoot`'s TypeScript sources for event consumers (see the module header). */
export function scanEventConsumers(repoRoot: string): EventConsumerIndex {
  const tree = sourceTree(trackedTree(repoRoot));
  const candidates = tree.files.filter(textMatches(CANDIDATE_TEXT));
  return consumerIndex(new SourceScan(tree, candidates), candidates);
}

/** One event construction site, attributed to an application. */
export interface EventProducerEntry {
  readonly application: string;
  readonly eventType: string;
  readonly site: string;
}

export interface UnresolvedProducerSite {
  /** The owning application, or null for a library site. */
  readonly application: string | null;
  readonly site: string;
  readonly form: string;
}

/** One recognised event construction site, before attribution. */
export interface ProducerSite {
  readonly site: string;
  /** The folded event types, or null when the argument does not fold (then also `unresolved`). */
  readonly eventTypes: readonly string[] | null;
}

export interface EventProducerIndex {
  readonly entries: readonly EventProducerEntry[];
  /** Every recognised construction site, attributed or not, with its event types. */
  readonly sites: readonly ProducerSite[];
  readonly unresolved: readonly UnresolvedProducerSite[];
  /** Library construction sites no application wires. */
  readonly unattributed: readonly string[];
  readonly filesScanned: number;
}

/** A `createBaseEvent(` call, by its resolved declaration in libs/event-contracts. */
function producerSitesIn(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): { readonly line: number; readonly call: ts.CallExpression }[] {
  const sites: { readonly line: number; readonly call: ts.CallExpression }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      // An identifier callee may be an import alias of the constructor; a property callee is a
      // namespace import (`contracts.createBaseEvent`). The declaration decides, not the name.
      const callee = ts.isPropertyAccessExpression(node.expression)
        ? node.expression.name
        : node.expression;
      const candidate =
        ts.isIdentifier(callee) &&
        (!ts.isPropertyAccessExpression(node.expression) || callee.text === EVENT_CONSTRUCTOR);
      const resolved = candidate ? resolvedCallee(checker, callee) : null;
      if (resolved?.name === EVENT_CONSTRUCTOR && EVENT_CONTRACTS_DECLARATION.test(resolved.file)) {
        const line =
          sourceFile.getLineAndCharacterOfPosition(node.expression.getStart(sourceFile)).line + 1;
        sites.push({ line, call: node });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/** The producer index of the candidate files of `scan`. */
function producerIndex(scan: SourceScan, candidates: readonly string[]): EventProducerIndex {
  const entries: EventProducerEntry[] = [];
  const sites: ProducerSite[] = [];
  const unresolved: UnresolvedProducerSite[] = [];
  const unattributed: string[] = [];
  for (const path of candidates) {
    const sourceFile = scan.sourceFile(path);
    const file = scan.relative(path);
    for (const { line, call } of producerSitesIn(sourceFile, scan.checker)) {
      const site = `${file}:${line}`;
      const [argument] = call.arguments;
      const folded = argument === undefined ? null : scan.folder.fold(argument);
      if (folded === null || folded.eventTypes) {
        sites.push({ site, eventTypes: null });
        unresolved.push({
          application: scan.appOf(file),
          site,
          form: argument?.getText(sourceFile) ?? '<no argument>',
        });
        continue;
      }
      const eventTypes = [...new Set(folded.values)].sort();
      sites.push({ site, eventTypes });
      const applications = scan.applicationsFor(file, call);
      if (applications.length === 0) unattributed.push(site);
      for (const application of applications) {
        for (const eventType of eventTypes) {
          entries.push({ application, eventType, site });
        }
      }
    }
  }
  return {
    entries: entries.sort(
      (a, b) =>
        a.application.localeCompare(b.application) ||
        a.eventType.localeCompare(b.eventType) ||
        bySite(a, b),
    ),
    sites: sites.sort(bySite),
    unresolved: unresolved.sort(bySite),
    unattributed: unattributed.sort(compareSites),
    filesScanned: candidates.length,
  };
}

/**
 * Scan `repoRoot`'s TypeScript sources for event producers: the one owner of "who produces event
 * T" in code (service-expertise PLAN §2). An event is built through `createBaseEvent` (the branded
 * EventId makes it the construction path), so a producer site is a call that resolves to that
 * declaration. Its event type is the folded first argument, with the same folding as consumer
 * values; a value that does not fold is `unresolved`, never dropped. A library site belongs to the
 * apps that wire its class, as for consumers (a union-typed library site over-attributes,
 * ARIA-MEDIUM-792). ACL publish grants are permission, not production. Readers that still keep
 * their own rule are listed by open finding in the single-owner pin (CONTRACT-MEDIUM-015).
 */
export function scanEventProducers(repoRoot: string): EventProducerIndex {
  const tree = sourceTree(trackedTree(repoRoot));
  const candidates = tree.files.filter(textMatches(PRODUCER_CANDIDATE_TEXT));
  return producerIndex(new SourceScan(tree, candidates), candidates);
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
 * The subject on which a code subscription consumes `eventType` (whose subjects are `subjects`),
 * or undefined when it does not: an event-type subscription names the type itself, and the bus
 * subscribes it on the event's first declared subject (tools cannot load the bus's route registry);
 * a subject subscription consumes the event when its filter overlaps one of the event's subjects.
 * The one matching rule of `eventConsumersFor` and of the facts entry's subject-only sites.
 */
function consumedSubject(
  entry: EventConsumerEntry,
  eventType: string,
  subjects: readonly string[],
): string | undefined {
  if (entry.kind === 'event_type') return entry.value === eventType ? subjects[0] : undefined;
  return subjects.find((candidate) => filtersOverlap(entry.value, candidate));
}

/**
 * The one consumer set of an event type: code subscriptions (`consumedSubject`) united with the
 * subscribe grants that name the event. Catch-all grants are returned apart.
 */
export function eventConsumersFor(
  eventType: string,
  index: EventConsumerIndex,
  services: readonly NatsServiceEntry[],
  subjects: readonly string[] = eventSubjectsFor(eventType, services).subjects,
): EventConsumers {
  if (subjects.length === 0) {
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
    const subject = consumedSubject(entry, eventType, subjects);
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

// --- The code-fact bridge (`--facts`, service-expertise PLAN §3.2, §8 SE-3) ----------------------

/** An event type and the code line that names it: a production, consumption or definition site. */
export interface EventSiteFact {
  readonly event_type: string;
  readonly site: string;
}

/** A code producer x code subscription edge between two applications; `ref` is the producer site. */
export interface EventEdgeFact {
  readonly kind: 'event';
  readonly to: string;
  readonly subject: string;
  readonly ref: string;
  /** The first subscription site of `to` for the event. */
  readonly to_ref: string;
}

/**
 * A code subscription whose subject names no event type the tree knows (no definition, producer or
 * event-type subscription matches it), e.g. `events.security.events.auth.login.*`. It is still a
 * consumption fact of its application, with its site; it can be the target of no edge.
 */
export interface SubjectSiteFact {
  readonly subject: string;
  readonly site: string;
}

/** A services.yaml grant: permission to publish or receive, never an edge (SK-09). */
export interface AclGrantFact {
  readonly subject: string;
  readonly direction: 'publish' | 'subscribe';
  readonly ref: string;
}

/** Whether a section of a service's facts was read: an empty list is "nothing", not "unknown". */
export type SectionState = 'available' | `unavailable:${string}`;

/**
 * The state of the code sections of an application the TypeScript scan cannot read: one with no
 * TypeScript source under apps/<dir>/src (sensor-ingestion is Rust). Its empty code lists mean
 * "not read", never "produces and consumes nothing" (PLAN §3.1).
 */
export const NO_TYPESCRIPT_SOURCES: SectionState = 'unavailable:no_typescript_sources';

export interface ServiceFactsState {
  readonly events_produced: SectionState;
  readonly events_consumed: SectionState;
  readonly subjects_consumed: SectionState;
  readonly edges: SectionState;
  readonly acl_grants: SectionState;
  readonly nats_identity: SectionState;
}

export interface ServiceEventFacts {
  readonly service: string;
  readonly events_produced: readonly EventSiteFact[];
  readonly events_consumed: readonly EventSiteFact[];
  /** Code subscriptions to subjects that name no known event type; never dropped. */
  readonly subjects_consumed: readonly SubjectSiteFact[];
  readonly edges: readonly EventEdgeFact[];
  readonly acl_grants: readonly AclGrantFact[];
  /** The certificate identity whose services.yaml `application` is this service, or null. */
  readonly nats_identity: { readonly name: string; readonly ref: string } | null;
  /** Per section: read (`available`) or not read, with the reason. */
  readonly state: ServiceFactsState;
}

/** A defined event type (`eventDefinitionsIn`), at the line of its interface's `eventType` member. */
export interface EventDefinitionFact extends EventSiteFact {
  /** The event contract interface that defines it. */
  readonly declaration: string;
}

export interface EventFacts {
  readonly schema: 'aria/event_facts/v1';
  /** One entry per application (nx project under apps/); a library is never a service. */
  readonly services: readonly ServiceEventFacts[];
  readonly event_definitions: readonly EventDefinitionFact[];
  /** Sites whose event type or subject does not fold: an unknown fact, reported by name. */
  readonly unresolved: {
    readonly produced: readonly UnresolvedProducerSite[];
    readonly consumed: readonly UnresolvedConsumerSite[];
  };
  /** Library sites no application wires. */
  readonly unattributed: {
    readonly produced: readonly string[];
    readonly consumed: readonly string[];
  };
  /** services.yaml identities whose `application` is no directory under apps/ (a script, a tool). */
  readonly nats_identities_without_application: readonly {
    readonly name: string;
    readonly application: string;
    readonly ref: string;
  }[];
}

/** Where `BaseEvent`, the root of every event contract, is declared. */
const BASE_EVENT_DECLARATION = /[\\/]libs[\\/]event-contracts[\\/]src[\\/]base-event\.ts$/;

/** One event definition: an event contract interface and the event types it defines. */
export interface EventDefinitionDeclaration {
  /** The interface name. */
  readonly declaration: string;
  /** The 1-based line of the interface declaration. */
  readonly line: number;
  /** The 1-based line of its own `eventType` member, or null when it declares none. */
  readonly memberLine: number | null;
  /** The string-literal values of that member's type; empty when it has none (a shared base). */
  readonly eventTypes: readonly string[];
}

/** True when `type` has BaseEvent among its base types, directly or through other interfaces. */
function extendsBaseEvent(
  checker: ts.TypeChecker,
  type: ts.InterfaceType,
  seen: Set<ts.Type> = new Set(),
): boolean {
  for (const base of checker.getBaseTypes(type)) {
    const target =
      (base.flags & ts.TypeFlags.Object) !== 0 &&
      ((base as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) !== 0
        ? (base as ts.TypeReference).target
        : base;
    if (seen.has(target)) continue;
    seen.add(target);
    const symbol = target.getSymbol();
    if (
      symbol?.getName() === 'BaseEvent' &&
      (symbol.getDeclarations() ?? []).some((declaration) =>
        BASE_EVENT_DECLARATION.test(declaration.getSourceFile().fileName),
      )
    ) {
      return true;
    }
    if (target.isClassOrInterface() && extendsBaseEvent(checker, target, seen)) return true;
  }
  return false;
}

/**
 * The one rule for "where is event T defined" (SE-3 review round 1, single-owner B2). An event
 * definition is an interface declared in libs/event-contracts/src whose type has `BaseEvent`
 * (libs/event-contracts/src/base-event.ts) among its base types, directly or through other
 * interfaces, as the type checker resolves them; the event types it defines are the
 * string-literal values of its own `eventType` member, read through the checker, so an alias or a
 * union names each value. An interface that merely carries an `eventType` literal (a validator
 * catalog's shape under schemas/, a registry row, a resolution record) is not a definition, and
 * neither is a type literal. A base interface with no literal `eventType` is returned with no
 * event types. The code-fact entry's `event_definitions`, the event-contracts adapter's
 * `event_interface` observations and the emit-has-interface invariant read this function. Readers
 * that still keep their own rule are each tracked by an open finding and listed by it in the
 * single-owner pin (event-consumer-index.spec.ts): the plan-coverage witness
 * (ARIA-MEDIUM-793), the PII crypto-shred and feeding invariants (CONTRACT-MEDIUM-016),
 * recursive_impact (ARIA-MEDIUM-794, its F0.9b tombstone) and the e2e NATS invariant
 * (CONTRACT-MEDIUM-015).
 */
export function eventDefinitionsIn(
  sourceFile: ts.SourceFile,
  checker: ts.TypeChecker,
): EventDefinitionDeclaration[] {
  if (!EVENT_CONTRACTS_DECLARATION.test(sourceFile.fileName)) return [];
  const lineOf = (node: ts.Node): number =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const definitions: EventDefinitionDeclaration[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      const type = symbol === undefined ? undefined : checker.getDeclaredTypeOfSymbol(symbol);
      if (type !== undefined && type.isClassOrInterface() && extendsBaseEvent(checker, type)) {
        const member = node.members.find(
          (candidate): candidate is ts.PropertySignature =>
            ts.isPropertySignature(candidate) &&
            candidate.type !== undefined &&
            (ts.isIdentifier(candidate.name) || ts.isStringLiteral(candidate.name)) &&
            candidate.name.text === 'eventType',
        );
        const values =
          member?.type === undefined
            ? null
            : stringLiteralValues(checker.getTypeFromTypeNode(member.type));
        definitions.push({
          declaration: node.name.text,
          line: lineOf(node),
          memberLine: member === undefined ? null : lineOf(member),
          eventTypes: values ?? [],
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return definitions;
}

/** The event definitions of the given files, one fact per defined event type, at its member line. */
function eventDefinitions(scan: SourceScan, files: readonly string[]): EventDefinitionFact[] {
  const definitions: EventDefinitionFact[] = [];
  for (const path of files) {
    const file = scan.relative(path);
    for (const definition of eventDefinitionsIn(scan.sourceFile(path), scan.checker)) {
      for (const eventType of definition.eventTypes) {
        definitions.push({
          event_type: eventType,
          site: `${file}:${definition.memberLine ?? definition.line}`,
          declaration: definition.declaration,
        });
      }
    }
  }
  return definitions.sort((a, b) => a.event_type.localeCompare(b.event_type) || bySite(a, b));
}

/**
 * The event definitions of `repoRoot` (`eventDefinitionsIn` over `eventContractFiles`), for a
 * reader that needs only them, such as the emit-has-interface invariant.
 */
export function scanEventDefinitions(repoRoot: string): EventDefinitionFact[] {
  const tracked = trackedTree(repoRoot);
  const contractFiles = eventContractFiles(tracked);
  return eventDefinitions(new SourceScan(sourceTree(tracked), contractFiles), contractFiles);
}

const NATS_SERVICES_REF = toPosix(NATS_SERVICES_YAML);

/**
 * The code facts of the tree at `repoRoot`, per application: produced and consumed event sites,
 * code x code edges, ACL grants as permission facts, the NATS identity, and the event definition
 * sites. Every input is read from `repoRoot` (the diff's base tree), so the facts are the tree's
 * own; nothing is written. A services.yaml the SSoT refuses throws NatsServicesInvalid.
 */
export function eventFacts(repoRoot: string): EventFacts {
  const tracked = trackedTree(repoRoot);
  const nats = loadNatsServicesLocated(tracked.file(NATS_SERVICES_REF));
  const tree = sourceTree(tracked);
  const allFiles = tree.files;
  const consumerFiles = allFiles.filter(textMatches(CANDIDATE_TEXT));
  const producerFiles = allFiles.filter(textMatches(PRODUCER_CANDIDATE_TEXT));
  const contractFiles = eventContractFiles(tracked);
  // One program serves the three readings, so the checker is built once.
  const scan = new SourceScan(tree, [
    ...new Set([...consumerFiles, ...producerFiles, ...contractFiles]),
  ]);
  const consumers = consumerIndex(scan, consumerFiles);
  const producers = producerIndex(scan, producerFiles);
  const definitions = eventDefinitions(scan, contractFiles);

  const services = [...new Set(scan.applications.values())].sort();
  const eventTypes = new Set<string>([
    ...definitions.map((definition) => definition.event_type),
    ...producers.entries.map((entry) => entry.eventType),
    ...consumers.entries.filter((entry) => entry.kind === 'event_type').map((entry) => entry.value),
  ]);
  const subjectsOf = new Map(
    [...eventTypes]
      .sort()
      .map(
        (eventType) => [eventType, eventSubjectsFor(eventType, nats.services).subjects] as const,
      ),
  );
  // Code subscriptions per event type, through the one consumer-set function; grants are not
  // consumption, so only code sites become consumed facts and edge targets.
  const consumed = new Map<string, EventSiteFact[]>();
  const codeConsumers = new Map<string, ConsumerMatch[]>();
  for (const [eventType, subjects] of subjectsOf) {
    const matches = eventConsumersFor(
      eventType,
      consumers,
      nats.services,
      subjects,
    ).consumers.filter((match) => match.sources.includes('code_subscription'));
    codeConsumers.set(eventType, matches);
    for (const match of matches) {
      const list = consumed.get(match.application) ?? [];
      for (const site of match.codeSites) list.push({ event_type: eventType, site });
      consumed.set(match.application, list);
    }
  }

  // A code subscription no known event type matches is still its application's fact, never
  // dropped. Only a subject subscription can be one: an event-type subscription's value is in
  // `eventTypes` by construction.
  const subjectsConsumed = new Map<string, SubjectSiteFact[]>();
  for (const entry of consumers.entries) {
    if (entry.kind !== 'subject') continue;
    const matched = [...subjectsOf].some(
      ([eventType, subjects]) => consumedSubject(entry, eventType, subjects) !== undefined,
    );
    if (matched) continue;
    const list = subjectsConsumed.get(entry.application) ?? [];
    list.push({ subject: entry.value, site: entry.site });
    subjectsConsumed.set(entry.application, list);
  }
  // The applications the TypeScript scan read: those with a TypeScript source under apps/<dir>/src.
  const scanned = new Set(
    allFiles.flatMap((path) => {
      const application = scan.appOf(scan.relative(path));
      return application === null ? [] : [application];
    }),
  );

  const identityByApplication = new Map(
    nats.services.map((service) => [service.application, service] as const),
  );
  const lineRef = (line: number): string => `${NATS_SERVICES_REF}:${line}`;
  const linesOf = (name: string): NatsServiceSourceLines => {
    const lines = nats.lines.get(name);
    if (lines === undefined) throw new Error(`event-consumer-index: no source lines for ${name}`);
    return lines;
  };
  const codeConsumersOf = (eventType: string): readonly ConsumerMatch[] => {
    const matches = codeConsumers.get(eventType);
    if (matches === undefined)
      throw new Error(`event-consumer-index: ${eventType} was not indexed`);
    return matches;
  };
  const natsFacts = (
    identity: NatsServiceEntry,
  ): Pick<ServiceEventFacts, 'acl_grants' | 'nats_identity'> => {
    const lines = linesOf(identity.name);
    const grants = (direction: 'publish' | 'subscribe'): AclGrantFact[] =>
      identity[direction].map((grant, index) => {
        const line = lines[direction][index];
        if (line === undefined) {
          throw new Error(
            `event-consumer-index: ${identity.name}.${direction}[${index}] has no line`,
          );
        }
        return { subject: grant, direction, ref: lineRef(line) };
      });
    return {
      acl_grants: [...grants('publish'), ...grants('subscribe')],
      nats_identity: { name: identity.name, ref: lineRef(lines.name) },
    };
  };

  const serviceFacts = services.map((service): ServiceEventFacts => {
    const produced = producers.entries.filter((entry) => entry.application === service);
    const edges = new Map<string, EventEdgeFact>();
    for (const entry of produced) {
      for (const match of codeConsumersOf(entry.eventType)) {
        const key = `${match.application}\u0000${entry.eventType}`;
        if (match.application === service || edges.has(key)) continue;
        const [toRef] = match.codeSites;
        if (toRef === undefined) {
          throw new Error(`event-consumer-index: ${match.application} has no code site for ${key}`);
        }
        edges.set(key, {
          kind: 'event',
          to: match.application,
          subject: entry.eventType,
          ref: entry.site,
          to_ref: toRef,
        });
      }
    }
    const identity = identityByApplication.get(service);
    const codeState: SectionState = scanned.has(service) ? 'available' : NO_TYPESCRIPT_SOURCES;
    return {
      service,
      events_produced: produced.map((entry) => ({ event_type: entry.eventType, site: entry.site })),
      events_consumed: (consumed.get(service) ?? []).sort(
        (a, b) => a.event_type.localeCompare(b.event_type) || bySite(a, b),
      ),
      subjects_consumed: (subjectsConsumed.get(service) ?? []).sort(
        (a, b) => a.subject.localeCompare(b.subject) || bySite(a, b),
      ),
      edges: [...edges.values()].sort(
        (a, b) => a.subject.localeCompare(b.subject) || a.to.localeCompare(b.to),
      ),
      ...(identity === undefined ? { acl_grants: [], nats_identity: null } : natsFacts(identity)),
      // The code sections come from the TypeScript scan; the services.yaml sections are always read.
      state: {
        events_produced: codeState,
        events_consumed: codeState,
        subjects_consumed: codeState,
        edges: codeState,
        acl_grants: 'available',
        nats_identity: 'available',
      },
    };
  });

  const known = new Set(services);
  return {
    schema: 'aria/event_facts/v1',
    services: serviceFacts,
    event_definitions: definitions,
    unresolved: { produced: producers.unresolved, consumed: consumers.unresolved },
    unattributed: { produced: producers.unattributed, consumed: consumers.unattributed },
    nats_identities_without_application: nats.services
      .filter((service) => !known.has(service.application))
      .map((service) => ({
        name: service.name,
        application: service.application,
        ref: lineRef(linesOf(service.name).name),
      })),
  };
}

const FACTS_USAGE = 'usage: event-consumer-index.ts --facts --repo-root <tree>\n';

/**
 * `--facts --repo-root <tree>`: the code facts of the tree as one JSON object on stdout, exit 0.
 * A services.yaml its schema refuses, a tree whose tracked sources cannot be read
 * (SourceTreeUnavailable), or a bad invocation is an environment failure: exit 2 and nothing on
 * stdout, so the kernel holds the change by name instead of reading empty facts.
 */
function main(argv: readonly string[]): number {
  const rootFlag = argv.indexOf('--repo-root');
  const repoRoot = rootFlag === -1 ? undefined : argv[rootFlag + 1];
  if (!argv.includes('--facts') || repoRoot === undefined || argv.length !== 3) {
    process.stderr.write(FACTS_USAGE);
    return 2;
  }
  let facts: EventFacts;
  try {
    facts = eventFacts(repoRoot);
  } catch (error) {
    if (error instanceof NatsServicesInvalid) {
      process.stderr.write(`event-consumer-index --facts: services.yaml ${error.message}\n`);
      return 2;
    }
    if (error instanceof SourceTreeUnavailable) {
      process.stderr.write(`event-consumer-index --facts: ${error.name}: ${error.message}\n`);
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
