import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * RC-6 route-declaration-order discipline (APA-235 / APA-307 / APA-313 / APA-352).
 *
 * NestJS (Express under the hood) matches routes in DECLARATION order. A static
 * route declared AFTER a parameterized sibling of the same shape is unreachable:
 * the `:param` route matches first and swallows the request (e.g. GET
 * `/ip-access/stats` resolving to `@Get(':id')` with id='stats'). This gate fails
 * the build when any controller declares a static-segment route that an earlier
 * same-method parameterized route would shadow — so the class cannot reappear.
 *
 * There is deliberately NO allowlist. Comments are stripped before scanning so a
 * doc comment that mentions a route decorator is not mistaken for a declaration.
 */
const REPO_ROOT = execSync('git rev-parse --show-toplevel', {
  encoding: 'utf-8',
}).trim();

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

interface Route {
  readonly method: string;
  readonly path: string;
}

function routesOf(src: string): Route[] {
  const clean = stripComments(src);
  const routes: Route[] = [];
  const re = /@(Get|Post|Put|Delete|Patch)\(\s*(?:'([^']*)')?\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const method = m[1];
    if (method === undefined) continue;
    routes.push({ method, path: m[2] ?? '' });
  }
  return routes;
}

/** Can `earlier` (which contains a `:param`) match the concrete static `later`? */
function shadows(earlier: string, later: string): boolean {
  const e = earlier.split('/');
  const l = later.split('/');
  if (e.length !== l.length) return false;
  return e.every((seg, i) => seg.startsWith(':') || seg === l[i]);
}

function shadowedRoutes(): string[] {
  const out = execSync(
    "git ls-files -- 'apps/admin-api-service/src/**/*.controller.ts'",
    { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 },
  );
  const violations: string[] = [];
  for (const rel of out.split('\n').filter(Boolean)) {
    const routes = routesOf(readFileSync(resolve(REPO_ROOT, rel), 'utf-8'));
    for (let i = 0; i < routes.length; i++) {
      const r = routes[i];
      if (r === undefined || r.path === '' || r.path.includes(':')) continue;
      for (let j = 0; j < i; j++) {
        const e = routes[j];
        if (e === undefined) continue;
        if (
          e.method === r.method &&
          e.path.includes(':') &&
          shadows(e.path, r.path)
        ) {
          violations.push(
            `  ${rel}: ${r.method} '${r.path}' is shadowed by the earlier ` +
              `${e.method} '${e.path}'`,
          );
          break;
        }
      }
    }
  }
  return violations;
}

describe('admin-api route declaration order (RC-6)', () => {
  it('no static route is shadowed by an earlier same-method parameterized route', () => {
    const violations = shadowedRoutes();
    if (violations.length > 0) {
      throw new Error(
        `${violations.length} route(s) are declared after a parameterized sibling ` +
          `that shadows them — NestJS matches in declaration order, so they are ` +
          `unreachable:\n${violations.join('\n')}\n\nDeclare each static-segment ` +
          `route BEFORE its :param sibling in the controller.`,
      );
    }
    expect(violations).toEqual([]);
  });
});
