/**
 * The `@Roles` aliases (`@SuperAdminOnly()`, `@TenantAdminOrHigher()`, `@ModuleManagerOrHigher()`,
 * `@ModuleUserOrHigher()`, …) as the role lists they set, read from the syntax tree of their one
 * owner, libs/backend-common/src/decorators/roles.decorator.ts.
 *
 * WHY: each alias sets the same ROLES_KEY metadata as `@Roles(...)`, so RolesGuard and
 * `@AccessCaller()` read it as `@Roles`. A scanner that knew only the name `Roles` read an aliased
 * handler as declaring no roles: the classification invariant passed `@Access.self()` with
 * `@ModuleUserOrHigher()`, a pairing decideHandler denies to every caller, and the e2e matrix
 * expected cells wider than the stack decides. Reading the owner file means an alias added there is
 * resolved without touching the scanner; a `Roles(...)` call there in any other shape throws, so
 * an alias the scanner cannot read fails the invariant instead of reading as no roles.
 */
import ts from 'typescript';

import { readRepoFile } from './module-dictionary-sources';

export const ROLES_DECORATOR_FILE = 'libs/backend-common/src/decorators/roles.decorator.ts';

export type RolesAliases = ReadonlyMap<string, readonly string[]>;

/** The role names a `Roles(...)` call lists: `Role.X` → X, a string literal → its text. */
export function roleArgumentNames(args: readonly ts.Expression[]): readonly string[] {
  return Object.freeze(
    args.map((arg) => {
      if (ts.isPropertyAccessExpression(arg)) return arg.name.text;
      if (ts.isStringLiteralLike(arg)) return arg.text;
      return arg.getText();
    }),
  );
}

interface AliasCandidate {
  readonly name: string;
  readonly call: ts.CallExpression;
}

/** `export const X = () => Y(...)`: X and the call, else null. */
function aliasCandidateOf(arrow: ts.ArrowFunction): AliasCandidate | null {
  const declaration = arrow.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== arrow) return null;
  if (!ts.isIdentifier(declaration.name) || arrow.parameters.length > 0) return null;
  const statement = declaration.parent.parent;
  const exported =
    ts.isVariableStatement(statement) &&
    (ts.getModifiers(statement) ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    );
  if (!exported || !ts.isCallExpression(arrow.body)) return null;
  return { name: declaration.name.text, call: arrow.body };
}

function calleeName(call: ts.CallExpression): string | null {
  return ts.isIdentifier(call.expression) ? call.expression.text : null;
}

/**
 * Alias name → the roles it sets, for every `export const X = () => Roles(...)` of `source` and
 * every `export const Y = () => X()` over a resolved alias X. Throws on a `Roles(...)` call that is
 * not such an alias's whole body.
 */
export function rolesAliasesOf(file: string, source: string): RolesAliases {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const candidates: AliasCandidate[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isArrowFunction(node)) {
      const candidate = aliasCandidateOf(node);
      if (candidate !== null) candidates.push(candidate);
    }
    if (ts.isCallExpression(node) && calleeName(node) === 'Roles') {
      if (!candidates.some((candidate) => candidate.call === node)) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        throw new Error(
          `${file}:${line + 1}: Roles(...) is not the whole body of an \`export const X = () => ` +
            'Roles(...)` alias, so the classification scanner cannot read the roles it sets',
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const aliases = new Map<string, readonly string[]>();
  let resolved = true;
  while (resolved) {
    resolved = false;
    for (const { name, call } of candidates) {
      if (aliases.has(name)) continue;
      const callee = calleeName(call);
      const inherited = callee === null ? undefined : aliases.get(callee);
      if (callee === 'Roles') aliases.set(name, roleArgumentNames(call.arguments));
      else if (inherited !== undefined && call.arguments.length === 0) aliases.set(name, inherited);
      else continue;
      resolved = true;
    }
  }
  return aliases;
}

function setsRolesMetadata(call: ts.CallExpression): boolean {
  const callee = calleeName(call);
  if (callee === 'Roles') return !ts.isDecorator(call.parent);
  const [key] = call.arguments;
  if (callee !== 'SetMetadata' || key === undefined) return false;
  return (
    (ts.isIdentifier(key) && key.text === 'ROLES_KEY') ||
    (ts.isStringLiteralLike(key) && key.text === 'roles')
  );
}

/**
 * Every place `source` sets the `@Roles` metadata other than a `@Roles(...)` decorator: a
 * `Roles(...)` call in any other position or `SetMetadata(ROLES_KEY | 'roles', …)`. Outside
 * ROLES_DECORATOR_FILE each is an alias the scanner cannot read.
 */
export function localRolesAliasesOf(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && setsRolesMetadata(node)) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      out.push(
        `${file}:${line + 1}: sets the @Roles metadata outside a @Roles(...) decorator; declare ` +
          `@Roles on the handler or add the alias to ${ROLES_DECORATOR_FILE}`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

let ownerAliases: RolesAliases | undefined;

/** The aliases of ROLES_DECORATOR_FILE, read once. */
export function rolesAliases(): RolesAliases {
  if (ownerAliases === undefined) {
    ownerAliases = rolesAliasesOf(ROLES_DECORATOR_FILE, readRepoFile(ROLES_DECORATOR_FILE));
  }
  return ownerAliases;
}
