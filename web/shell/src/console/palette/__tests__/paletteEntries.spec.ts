/**
 * The console's command-palette entries (FE-HIGH-334, design README §8):
 * pages from the nav the viewer was built (every workspace, the current one
 * first), people and devices only where a page can open them, and the typed
 * commands handed back to the shell.
 */
import { rankPalette, type PaletteCommand, type PaletteSources } from '@aquaculture/shared-ui';
import { describe, expect, it, vi } from 'vitest';

import type { PaletteSources as PaletteData } from '../../data';
import { buildConsoleNav } from '../../nav';
import { ALL_CAPABILITIES, ALL_MODULES, navInput } from '../../nav/__tests__/viewers.fixture';
import {
  devicePathFor,
  devicesSource,
  hasPage,
  palettePages,
  paletteSuggestions,
  peopleSource,
  runPaletteCommand,
} from '../paletteEntries';

const t = (key: string, params?: Record<string, string | number>): string =>
  params === undefined ? key : `${key}${JSON.stringify(params)}`;

const ADMIN = buildConsoleNav(
  navInput({ role: 'TENANT_ADMIN', modules: ALL_MODULES, permissions: ALL_CAPABILITIES }),
);

describe('palettePages', () => {
  it('lists every page of the nav once, the current workspace first', () => {
    const pages = palettePages(ADMIN, 'ctl');
    const paths = pages.map((page) => page.path);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths[0]).toBe(ADMIN.find((ws) => ws.id === 'ctl')?.areas[0]?.groups[0]?.pages[0]?.path);
    expect(paths).toContain('/sites/tanks');
    expect(paths).toContain('/tenant/billing');
    // A shared page is listed under the current workspace: its keywords name it.
    const tasks = pages.find((page) => page.path === '/sites/tasks');
    expect(tasks?.keywords).toContain('«nav.workspace.ctl»');
  });

  it('offers nothing the viewer cannot open', () => {
    const user = buildConsoleNav(
      navInput({ role: 'MODULE_USER', modules: ['hr'], permissions: [] }),
    );
    const paths = palettePages(user, 'org').map((page) => page.path);
    expect(paths).not.toContain('/tenant/billing');
    expect(paths).not.toContain('/sites/tanks');
    expect(paths).toContain('/hr/today');
  });
});

describe('paletteSuggestions', () => {
  it('names the design’s curated pages the current workspace lists, in the design’s order', () => {
    // Design (tenant-core paletteItems): dashboard, users, roles, devices,
    // billing, tanks — only those the current workspace's nav has.
    expect(paletteSuggestions(ADMIN, 'org')).toEqual([
      '/dashboard',
      '/tenant/users',
      '/tenant/roles',
      '/tenant/devices',
      '/tenant/billing',
    ]);
    expect(paletteSuggestions(ADMIN, 'aqua')).toEqual([
      '/dashboard',
      '/tenant/roles',
      '/sites/tanks',
    ]);
    expect(paletteSuggestions(ADMIN, 'ctl')).toEqual([
      '/dashboard',
      '/tenant/roles',
      '/sensor/devices',
    ]);
  });

  it('leaves out what the viewer cannot open, and leaves the choice to the palette without a workspace', () => {
    const user = buildConsoleNav(
      navInput({ role: 'MODULE_USER', modules: ['farm'], permissions: [] }),
    );
    expect(paletteSuggestions(user, 'aqua')).toEqual(['/dashboard', '/sites/tanks']);
    expect(paletteSuggestions(ADMIN, undefined)).toBeUndefined();
  });

  it('suggests only pages the palette lists', () => {
    const listed = new Set(palettePages(ADMIN, 'org').map((page) => page.path));
    for (const path of paletteSuggestions(ADMIN, 'org') ?? []) expect(listed.has(path)).toBe(true);
  });
});

describe('people and devices', () => {
  it('links a person to the users list filtered to them, hinted with their role', () => {
    expect(hasPage(ADMIN, 'tenant-users')).toBe(true);
    const ready: PaletteData['people'] = {
      status: 'ready',
      items: [
        { id: 'u1', name: 'İlker Şahin', email: 'ilker@suderra.test', role: 'MODULE_MANAGER' },
      ],
    };
    const source = peopleSource(ready, t);
    expect(source.status).toBe('ready');
    if (source.status !== 'ready') return;
    expect(source.entries[0]).toMatchObject({
      kind: 'link',
      id: 'u1',
      label: 'İlker Şahin',
      keywords: ['ilker@suderra.test'],
      path: '/tenant/users?search=%C4%B0lker%20%C5%9Eahin',
      hint: 'console.role.MODULE_MANAGER',
    });
  });

  it('lists a user who has set no name by their email', () => {
    const source = peopleSource(
      {
        status: 'ready',
        items: [{ id: 'u3', name: '', email: 'ops@suderra.test', role: 'TENANT_ADMIN' }],
      },
      t,
    );
    expect(source.status === 'ready' && source.entries[0]).toMatchObject({
      label: 'ops@suderra.test',
      path: '/tenant/users?search=ops%40suderra.test',
      hint: 'console.role.TENANT_ADMIN',
    });
  });

  it('passes a source that is not ready through without entries', () => {
    expect(peopleSource({ status: 'loading', items: null }, t)).toEqual({ status: 'loading' });
    expect(devicesSource({ status: 'error', items: null }, () => '/x', t)).toEqual({
      status: 'error',
    });
    expect(devicesSource({ status: 'unavailable', items: null }, null, t)).toEqual({
      status: 'unavailable',
    });
  });

  it('opens a device on the sensor module when the viewer has it, else on the tenant devices page', () => {
    expect(devicePathFor(ADMIN)?.('d 1')).toBe('/sensor/devices/edge/d%201');
    const noSensor = buildConsoleNav(
      navInput({ role: 'TENANT_ADMIN', modules: ['farm'], permissions: ALL_CAPABILITIES }),
    );
    expect(devicePathFor(noSensor)?.('d1')).toBe('/tenant/devices/d1');
    const user = buildConsoleNav(
      navInput({ role: 'MODULE_USER', modules: ['farm'], permissions: [] }),
    );
    expect(devicePathFor(user)).toBeNull();
  });

  it('names a device by its name, matches its code and site, and hints the site and state', () => {
    const source = devicesSource(
      {
        status: 'ready',
        items: [{ id: 'd1', code: 'EG-01', name: 'Sea pens', isOnline: false, siteName: 'Vikna' }],
      },
      (id) => `/sensor/devices/edge/${id}`,
      t,
    );
    expect(source.status === 'ready' && source.entries[0]).toMatchObject({
      label: 'Sea pens',
      keywords: ['EG-01', 'Vikna'],
      path: '/sensor/devices/edge/d1',
      hint: 'console.palette.hint.device{"site":"Vikna","state":"console.palette.hint.offline"}',
    });
  });

  it('hints only the state of a device whose site the viewer cannot name', () => {
    const source = devicesSource(
      {
        status: 'ready',
        items: [{ id: 'd2', code: 'EG-02', name: 'Hatchery', isOnline: true, siteName: null }],
      },
      (id) => `/tenant/devices/${id}`,
      t,
    );
    expect(source.status === 'ready' && source.entries[0]).toMatchObject({
      keywords: ['EG-02'],
      hint: 'console.palette.hint.online',
    });
  });
});

describe('people and devices through the palette’s one matcher', () => {
  const people: PaletteData['people'] = {
    status: 'ready',
    items: [
      { id: 'u1', name: 'Fehmi Kaya', email: 'fehmi@suderra.test', role: 'MODULE_USER' },
      { id: 'u2', name: 'İlker Şahin', email: 'ilker@suderra.test', role: 'MODULE_MANAGER' },
      { id: 'u3', name: 'Bjørn Ærlig', email: 'b.aerlig@suderra.test', role: 'MODULE_USER' },
    ],
  };
  const devices: PaletteData['devices'] = {
    status: 'ready',
    items: [
      {
        id: 'd1',
        code: 'EG-KLK-03',
        name: 'Kuluçka gateway',
        isOnline: true,
        siteName: 'Kuluçkahane',
      },
      { id: 'd2', code: 'EG-SEA-01', name: 'Sea pens', isOnline: false, siteName: 'Frøya' },
    ],
  };
  const sources: PaletteSources = {
    pages: [],
    people: peopleSource(people, t),
    devices: devicesSource(devices, (id) => `/sensor/devices/edge/${id}`, t),
    commands: [],
  };
  const found = (query: string): string[] =>
    rankPalette(sources, query).flatMap((section) => section.entries.map((entry) => entry.label));

  it('finds a person by surname first, by a query with extra spaces, and without diacritics', () => {
    expect(found('kaya fehmi')).toEqual(['Fehmi Kaya']);
    expect(found('fehmi  kaya')).toEqual(['Fehmi Kaya']);
    expect(found('ilker sahin')).toEqual(['İlker Şahin']);
  });

  it('finds a Norwegian name typed with base letters', () => {
    expect(found('bjorn')).toEqual(['Bjørn Ærlig']);
    expect(found('aerlig')).toEqual(['Bjørn Ærlig']);
  });

  it('finds a person by their email', () => {
    expect(found('fehmi@')).toEqual(['Fehmi Kaya']);
    expect(found('b.aerlig')).toEqual(['Bjørn Ærlig']);
  });

  it('finds a device by its name, its code or its site', () => {
    expect(found('kuluck')).toEqual(['Kuluçka gateway']);
    expect(found('eg-sea')).toEqual(['Sea pens']);
    expect(found('froya')).toEqual(['Sea pens']);
  });

  it('never finds a row by its hint — a role or an online state', () => {
    expect(found('online')).toEqual([]);
    expect(found('console.role')).toEqual([]);
  });
});

describe('runPaletteCommand', () => {
  it('hands each command to its handler', () => {
    const handlers = { theme: vi.fn(), language: vi.fn(), rail: vi.fn(), workspace: vi.fn() };
    const commands: PaletteCommand<'aqua' | 'gh' | 'ctl' | 'org'>[] = [
      { type: 'theme', theme: 'dark' },
      { type: 'language', locale: 'tr' },
      { type: 'rail', collapsed: true },
      { type: 'workspace', workspace: 'gh' },
    ];
    for (const command of commands) runPaletteCommand(command, handlers);
    expect(handlers.theme).toHaveBeenCalledWith('dark');
    expect(handlers.language).toHaveBeenCalledWith('tr');
    expect(handlers.rail).toHaveBeenCalledWith(true);
    expect(handlers.workspace).toHaveBeenCalledWith('gh');
  });
});
