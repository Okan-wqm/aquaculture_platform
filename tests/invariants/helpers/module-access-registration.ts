/**
 * Source readers for the ADR-051 guard-adoption and no-global-role-authz invariants: who
 * registers the access guards, who constructs them, who applies RolesGuard per handler, and which
 * expressions read the global `users.role` / `modules` claims. Every reader walks the syntax tree,
 * so comments and strings never count.
 */
import ts from 'typescript';

import { readRepoFile, trackedFiles } from './module-dictionary-sources';

function parse(file: string, source: string): ts.SourceFile {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
}

function lineOf(file: ts.SourceFile, node: ts.Node): number {
  return file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Production TypeScript under the roots: no specs, test helpers or fixtures. */
export function productionSources(roots: readonly string[]): string[] {
  return trackedFiles(roots).filter(
    (file) =>
      file.endsWith('.ts') &&
      !file.endsWith('.d.ts') &&
      !/\.(spec|test|e2e-spec)\.ts$/.test(file) &&
      !/(^|\/)(__tests__|__mocks__|__fixtures__|test-utils|test|e2e)\//.test(file),
  );
}

/** `apps/<service>/src/app.module.ts` of every service, by service. */
export function appModules(): ReadonlyMap<string, string> {
  const modules = new Map<string, string>();
  for (const file of trackedFiles(['apps'])) {
    const match = /^apps\/([^/]+)\/src\/app\.module\.ts$/.exec(file);
    if (match !== null && match[1] !== undefined) modules.set(match[1], file);
  }
  return modules;
}

/** The first argument of every `accessGuardProviders(...)` call: its literal, or null. */
export function accessGuardRegistrations(file: string, source: string): (string | null)[] {
  const found: (string | null)[] = [];
  walk(parse(file, source), (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'accessGuardProviders'
    ) {
      const [arg] = node.arguments;
      found.push(arg !== undefined && ts.isStringLiteralLike(arg) ? arg.text : null);
    }
  });
  return found;
}

/** Where the source names any of the identifiers (imports included), as `file:line name`. */
export function identifierUses(file: string, source: string, names: ReadonlySet<string>): string[] {
  const sourceFile = parse(file, source);
  const found: string[] = [];
  walk(sourceFile, (node) => {
    if (ts.isIdentifier(node) && names.has(node.text)) {
      found.push(`${file}:${lineOf(sourceFile, node)} ${node.text}`);
    }
  });
  return found;
}

/** `new <Class>(...)` of any of the classes, as `file:line Class`. */
export function constructions(
  file: string,
  source: string,
  classes: ReadonlySet<string>,
): string[] {
  const sourceFile = parse(file, source);
  const found: string[] = [];
  walk(sourceFile, (node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      classes.has(node.expression.text)
    ) {
      found.push(`${file}:${lineOf(sourceFile, node)} new ${node.expression.text}`);
    }
  });
  return found;
}

/** `UseGuards(..., RolesGuard, ...)` applications, as `file:line`. */
export function perHandlerRolesGuards(file: string, source: string): string[] {
  const sourceFile = parse(file, source);
  const found: string[] = [];
  walk(sourceFile, (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'UseGuards' &&
      node.arguments.some((arg) => ts.isIdentifier(arg) && arg.text === 'RolesGuard')
    ) {
      found.push(`${file}:${lineOf(sourceFile, node)} UseGuards(RolesGuard)`);
    }
  });
  return found;
}

/** The global claims ADR-051 takes module power from: `users.role` (`role`, `roles`) and `modules`. */
const GLOBAL_CLAIMS: ReadonlySet<string> = new Set(['role', 'roles', 'modules']);

/** Receivers that hold a verified user's claims by the platform's naming. */
const USER_RECEIVER =
  /^(user|currentUser|viewer|actor|requester|jwtUser|authUser|principal|requestUser|caller|payload)$/i;

/** Helpers that answer from the global role. */
const GLOBAL_ROLE_HELPERS: ReadonlySet<string> = new Set([
  'roleHasPermission',
  'hasAnyRole',
  'highestPlatformRole',
]);

function isUserShaped(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return USER_RECEIVER.test(expression.text);
  if (ts.isPropertyAccessExpression(expression))
    return expression.name.text === 'user' || USER_RECEIVER.test(expression.name.text);
  if (ts.isNonNullExpression(expression) || ts.isParenthesizedExpression(expression)) {
    return isUserShaped(expression.expression);
  }
  return false;
}

/**
 * Every place a source reads the global role or module list for a decision: a `.role`, `.roles`
 * or `.modules` read (or destructuring) of a user-shaped value, `@CurrentUser('role' | 'roles' |
 * 'modules')`, and the global-role hierarchy helpers. In a `module-access` service module power
 * comes from `@AccessCaller()` (effectiveRoles, moduleScope, member) only.
 */
export function globalRoleReads(file: string, source: string): string[] {
  const sourceFile = parse(file, source);
  const found: string[] = [];
  const report = (node: ts.Node, what: string): void => {
    found.push(`${file}:${lineOf(sourceFile, node)} ${what}`);
  };
  walk(sourceFile, (node) => {
    if (
      ts.isPropertyAccessExpression(node) &&
      GLOBAL_CLAIMS.has(node.name.text) &&
      isUserShaped(node.expression)
    ) {
      report(node, node.getText(sourceFile));
    } else if (
      ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      GLOBAL_CLAIMS.has(node.argumentExpression.text) &&
      isUserShaped(node.expression)
    ) {
      report(node, node.getText(sourceFile));
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isObjectBindingPattern(node.name) &&
      node.initializer !== undefined &&
      isUserShaped(node.initializer) &&
      node.name.elements.some((element) =>
        GLOBAL_CLAIMS.has((element.propertyName ?? element.name).getText(sourceFile)),
      )
    ) {
      report(node, node.getText(sourceFile));
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'CurrentUser' &&
      node.arguments.some((arg) => ts.isStringLiteralLike(arg) && GLOBAL_CLAIMS.has(arg.text))
    ) {
      report(node, node.getText(sourceFile));
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      GLOBAL_ROLE_HELPERS.has(node.expression.text)
    ) {
      report(node, `${node.expression.text}(...)`);
    }
  });
  return found;
}

/** `globalRoleReads` over a service's production sources. */
export function serviceGlobalRoleReads(service: string): string[] {
  return productionSources([`apps/${service}/src`]).flatMap((file) =>
    globalRoleReads(file, readRepoFile(file)),
  );
}
