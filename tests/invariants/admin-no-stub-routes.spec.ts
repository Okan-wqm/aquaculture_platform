/**
 * INVARIANT — no admin route exists only to refuse (ADMIN-HIGH-011).
 *
 * When a store was retired, its routes stayed registered with bodies that
 * threw 410 Gone or 501 Not Implemented, and its frontend clients stayed
 * wired to them. A route that can never succeed is worse than no route:
 * it passes the FE↔BE contract test, appears in the OpenAPI document, is
 * counted as coverage, and every page that calls it is broken by design.
 * Retirement deletes the route, the client and the page in one commit.
 *
 * Three rules over admin-api production source:
 *   1. `NotImplementedException` / `HttpStatus.NOT_IMPLEMENTED` never appear:
 *      an unimplemented route is an undeclared route.
 *   2. `GoneException` / `HttpStatus.GONE` appear only where a resource is
 *      genuinely gone behind a real lookup (the allowlist below names the
 *      file and the reason); never as a retired store's answer.
 *   3. No route handler's body reduces to a throw — a `throw` statement, a
 *      `this.throwX()` helper call, or a `never` return type. `void x;`
 *      parameter-silencing statements do not count as behaviour.
 *
 * Route enumeration is `tests/invariants/lib/admin-route-table.ts`, shared
 * with `admin-route-registration-order.spec.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as ts from 'typescript';

import {
  REPO_ROOT,
  allAdminRoutes,
  listAdminSourceFiles,
  parseRepoFile,
  type AdminRoute,
} from './lib/admin-route-table';

interface GoneAllowance {
  readonly file: string;
  readonly reason: string;
}

/** Where a 410 is the truth about a resource, not the epitaph of a store. */
const GONE_ALLOWED: readonly GoneAllowance[] = [
  {
    file: 'apps/admin-api-service/src/analytics/services/reports.service.ts',
    reason:
      'a report download link past its expiry, or an artifact the retention authority pruned, is genuinely gone; the throw follows a real lookup of a real row',
  },
];

const NOT_IMPLEMENTED = /\bNotImplementedException\b|\bHttpStatus\.NOT_IMPLEMENTED\b/;
const GONE = /\bGoneException\b|\bHttpStatus\.GONE\b/;

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(?<!:)\/\/.*$/, ''))
    .join('\n');
}

function isVoidSilencer(statement: ts.Statement): boolean {
  return ts.isExpressionStatement(statement) && ts.isVoidExpression(statement.expression);
}

/** `this.throwX(...)`, `throwX(...)` — a helper whose name announces a throw. */
function isThrowHelperCall(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) return false;
  const callee = expression.expression;
  const name = ts.isPropertyAccessExpression(callee)
    ? callee.name.text
    : ts.isIdentifier(callee)
      ? callee.text
      : '';
  return /^throw[A-Z_]/.test(name);
}

function bodyReducesToThrow(method: ts.MethodDeclaration): boolean {
  if (!method.body) return false;
  const statements = method.body.statements.filter((s) => !isVoidSilencer(s));
  if (statements.length !== 1) return false;
  const only = statements[0];
  if (!only) return false;
  if (ts.isThrowStatement(only)) return true;
  if (ts.isExpressionStatement(only)) return isThrowHelperCall(only.expression);
  if (ts.isReturnStatement(only) && only.expression) return isThrowHelperCall(only.expression);
  return false;
}

function returnsNever(method: ts.MethodDeclaration): boolean {
  const type = method.type;
  if (!type) return false;
  if (type.kind === ts.SyntaxKind.NeverKeyword) return true;
  // Promise<never>
  return (
    ts.isTypeReferenceNode(type) &&
    ts.isIdentifier(type.typeName) &&
    type.typeName.text === 'Promise' &&
    type.typeArguments?.[0]?.kind === ts.SyntaxKind.NeverKeyword
  );
}

function handlerMethod(route: AdminRoute): ts.MethodDeclaration {
  const source = parseRepoFile(route.file);
  let found: ts.MethodDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isClassDeclaration(node) && node.name?.text === route.controller) {
      for (const member of node.members) {
        if (
          ts.isMethodDeclaration(member) &&
          ts.isIdentifier(member.name) &&
          member.name.text === route.handler
        ) {
          found = member;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!found) throw new Error(`${route.id}: handler not found`);
  return found;
}

describe('admin routes never exist only to refuse (ADMIN-HIGH-011)', () => {
  const files = listAdminSourceFiles();

  it('scans admin-api production source', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it('declares no NotImplemented route — an unimplemented route is an undeclared route', () => {
    const offenders = files.filter((rel) =>
      NOT_IMPLEMENTED.test(stripComments(readFileSync(resolve(REPO_ROOT, rel), 'utf8'))),
    );
    expect(offenders).toEqual([]);
  });

  it('answers 410 Gone only where a resource is genuinely gone (allowlisted with a reason)', () => {
    const allowed = new Set(GONE_ALLOWED.map((entry) => entry.file));
    const offenders = files.filter(
      (rel) =>
        !allowed.has(rel) &&
        GONE.test(stripComments(readFileSync(resolve(REPO_ROOT, rel), 'utf8'))),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps the Gone allowlist honest — every entry still throws Gone and says why', () => {
    for (const entry of GONE_ALLOWED) {
      expect(files).toContain(entry.file);
      expect(GONE.test(stripComments(readFileSync(resolve(REPO_ROOT, entry.file), 'utf8')))).toBe(
        true,
      );
      expect(entry.reason.trim().length).toBeGreaterThan(20);
    }
  });

  it('has no route handler whose body reduces to a throw or whose type is never', () => {
    const problems: string[] = [];
    for (const route of allAdminRoutes()) {
      const method = handlerMethod(route);
      if (returnsNever(method)) {
        problems.push(`${route.id} (line ${route.line}) is typed never — it can only refuse`);
      } else if (bodyReducesToThrow(method)) {
        problems.push(`${route.id} (line ${route.line}) does nothing but throw`);
      }
    }
    expect(problems).toEqual([]);
  });

  describe('body shape detection', () => {
    const methodOf = (src: string): ts.MethodDeclaration => {
      const source = ts.createSourceFile('x.ts', src, ts.ScriptTarget.Latest, true);
      let method: ts.MethodDeclaration | undefined;
      const visit = (node: ts.Node): void => {
        if (ts.isMethodDeclaration(node)) method = node;
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (!method) throw new Error('no method');
      return method;
    };

    it('flags a lone throw, a throw helper, a never type, with void silencers ignored', () => {
      expect(bodyReducesToThrow(methodOf('class A { m() { throw new Error("x"); } }'))).toBe(true);
      expect(
        bodyReducesToThrow(methodOf('class A { m(a: string) { void a; this.throwGone(); } }')),
      ).toBe(true);
      expect(bodyReducesToThrow(methodOf('class A { m() { return this.throwGone(); } }'))).toBe(
        true,
      );
      expect(returnsNever(methodOf('class A { m(): never { throw new Error("x"); } }'))).toBe(true);
      expect(
        returnsNever(methodOf('class A { async m(): Promise<never> { throw new Error("x"); } }')),
      ).toBe(true);
    });

    it('does not flag a guarded throw or a real body', () => {
      expect(
        bodyReducesToThrow(
          methodOf('class A { m(x: number) { if (x < 0) throw new Error("x"); return x; } }'),
        ),
      ).toBe(false);
      expect(bodyReducesToThrow(methodOf('class A { m() { return this.svc.load(); } }'))).toBe(
        false,
      );
      expect(
        returnsNever(methodOf('class A { m(): Promise<void> { return this.svc.run(); } }')),
      ).toBe(false);
    });
  });
});
