/**
 * The console shell's pure decisions (FE-HIGH-334): which entry a location
 * lights and how the page's own title renders under the console's h1, what a
 * role preview shows, and which stored preferences are trusted.
 */
import { describe, expect, it } from 'vitest';

import { buildConsoleNav, type Workspace } from '../../nav';
import { ALL_CAPABILITIES, ALL_MODULES, navInput } from '../../nav/__tests__/viewers.fixture';
import { resolveActiveEntry } from '../activeEntry';
import { consolePageTitle } from '../pageTitle';
import { parseStoredCollapsed, parseStoredWorkspace } from '../storedPreferences';
import { countConsolePages, isPathInNav, viewAsNavInput } from '../viewAs';

const ADMIN = navInput({
  role: 'TENANT_ADMIN',
  modules: ALL_MODULES,
  permissions: ALL_CAPABILITIES,
});
const NAV = buildConsoleNav(ADMIN);

function workspace(id: Workspace['id']): Workspace {
  const found = NAV.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no workspace ${id}`);
  return found;
}

describe('resolveActiveEntry', () => {
  const aqua = workspace('aqua');

  it("lights the entry's area and page, and hides a page title the console h1 repeats", () => {
    const entry = resolveActiveEntry('/sites/tanks', aqua);
    expect(entry?.page.id).toBe('tanks');
    expect(entry?.area.id).toBe(entry?.rail.areaId);
    expect(entry?.rail).toEqual({ areaId: entry?.area.id, pageId: 'tanks' });
    expect(entry?.titleMode).toBe('hidden');
  });

  it('names the level-3 tab the location opens', () => {
    const entry = resolveActiveEntry('/sites/tanks?tab=cleanerFish', aqua);
    expect(entry?.rail).toEqual({ areaId: entry?.area.id, pageId: 'tanks', tabId: 'cleanerFish' });
    expect(entry?.titleMode).toBe('hidden');
    expect(resolveActiveEntry('/sites/reports/biomass', aqua)?.rail.tabId).toBe('biomass');
  });

  it("shows a record's own title under the parent entry on a detail route", () => {
    const entry = resolveActiveEntry('/sites/batch/b-1/feeding', aqua);
    expect(entry?.page.id).toBe('tanks');
    expect(entry?.titleMode).toBe('subtitle');
  });

  it('lights nothing outside the workspace, or without one', () => {
    expect(resolveActiveEntry('/sensor/plc', aqua)).toBeUndefined();
    expect(resolveActiveEntry('/sites/tanks', undefined)).toBeUndefined();
  });
});

describe('role preview (view as)', () => {
  it("shows a role's console as a module user holding exactly the role's permissions", () => {
    const input = viewAsNavInput(ADMIN, { resourcePermissions: ['users:view'] });
    expect(input.role).toBe('MODULE_USER');
    expect(input.modules).toBe(ADMIN.modules);
    expect(input.hasPermission('users:view')).toBe(true);
    expect(input.hasPermission('roles:view')).toBe(false);

    const preview = buildConsoleNav(input);
    const pageIds = preview.flatMap((ws) =>
      ws.areas.flatMap((area) =>
        area.groups.flatMap((group) => group.pages.map((page) => page.id)),
      ),
    );
    expect(pageIds).toContain('tenant-users');
    expect(pageIds).not.toContain('tenant-roles');
    expect(pageIds).not.toContain('tenant-billing');
  });

  it('counts the distinct pages a nav offers, a shared page once', () => {
    const shared = NAV.flatMap((ws) =>
      ws.areas.flatMap((area) => area.groups.flatMap((group) => group.pages)),
    ).filter((page) => page.id === 'tasks');
    expect(shared.length).toBeGreaterThan(1);
    const count = countConsolePages(NAV);
    const preview = countConsolePages(
      buildConsoleNav(viewAsNavInput(ADMIN, { resourcePermissions: [] })),
    );
    expect(count).toBeGreaterThan(preview);
    expect(countConsolePages([])).toBe(0);
  });

  it('tells whether any workspace of a nav claims a location', () => {
    expect(isPathInNav('/tenant/billing', NAV)).toBe(true);
    const preview = buildConsoleNav(viewAsNavInput(ADMIN, { resourcePermissions: [] }));
    expect(isPathInNav('/tenant/billing', preview)).toBe(false);
    expect(isPathInNav('/sites/tanks', preview)).toBe(true);
  });
});

describe('stored console preferences', () => {
  it('trusts only a known workspace id', () => {
    expect(parseStoredWorkspace('gh')).toBe('gh');
    expect(parseStoredWorkspace('org')).toBe('org');
    expect(parseStoredWorkspace('mars')).toBeNull();
    expect(parseStoredWorkspace(3)).toBeNull();
    expect(parseStoredWorkspace(null)).toBeNull();
  });

  it('trusts only a boolean rail preference; anything else leaves it to the window', () => {
    expect(parseStoredCollapsed(true)).toBe(true);
    expect(parseStoredCollapsed(false)).toBe(false);
    expect(parseStoredCollapsed('true')).toBeNull();
    expect(parseStoredCollapsed(null)).toBeNull();
  });
});

describe('consolePageTitle', () => {
  const aqua = workspace('aqua');

  it('names the page, then its workspace, as the nav localized them', () => {
    const entry = resolveActiveEntry('/sites/tanks', aqua);
    expect(entry?.tab).toBeUndefined();
    expect(consolePageTitle(entry, aqua)).toBe(`${entry?.page.label} · ${aqua.label}`);
  });

  // A tab change is a navigation the reader has to hear about.
  it('puts the tab the location opens first', () => {
    const entry = resolveActiveEntry('/sites/tanks?tab=cleanerFish', aqua);
    expect(entry?.tab?.id).toBe('cleanerFish');
    expect(consolePageTitle(entry, aqua)).toBe(
      `${entry?.tab?.label} · ${entry?.page.label} · ${aqua.label}`,
    );
  });

  it('names a location outside the nav by its workspace, and none without one', () => {
    expect(consolePageTitle(undefined, aqua)).toBe(aqua.label);
    expect(consolePageTitle(undefined, undefined)).toBe('');
  });
});
