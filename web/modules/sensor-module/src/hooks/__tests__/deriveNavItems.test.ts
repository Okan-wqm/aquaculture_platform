/**
 * T7h: navItems mapping — package screens derive the sidenav nav items
 * (label = screen name, icon = configured icon || screenType, hierarchy
 * flattened one level via parentId).
 */

import { describe, it, expect } from 'vitest';

import { deriveNavItems } from '../../components/scada-operator/OperatorBootstrap';
import type { ScreenDef } from '../../store/scada/types';

function screen(partial: Partial<ScreenDef>): ScreenDef {
  return {
    id: 's-1',
    name: 'Screen',
    screenType: 'process',
    isDefault: false,
    icon: '',
    layout: { type: 'grid', cols: 40, rows: 24 },
    widgets: [],
    edges: [],
    ...partial,
  };
}

describe('T7h deriveNavItems', () => {
  it('maps screens → navItems with label/icon from the screen definition', () => {
    const nav = deriveNavItems([
      screen({ id: 'main', name: 'Main View', icon: 'dashboard' }),
      screen({ id: 'tanks', name: 'Tanks', screenType: 'overview', icon: '' }),
    ]);

    expect(nav).toEqual([
      { id: 'nav-main', screenId: 'main', label: 'Main View', icon: 'dashboard', children: [] },
      // icon falls back to the screen type when not configured
      { id: 'nav-tanks', screenId: 'tanks', label: 'Tanks', icon: 'overview', children: [] },
    ]);
  });

  it('nests child screens one level under their parent (parentId)', () => {
    const nav = deriveNavItems([
      screen({ id: 'root', name: 'Plant', sortOrder: 1 }),
      screen({ id: 'child-b', name: 'B Line', parentId: 'root', sortOrder: 2 }),
      screen({ id: 'child-a', name: 'A Line', parentId: 'root', sortOrder: 1 }),
      screen({ id: 'other', name: 'Other', sortOrder: 0 }),
    ]);

    expect(nav.map((n) => n.screenId)).toEqual(['other', 'root']); // sortOrder respected
    const root = nav.find((n) => n.screenId === 'root')!;
    expect(root.children?.map((c) => c.screenId)).toEqual(['child-a', 'child-b']);
  });

  it('returns an empty list for an empty screen set', () => {
    expect(deriveNavItems([])).toEqual([]);
  });
});
