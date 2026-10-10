/**
 * tenantRail — grouping the tenant navigation into the Suderra rail's
 * sections (FE-HIGH-313). Grouping places items; it must never drop one.
 */
import type { I18nContextValue, NavigationItem } from '@aquaculture/shared-ui';
import { describe, expect, it } from 'vitest';

import { buildTenantRailSections } from '../tenantRail';

const t: I18nContextValue['t'] = (key) => `t:${key}`;

const entry = (id: string, extra: Partial<NavigationItem> = {}): NavigationItem => ({
  id,
  label: id,
  path: `/${id}`,
  ...extra,
});

const adminEntries: NavigationItem[] = [
  entry('company'),
  entry('tenant-dashboard'),
  entry('messaging'),
  entry('tenant-users'),
  entry('tenant-roles'),
  entry('tenant-modules'),
  entry('tenant-communication', {
    path: undefined,
    children: [entry('tenant-messages'), entry('tenant-support'), entry('tenant-announcements')],
  }),
  entry('tenant-database'),
  entry('tenant-audit-log'),
  entry('tenant-billing'),
  entry('tenant-activity'),
  entry('tenant-settings'),
  entry('tenant-devices'),
];

const farm = entry('farm-module', {
  path: undefined,
  children: [entry('sites-tanks'), entry('sites-unknown-page')],
});

function ids(items: NavigationItem[]): string[] {
  return items.map((item) => item.id);
}

describe('buildTenantRailSections', () => {
  it('groups the tenant admin console into the five Suderra sections', () => {
    const sections = buildTenantRailSections({
      entries: adminEntries,
      modules: [farm],
      isTenantAdmin: true,
      t,
    });
    expect(sections.map((section) => section.label)).toEqual([
      't:nav.overview',
      't:nav.section.people',
      't:nav.modules',
      't:nav.communication',
      't:nav.section.account',
    ]);
    const byId = Object.fromEntries(sections.map((section) => [section.id, ids(section.items)]));
    expect(byId['sec-overview']).toEqual(['company', 'tenant-dashboard', 'messaging']);
    expect(byId['sec-people']).toEqual(['tenant-users', 'tenant-roles', 'tenant-activity']);
    expect(byId['sec-modules']).toEqual(['tenant-modules', 'farm-module']);
    // The communication group's children are the section's entries.
    expect(byId['sec-comms']).toEqual([
      'tenant-messages',
      'tenant-support',
      'tenant-announcements',
    ]);
    expect(byId['sec-account']).toEqual([
      'tenant-devices',
      'tenant-database',
      'tenant-audit-log',
      'tenant-billing',
      'tenant-settings',
    ]);
  });

  it('never drops an entry the grouping does not name', () => {
    const sections = buildTenantRailSections({
      entries: [...adminEntries, entry('tenant-new-page')],
      modules: [],
      isTenantAdmin: true,
      t,
    });
    const all = sections.flatMap((section) => ids(section.items));
    expect(all).toContain('tenant-new-page');
    expect(new Set(all).size).toBe(all.length);
  });

  it('gives entries and module children rail icons, keeping an unknown child icon', () => {
    const sections = buildTenantRailSections({
      entries: adminEntries,
      modules: [{ ...farm, children: [entry('sites-tanks'), entry('sites-x', { icon: 'bell' })] }],
      isTenantAdmin: true,
      t,
    });
    const modules = sections.find((section) => section.id === 'sec-modules');
    const farmItem = modules?.items.find((item) => item.id === 'farm-module');
    expect(farmItem?.icon).toBe('waves');
    expect(farmItem?.children?.map((child) => child.icon)).toEqual(['droplet', 'bell']);
  });

  it('shows a module user their own overview and only the delegated tenant entries', () => {
    const sections = buildTenantRailSections({
      entries: [entry('company'), entry('dashboard'), entry('reports'), entry('tenant-users')],
      modules: [],
      isTenantAdmin: false,
      t,
    });
    expect(sections.map((section) => section.id)).toEqual(['sec-overview', 'sec-people']);
    expect(ids(sections[0]?.items ?? [])).toEqual(['company', 'dashboard', 'reports']);
  });
});
