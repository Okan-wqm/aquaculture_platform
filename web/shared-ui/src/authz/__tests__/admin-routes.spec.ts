import { describe, it, expect } from 'vitest';

import type { NavigationItem } from '../../types';
import { ADMIN_ROUTES, ADMIN_NAV_SECTIONS, buildSuperAdminNavigation } from '../admin-routes';

/**
 * APA-255 / APA-256 — the SUPER_ADMIN sidebar is DERIVED from ADMIN_ROUTES, so
 * every visible route surfaces automatically and the shell can no longer omit a
 * mounted page. These assertions pin that derivation (the reachability of the
 * mounted route table itself is enforced by the invariant gate
 * tests/invariants/admin-route-nav-reachability.spec.ts).
 */
function collectPaths(items: NavigationItem[]): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.path !== undefined && item.path !== '') out.push(item.path);
    if (item.children !== undefined) out.push(...collectPaths(item.children));
  }
  return out;
}

describe('admin nav derivation (APA-255/256)', () => {
  const nav = buildSuperAdminNavigation();
  const navPaths = collectPaths(nav);

  it('surfaces every visible manifest route in the sidebar', () => {
    const missing = ADMIN_ROUTES.filter((r) => r.visible && !navPaths.includes(r.path)).map(
      (r) => r.path,
    );
    expect(missing).toEqual([]);
  });

  it('makes the 10 previously-orphaned pages reachable', () => {
    const previouslyOrphaned = [
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
    for (const path of previouslyOrphaned) {
      expect(navPaths).toContain(path);
    }
  });

  it('renders one nav item per section, in manifest order', () => {
    expect(nav.map((item) => item.id)).toEqual(ADMIN_NAV_SECTIONS.map((section) => section.navId));
  });

  it('leaf sections resolve to a single direct item, group sections to children', () => {
    for (const section of ADMIN_NAV_SECTIONS) {
      const item = nav.find((navItem) => navItem.id === section.navId);
      expect(item).toBeDefined();
      if (section.kind === 'leaf') {
        expect(item?.path).toBeTruthy();
        expect(item?.children).toBeUndefined();
      } else {
        expect(item?.children?.length ?? 0).toBeGreaterThan(0);
        expect(item?.path).toBeUndefined();
      }
    }
  });

  it('has no duplicate nav paths', () => {
    const dupes = navPaths.filter((path, index) => navPaths.indexOf(path) !== index);
    expect(dupes).toEqual([]);
  });
});
