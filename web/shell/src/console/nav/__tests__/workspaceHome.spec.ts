/**
 * workspaceHome (design digest §10.3): choosing a workspace in the module menu
 * opens its first page the viewer may see, in area → group → page order.
 */
import { describe, expect, it } from 'vitest';

import { buildConsoleNav } from '../buildConsoleNav';
import { workspaceHome } from '../workspaceHome';

import { ALL_CAPABILITIES, ALL_MODULES, navInput } from './viewers.fixture';

describe('workspaceHome', () => {
  it("opens a workspace on its first visible page, as the viewer's nav lists it", () => {
    const nav = buildConsoleNav(
      navInput({ role: 'TENANT_ADMIN', modules: ALL_MODULES, permissions: ALL_CAPABILITIES }),
    );
    for (const workspace of nav) {
      const first = workspace.areas[0]?.groups[0]?.pages[0];
      expect(first, workspace.id).toBeDefined();
      expect(workspaceHome(workspace)).toBe(first?.path);
    }
  });

  it('skips what the viewer cannot see: the home follows the built nav, not the definitions', () => {
    const admin = buildConsoleNav(
      navInput({ role: 'TENANT_ADMIN', modules: ['hr'], permissions: ALL_CAPABILITIES }),
    );
    const user = buildConsoleNav(
      navInput({ role: 'MODULE_USER', modules: ['hr'], permissions: [] }),
    );
    const adminOrg = admin.find((workspace) => workspace.id === 'org');
    const userOrg = user.find((workspace) => workspace.id === 'org');
    // The company dashboard opens for every member (an admin's cards or a
    // member's notices), so it is Company's home for both.
    expect(adminOrg && workspaceHome(adminOrg)).toBe('/tenant');
    expect(userOrg && workspaceHome(userOrg)).toBe('/tenant');
    const ctlUser = buildConsoleNav(
      navInput({ role: 'MODULE_USER', modules: ['sensor'], permissions: [] }),
    ).find((workspace) => workspace.id === 'ctl');
    expect(ctlUser && workspaceHome(ctlUser)).toBe('/dashboard/control');
  });

  it('has no home for a workspace with nothing in it', () => {
    expect(workspaceHome({ areas: [] })).toBeUndefined();
    expect(workspaceHome({ areas: [{ groups: [{ pages: [] }] }] })).toBeUndefined();
  });
});
