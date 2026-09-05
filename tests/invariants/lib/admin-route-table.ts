/**
 * Admin route table — every HTTP route admin-api declares, in the order
 * NestJS registers it, read from the controller source with the TypeScript
 * compiler (ADMIN-HIGH-011).
 *
 * Two gates share this scan: `admin-route-registration-order` (a
 * parameterised route declared before a literal sibling shadows it) and
 * `admin-no-stub-routes` (a handler whose body only refuses). Both need the
 * same answer to "which methods are routes, on which path, in which order?",
 * and a regex over decorator lines cannot give it — `@Get()` with no
 * argument, multi-line decorators and array paths all need the AST.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as ts from 'typescript';

export const REPO_ROOT = resolve(__dirname, '..', '..', '..');
export const ADMIN_SERVICE_SRC = 'apps/admin-api-service/src';

export type HttpVerb = 'Get' | 'Post' | 'Put' | 'Patch' | 'Delete' | 'Head' | 'Options' | 'All';

const HTTP_VERBS: ReadonlySet<string> = new Set<HttpVerb>([
  'Get',
  'Post',
  'Put',
  'Patch',
  'Delete',
  'Head',
  'Options',
  'All',
]);

export interface AdminRoute {
  /** `<repo-relative controller path>#<method name>` */
  readonly id: string;
  readonly file: string;
  readonly controller: string;
  /** The `@Controller()` prefix, no leading/trailing slash (`''` for none). */
  readonly prefix: string;
  readonly verb: HttpVerb;
  /** The verb decorator's path, no leading/trailing slash (`''` for none). */
  readonly path: string;
  /** `prefix/path` joined, no leading/trailing slash. */
  readonly fullPath: string;
  readonly handler: string;
  /** 1-based line of the handler's signature. */
  readonly line: number;
  /** Declaration index within the controller class — NestJS registers in this order. */
  readonly order: number;
}

/** Production source only: tests, fixtures, archives and built output declare no routes. */
export const NOT_PRODUCTION =
  /(^|\/)(__tests__|__mocks__|test|tests|e2e|dist|\.archive)\/|\.(spec|test)\.tsx?$/;

export function listAdminSourceFiles(): string[] {
  return execFileSync(
    'git',
    [
      '-C',
      REPO_ROOT,
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      `${ADMIN_SERVICE_SRC}/**/*.ts`,
    ],
    { encoding: 'utf8' },
  )
    .split('\n')
    .filter((rel) => rel.length > 0 && !NOT_PRODUCTION.test(rel) && !rel.endsWith('.d.ts'));
}

export function parseRepoFile(rel: string): ts.SourceFile {
  return ts.createSourceFile(
    rel,
    readFileSync(resolve(REPO_ROOT, rel), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function decoratorsOf(node: ts.HasDecorators): readonly ts.Decorator[] {
  return ts.getDecorators(node) ?? [];
}

/** `@Name(...)` → `{ name, args }`; anything that is not a call of an identifier → null. */
function decoratorCall(
  decorator: ts.Decorator,
): { name: string; args: readonly ts.Expression[] } | null {
  const expr = decorator.expression;
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return { name: expr.expression.text, args: expr.arguments };
  }
  if (ts.isIdentifier(expr)) return { name: expr.text, args: [] };
  return null;
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+/, '').replace(/\/+$/, '');
}

/**
 * The path(s) a route decorator argument declares. A missing argument is
 * `''`; a string literal is itself; an array literal is each element. Any
 * other expression (a constant, a template) is refused: the gate must read
 * the route the router reads, not guess it.
 */
function decoratorPaths(file: string, name: string, args: readonly ts.Expression[]): string[] {
  const first = args[0];
  if (first === undefined) return [''];
  if (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first)) {
    return [trimSlashes(first.text)];
  }
  if (ts.isArrayLiteralExpression(first)) {
    return first.elements.map((element) => {
      if (ts.isStringLiteral(element) || ts.isNoSubstitutionTemplateLiteral(element)) {
        return trimSlashes(element.text);
      }
      throw new Error(`${file}: @${name}([...]) has a non-literal path element`);
    });
  }
  if (ts.isObjectLiteralExpression(first)) {
    // @Controller({ path, host, version }) — read `path` only.
    for (const prop of first.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === 'path' &&
        (ts.isStringLiteral(prop.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(prop.initializer))
      ) {
        return [trimSlashes(prop.initializer.text)];
      }
    }
    return [''];
  }
  throw new Error(`${file}: @${name}(...) path is not a string literal`);
}

/** Every HTTP route one controller file declares, in declaration order. */
export function adminRoutesIn(file: string): AdminRoute[] {
  const source = parseRepoFile(file);
  const routes: AdminRoute[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name) {
      const controllerDecorator = decoratorsOf(node)
        .map(decoratorCall)
        .find((call) => call?.name === 'Controller');
      if (controllerDecorator) {
        const prefixes = decoratorPaths(file, 'Controller', controllerDecorator.args);
        let order = 0;
        for (const member of node.members) {
          if (!ts.isMethodDeclaration(member) || !ts.isIdentifier(member.name)) continue;
          for (const decorator of decoratorsOf(member)) {
            const call = decoratorCall(decorator);
            if (!call || !HTTP_VERBS.has(call.name)) continue;
            const verb = call.name as HttpVerb;
            for (const prefix of prefixes) {
              for (const path of decoratorPaths(file, verb, call.args)) {
                const line = source.getLineAndCharacterOfPosition(member.name.getStart()).line + 1;
                routes.push({
                  id: `${file}#${member.name.text}`,
                  file,
                  controller: node.name.text,
                  prefix,
                  verb,
                  path,
                  fullPath: trimSlashes([prefix, path].filter((p) => p.length > 0).join('/')),
                  handler: member.name.text,
                  line,
                  order,
                });
              }
            }
            order += 1;
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return routes;
}

/** Every HTTP route across the admin-api fleet. */
export function allAdminRoutes(): AdminRoute[] {
  return listAdminSourceFiles()
    .filter((rel) => rel.endsWith('.controller.ts'))
    .flatMap(adminRoutesIn);
}

export function isParamSegment(segment: string): boolean {
  return segment.startsWith(':') || segment.includes('*');
}

/**
 * Would the router, having registered `earlier` first, hand a request for
 * `later`'s literal path to `earlier`? True when the two have the same
 * segment count, every literal in `earlier` equals `later`'s segment, and at
 * least one `earlier` parameter sits where `later` has a literal.
 */
export function shadows(earlier: AdminRoute, later: AdminRoute): boolean {
  const a = earlier.fullPath.split('/').filter(Boolean);
  const b = later.fullPath.split('/').filter(Boolean);
  if (a.length !== b.length) return false;
  let paramOverLiteral = false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? '';
    const y = b[i] ?? '';
    if (isParamSegment(x)) {
      if (!isParamSegment(y)) paramOverLiteral = true;
      continue;
    }
    if (isParamSegment(y)) return false;
    if (x !== y) return false;
  }
  return paramOverLiteral;
}
