import { describe, expect, it } from 'vitest';

import type { NavigationItem } from '../../types';
import {
  ADMIN_NAV_SECTIONS,
  ADMIN_ROUTE_REDIRECTS,
  ADMIN_ROUTES,
  buildSuperAdminNavigation,
  getAdminRoute,
} from '../admin-routes';

function collectPaths(items: readonly NavigationItem[]): string[] {
  const paths: string[] = [];
  for (const item of items) {
    if (item.path) paths.push(item.path);
    if (item.children) paths.push(...collectPaths(item.children));
  }
  return paths;
}

describe('admin page-route and navigation authority', () => {
  const navigation = buildSuperAdminNavigation();
  const navigationPaths = collectPaths(navigation);

  it('has unique ids, full paths, and remote paths', () => {
    expect(new Set(ADMIN_ROUTES.map((route) => route.id)).size).toBe(ADMIN_ROUTES.length);
    expect(new Set(ADMIN_ROUTES.map((route) => route.path)).size).toBe(ADMIN_ROUTES.length);
    expect(new Set(ADMIN_ROUTES.map((route) => route.remotePath)).size).toBe(ADMIN_ROUTES.length);
  });

  it('projects every visible route into navigation exactly once', () => {
    const visiblePaths = ADMIN_ROUTES.filter((route) => route.visible).map((route) => route.path);
    expect([...navigationPaths].sort()).toEqual([...visiblePaths].sort());
  });

  it('gives every hidden page a declared route into it', () => {
    const unreachable = ADMIN_ROUTES.filter(
      (route) => !route.visible && !('reachableVia' in route && route.reachableVia.trim()),
    );
    expect(unreachable).toEqual([]);
  });

  it('resolves redirect targets through canonical route ids', () => {
    for (const redirect of ADMIN_ROUTE_REDIRECTS) {
      expect(getAdminRoute(redirect.targetRouteId).path).toMatch(/^\/admin(?:\/|$)/u);
    }
  });

  it('renders sections in their canonical order', () => {
    expect(navigation.map((item) => item.id)).toEqual(
      ADMIN_NAV_SECTIONS.map((section) => section.navId),
    );
  });

  it('freezes the route authority and every navigation projection at runtime', () => {
    expect(Object.isFrozen(ADMIN_NAV_SECTIONS)).toBe(true);
    expect(ADMIN_NAV_SECTIONS.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(ADMIN_ROUTES)).toBe(true);
    expect(ADMIN_ROUTES.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(ADMIN_ROUTE_REDIRECTS)).toBe(true);
    expect(ADMIN_ROUTE_REDIRECTS.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(navigation)).toBe(true);
    expect(navigation.every(Object.isFrozen)).toBe(true);
    expect(
      navigation.every(
        (item) => item.children === undefined || (Object.isFrozen(item.children) && item.children.every(Object.isFrozen)),
      ),
    ).toBe(true);
    expect(Reflect.set(ADMIN_ROUTES[0], 'label', 'mutated')).toBe(false);
  });

  it('surfaces the ten historically orphaned pages', () => {
    const expected = [
      '/admin/billing/plans',
      '/admin/billing/usage',
      '/admin/settings/provisioning',
      '/admin/messaging/monitoring',
      '/admin/messaging/tenants',
      '/admin/messaging/audit',
      '/admin/messaging/compliance',
      '/admin/messaging/retention',
      '/admin/messaging/ai-dashboard',
      '/admin/messaging/ai-personas',
    ];
    for (const path of expected) expect(navigationPaths).toContain(path);
  });
});
