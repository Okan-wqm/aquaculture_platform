/**
 * INVARIANT — a parameterised admin route never precedes a literal sibling
 * it would swallow (ADMIN-HIGH-011, route shadowing).
 *
 * Express matches routes in registration order and NestJS registers a
 * controller's handlers in declaration order. `@Get(':id')` declared above
 * `@Get('scheduled')` means `GET /jobs/scheduled` reaches the `:id` handler
 * with `id = 'scheduled'`: the literal route exists in the source, in the
 * contract test and in the OpenAPI document, and is unreachable at runtime.
 *
 * Rule, per verb (`@All` collides with every verb):
 *   - inside one controller, a route declared BEFORE a literal sibling must
 *     not shadow it (declaration order is the fix — literals first);
 *   - across controllers sharing a prefix, module registration order decides
 *     and is not readable from the source, so ANY shadowing pair is refused
 *     regardless of order (put the literal on the same controller, or give
 *     the parameterised route a narrower shape).
 *
 * The scan is `tests/invariants/lib/admin-route-table.ts`, shared with
 * `admin-no-stub-routes.spec.ts`.
 */
import { allAdminRoutes, shadows, type AdminRoute } from './lib/admin-route-table';

function verbsCollide(a: AdminRoute, b: AdminRoute): boolean {
  return a.verb === b.verb || a.verb === 'All' || b.verb === 'All';
}

function describeRoute(route: AdminRoute): string {
  return `${route.verb.toUpperCase()} /${route.fullPath} (${route.file}:${route.line} ${route.handler})`;
}

describe('admin route registration order (ADMIN-HIGH-011)', () => {
  const routes = allAdminRoutes();

  it('sees the admin route table', () => {
    expect(routes.length).toBeGreaterThan(400);
  });

  it('declares every literal route before a parameterised sibling that would match it', () => {
    const problems: string[] = [];
    const byController = new Map<string, AdminRoute[]>();
    for (const route of routes) {
      const key = `${route.file}#${route.controller}`;
      byController.set(key, [...(byController.get(key) ?? []), route]);
    }
    for (const controllerRoutes of byController.values()) {
      for (const earlier of controllerRoutes) {
        for (const later of controllerRoutes) {
          if (later.order <= earlier.order || !verbsCollide(earlier, later)) continue;
          if (shadows(earlier, later)) {
            problems.push(
              `${describeRoute(earlier)} is declared before ${describeRoute(later)} and would receive its requests`,
            );
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('has no shadowing pair across controllers that share a prefix', () => {
    const problems: string[] = [];
    for (const a of routes) {
      for (const b of routes) {
        if (a.file === b.file && a.controller === b.controller) continue;
        if (a.prefix !== b.prefix || !verbsCollide(a, b)) continue;
        if (shadows(a, b)) {
          problems.push(
            `${describeRoute(a)} would shadow ${describeRoute(b)} depending on module registration order`,
          );
        }
      }
    }
    expect(problems).toEqual([]);
  });

  describe('shadows()', () => {
    const route = (fullPath: string, order: number): AdminRoute => ({
      id: `x#${order}`,
      file: 'x.controller.ts',
      controller: 'X',
      prefix: '',
      verb: 'Get',
      path: fullPath,
      fullPath,
      handler: `h${order}`,
      line: order,
      order,
    });

    it('is true when a parameter sits over a literal and every literal agrees', () => {
      expect(shadows(route('jobs/:id', 0), route('jobs/scheduled', 1))).toBe(true);
      expect(shadows(route('tenants/:id/:sub', 0), route('tenants/:id/stats', 1))).toBe(true);
    });

    it('is false for different lengths, disagreeing literals, or a literal over a parameter', () => {
      expect(shadows(route('jobs/:id', 0), route('jobs/:id/logs', 1))).toBe(false);
      expect(shadows(route('jobs/:id', 0), route('queues/scheduled', 1))).toBe(false);
      expect(shadows(route('jobs/scheduled', 0), route('jobs/:id', 1))).toBe(false);
      expect(shadows(route('jobs/:id', 0), route('jobs/:name', 1))).toBe(false);
    });
  });
});
