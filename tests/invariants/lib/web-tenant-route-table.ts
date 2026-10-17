/**
 * Every route the tenant console serves, read from source (FE-HIGH-335).
 *
 * Shared by `web-console-nav-coverage.spec.ts`. The shell's App.tsx mounts the
 * module remotes under splat routes; each remote's Module.tsx — and the few
 * pages that host a `<Routes>` of their own (setup, reports, analytics, batch
 * detail, nutrient solution) — declares the rest. The walk is the TypeScript
 * AST, not a regex over text, so nesting (layout routes, splat mounts) and
 * generated routes (`Object.entries(RECORD).map(… <Route path={key} …/>)`)
 * resolve to the same full patterns React Router matches.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as ts from 'typescript';

export const REPO_ROOT = resolve(__dirname, '..', '..', '..');

/** One `<Route>` with an `element`, its pattern joined onto every enclosing path. */
export interface RawRoute {
  /** Repo-relative file declaring the route. */
  readonly file: string;
  /** Full pattern, e.g. `/sites/batch/:batchId/overview`; a splat ends in `/*`. */
  readonly pattern: string;
  /** The prefix the route's `<Routes>` resolves relative paths against. */
  readonly prefix: string;
  /** Source text of the `element` attribute. */
  readonly element: string;
}

/** React Router's join: leading and trailing slashes of a child path are relative. */
export function joinRoute(prefix: string, path: string): string {
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
  if (clean === '') return prefix === '' ? '/' : prefix;
  return `${prefix === '/' ? '' : prefix}/${clean}`;
}

function attribute(opening: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return opening.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function openingOf(node: ts.Node): ts.JsxOpeningLikeElement | undefined {
  if (ts.isJsxSelfClosingElement(node)) return node;
  if (ts.isJsxElement(node)) return node.openingElement;
  return undefined;
}

/** Keys of `const NAME = { … }` in `source`. */
function objectLiteralKeys(source: ts.SourceFile, name: string): string[] {
  let keys: string[] | undefined;
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(source) === name &&
      node.initializer !== undefined &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      keys = node.initializer.properties.map((property) => {
        const key = property.name;
        if (key === undefined || !(ts.isIdentifier(key) || ts.isStringLiteral(key))) {
          throw new Error(`${source.fileName}: ${name} has a computed key`);
        }
        return key.text;
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (keys === undefined) throw new Error(`${source.fileName}: no object literal named ${name}`);
  return keys;
}

/**
 * The record a generated route iterates: the route sits in the callback of
 * `Object.entries(NAME).map(…)` or `Object.keys(NAME).map(…)`.
 */
function generatingRecord(route: ts.Node, source: ts.SourceFile): string {
  for (let node: ts.Node | undefined = route.parent; node !== undefined; node = node.parent) {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) continue;
    const receiver = node.expression.expression;
    if (node.expression.name.text !== 'map' || !ts.isCallExpression(receiver)) continue;
    const callee = receiver.expression.getText(source);
    const [record] = receiver.arguments;
    if (
      (callee === 'Object.entries' || callee === 'Object.keys') &&
      record &&
      ts.isIdentifier(record)
    ) {
      return record.text;
    }
  }
  throw new Error(
    `${source.fileName}: a <Route> has a non-literal path the route table cannot read — ` +
      'give it a literal path, or generate it from Object.entries/keys(RECORD).map',
  );
}

/** Every `<Route element=…>` leaf of `file`, patterns joined onto `prefix`. */
export function readRoutes(file: string, prefix: string): RawRoute[] {
  const text = readFileSync(resolve(REPO_ROOT, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const routes: RawRoute[] = [];

  const visit = (node: ts.Node, base: string): void => {
    const opening = openingOf(node);
    if (opening === undefined || opening.tagName.getText(source) !== 'Route') {
      ts.forEachChild(node, (child) => visit(child, base));
      return;
    }
    const pathAttribute = attribute(opening, 'path');
    const initializer = pathAttribute?.initializer;
    const literal =
      initializer !== undefined && ts.isStringLiteral(initializer) ? initializer.text : undefined;
    const segments =
      pathAttribute === undefined
        ? ['']
        : literal !== undefined
          ? [literal]
          : objectLiteralKeys(source, generatingRecord(node, source));
    const element = attribute(opening, 'element')?.initializer?.getText(source) ?? '';
    for (const segment of segments) {
      const pattern = joinRoute(base, segment);
      if (ts.isJsxElement(node)) {
        // A parent route (here: pathless layouts) is not a page; its children are.
        node.children.forEach((child) =>
          visit(child, pathAttribute === undefined ? base : pattern),
        );
      } else if (element !== '') {
        routes.push({ file, pattern, prefix: base, element });
      }
    }
  };

  visit(source, prefix);
  return routes;
}

/** `<Navigate to="…">` target of an element, if the element is a redirect. */
export function redirectTarget(element: string): string | undefined {
  const match = /^\{\s*<Navigate\b[^>]*?\bto=(?:"([^"]+)"|\{\s*["'`]([^"'`]+)["'`]\s*\})/.exec(
    element,
  );
  return match === null ? undefined : (match[1] ?? match[2]);
}

/** The string literals of a union type captured by `pattern` in `file` (`'a' | 'b'`). */
export function unionLiterals(file: string, pattern: RegExp): string[] {
  const text = readFileSync(resolve(REPO_ROOT, file), 'utf8');
  const union = pattern.exec(text)?.[1];
  if (union === undefined) throw new Error(`${file}: ${pattern} did not match`);
  const literals = [...union.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
  if (literals.length === 0) throw new Error(`${file}: ${pattern} captured no string literal`);
  return literals;
}
