/**
 * Source reader for `tenant-capability-usage.spec.ts`: which tenant capabilities a backend check
 * reads, found the way a reviewer would trace them, without booting a service.
 *
 * A read is an argument of one of the capability checks (`CAPABILITY_READERS`). The argument is
 * resolved to its strings through:
 *   - a string literal or an array of them;
 *   - a `const` of the same file;
 *   - a constant imported from `@aquaculture/shared-contracts` (or, inside that library, from a
 *     sibling module): its exported value;
 *   - a parameter of the enclosing function: every call of that function in the same file;
 *   - a property the shared contracts derive (`DERIVED_CAPABILITY_PROPERTIES`).
 * Anything else is reported as unresolved, so a reader the scan cannot follow fails the invariant
 * instead of passing as "no read". A check that only forwards its own caller's capabilities is a
 * forwarding site: the spec lists each one, and the scan reports which listed sites it met.
 */
import * as sharedContracts from '@aquaculture/shared-contracts';
import ts from 'typescript';

import { readRepoFile, trackedFiles } from './module-dictionary-sources';

/** The capability checks, and which arguments are the capabilities they require. */
export const CAPABILITY_READERS: ReadonlyMap<string, 'every' | number> = new Map<
  string,
  'every' | number
>([
  ['RequireTenantPermission', 'every'],
  ['hasResourcePermission', 1],
  ['hasAllResourcePermissions', 1],
  ['holdsTenantCapabilities', 1],
]);

/** Properties whose value the shared contracts derive, and the capabilities they can hold. */
export const DERIVED_CAPABILITY_PROPERTIES: ReadonlyMap<string, readonly string[]> = new Map([
  // AiPersonaCatalogueEntry.requiredCapabilities: the persona gates of messaging and ai-service.
  [
    'requiredCapabilities',
    sharedContracts.AI_PERSONA_CATALOGUE.flatMap((entry) => entry.requiredCapabilities),
  ],
]);

const SHARED_CONTRACTS_EXPORTS: ReadonlyMap<string, unknown> = new Map(
  Object.entries(sharedContracts),
);

export interface ForwardingSite {
  readonly file: string;
  /** The argument as written, whitespace removed. */
  readonly argument: string;
  readonly reason: string;
}

export interface CapabilityRead {
  readonly capability: string;
  readonly where: string;
}

export interface CapabilityScan {
  readonly reads: readonly CapabilityRead[];
  readonly unresolved: readonly string[];
  readonly forwardingMet: readonly string[];
}

const SOURCE_ROOTS = ['apps', 'libs', 'platform', 'mcp'];
const SHARED_CONTRACTS_SPECIFIER = '@aquaculture/shared-contracts';
const SHARED_CONTRACTS_SRC = 'libs/shared-contracts/src/';
const MAX_PARAMETER_HOPS = 3;

/** Backend product sources: tests, migrations, generated code and the web are not checks. */
export function isBackendSource(file: string): boolean {
  return (
    file.endsWith('.ts') &&
    !file.endsWith('.d.ts') &&
    !/\.(spec|test)\.ts$/.test(file) &&
    !/(^|\/)(__tests__|__fixtures__|__mocks__|migrations|generated|test|e2e)\//.test(file) &&
    !/^apps\/[^/]+\/src\/test-utils\//.test(file) &&
    !file.startsWith('libs/testing/') &&
    !file.includes('/node_modules/')
  );
}

export function backendSources(): string[] {
  return trackedFiles(SOURCE_ROOTS).filter(isBackendSource);
}

function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

function exportedValue(name: string): readonly string[] | null {
  const value = SHARED_CONTRACTS_EXPORTS.get(name);
  if (typeof value === 'string') return [value];
  if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) {
    return value;
  }
  return null;
}

function calleeName(call: ts.CallExpression): string | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

function functionName(fn: ts.SignatureDeclaration): string | null {
  if ((ts.isMethodDeclaration(fn) || ts.isFunctionDeclaration(fn)) && fn.name !== undefined) {
    return ts.isIdentifier(fn.name) ? fn.name.text : null;
  }
  const parent = fn.parent;
  if (parent !== undefined && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return null;
}

class FileScan {
  readonly reads: CapabilityRead[] = [];
  readonly unresolved: string[] = [];
  readonly forwardingMet: string[] = [];
  private readonly calls: ts.CallExpression[] = [];

  constructor(
    private readonly rel: string,
    private readonly file: ts.SourceFile,
    private readonly forwarding: ReadonlySet<string>,
  ) {
    const collect = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) this.calls.push(node);
      ts.forEachChild(node, collect);
    };
    collect(file);
  }

  run(): void {
    for (const call of this.calls) {
      const name = calleeName(call);
      const position = name === null ? undefined : CAPABILITY_READERS.get(name);
      if (name === null || position === undefined) continue;
      const args = position === 'every' ? [...call.arguments] : [call.arguments[position]];
      for (const argument of args) {
        if (argument === undefined) continue;
        const key = `${this.rel}#${compact(argument.getText(this.file))}`;
        if (this.forwarding.has(key)) {
          this.forwardingMet.push(key);
          continue;
        }
        const where = this.where(argument);
        const resolved = this.resolve(argument, 0);
        if (resolved === null) {
          this.unresolved.push(`${where} ${name}(… ${argument.getText(this.file)} …)`);
          continue;
        }
        for (const capability of resolved) this.reads.push({ capability, where });
      }
    }
  }

  private where(node: ts.Node): string {
    const line = this.file.getLineAndCharacterOfPosition(node.getStart(this.file)).line + 1;
    return `${this.rel}:${line}`;
  }

  private resolve(expression: ts.Expression, hops: number): readonly string[] | null {
    if (
      ts.isParenthesizedExpression(expression) ||
      ts.isAsExpression(expression) ||
      ts.isSatisfiesExpression(expression) ||
      ts.isNonNullExpression(expression) ||
      ts.isTypeAssertionExpression(expression)
    ) {
      return this.resolve(expression.expression, hops);
    }
    if (ts.isStringLiteralLike(expression)) return [expression.text];
    if (ts.isArrayLiteralExpression(expression)) {
      const values: string[] = [];
      for (const element of expression.elements) {
        const resolved = this.resolve(
          ts.isSpreadElement(element) ? element.expression : element,
          hops,
        );
        if (resolved === null) return null;
        values.push(...resolved);
      }
      return values;
    }
    if (ts.isPropertyAccessExpression(expression)) {
      return DERIVED_CAPABILITY_PROPERTIES.get(expression.name.text) ?? null;
    }
    if (ts.isIdentifier(expression)) return this.resolveIdentifier(expression, hops);
    return null;
  }

  private resolveIdentifier(identifier: ts.Identifier, hops: number): readonly string[] | null {
    const constants = this.constants(identifier.text);
    if (constants.length > 0) {
      const values: string[] = [];
      for (const initializer of constants) {
        const resolved = this.resolve(initializer, hops);
        if (resolved === null) return null;
        values.push(...resolved);
      }
      return values;
    }
    const imported = this.importedName(identifier.text);
    if (imported !== null) return exportedValue(imported);
    return this.resolveParameter(identifier, hops);
  }

  private constants(name: string): ts.Expression[] {
    const found: ts.Expression[] = [];
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === name &&
        node.initializer !== undefined &&
        ts.isVariableDeclarationList(node.parent) &&
        (node.parent.flags & ts.NodeFlags.Const) !== 0
      ) {
        found.push(node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(this.file);
    return found;
  }

  /** The exported name `local` is imported as, when it comes from the shared contracts. */
  private importedName(local: string): string | null {
    for (const statement of this.file.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      const fromSharedContracts =
        specifier === SHARED_CONTRACTS_SPECIFIER ||
        (specifier.startsWith('.') && this.rel.startsWith(SHARED_CONTRACTS_SRC));
      const bindings = statement.importClause?.namedBindings;
      if (!fromSharedContracts || bindings === undefined || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        if (element.name.text === local) return (element.propertyName ?? element.name).text;
      }
    }
    return null;
  }

  private resolveParameter(identifier: ts.Identifier, hops: number): readonly string[] | null {
    if (hops >= MAX_PARAMETER_HOPS) return null;
    let node: ts.Node | undefined = identifier.parent;
    while (node !== undefined && !ts.isFunctionLike(node)) node = node.parent;
    if (node === undefined) return null;
    const index = node.parameters.findIndex(
      (parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === identifier.text,
    );
    const name = functionName(node);
    if (index < 0 || name === null) return null;
    const callers = this.calls.filter((call) => calleeName(call) === name);
    if (callers.length === 0) return null;
    const values: string[] = [];
    for (const call of callers) {
      const argument = call.arguments[index];
      const resolved = argument === undefined ? null : this.resolve(argument, hops + 1);
      if (resolved === null) return null;
      values.push(...resolved);
    }
    return values;
  }
}

/** The capability reads of one source file. */
export function scanCapabilityReads(
  rel: string,
  source: string,
  forwarding: readonly ForwardingSite[],
): CapabilityScan {
  if (![...CAPABILITY_READERS.keys()].some((name) => source.includes(name))) {
    return { reads: [], unresolved: [], forwardingMet: [] };
  }
  const file = ts.createSourceFile(rel, source, ts.ScriptTarget.Latest, true);
  const scan = new FileScan(
    rel,
    file,
    new Set(forwarding.map((site) => `${site.file}#${site.argument}`)),
  );
  scan.run();
  return { reads: scan.reads, unresolved: scan.unresolved, forwardingMet: scan.forwardingMet };
}

/** The capability reads of every backend source. */
export function scanBackendCapabilityReads(forwarding: readonly ForwardingSite[]): CapabilityScan {
  const reads: CapabilityRead[] = [];
  const unresolved: string[] = [];
  const forwardingMet: string[] = [];
  for (const rel of backendSources()) {
    const scan = scanCapabilityReads(rel, readRepoFile(rel), forwarding);
    reads.push(...scan.reads);
    unresolved.push(...scan.unresolved);
    forwardingMet.push(...scan.forwardingMet);
  }
  return { reads, unresolved, forwardingMet };
}

/** Every string literal in a file (for the web readers the exceptions name). */
export function stringLiterals(rel: string, source: string): ReadonlySet<string> {
  const file = ts.createSourceFile(
    rel,
    source,
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) found.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
