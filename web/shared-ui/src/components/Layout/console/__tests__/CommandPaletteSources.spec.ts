/**
 * Command palette sources (FE-HIGH-334) — the page entries built from the
 * console navigation model, and the console commands.
 */
import { Fish, Gauge, Languages, Moon, PanelLeftOpen, Sun } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { en, tr, type MessageKey } from '../../../../i18n';
import { rankPalette } from '../CommandPaletteRank';
import { buildPaletteCommands, palettePagesFromNav } from '../CommandPaletteSources';

/** The English messages with `{name}` interpolation — what useI18n's t does. */
function t(key: MessageKey, vars: Record<string, string | number> = {}): string {
  let text: string = en[key];
  for (const [name, value] of Object.entries(vars)) text = text.replace(`{${name}}`, String(value));
  return text;
}

/** The shape the shell's built nav (`Area[]`) has, extra fields included. */
const AREAS = [
  {
    id: 'operations',
    label: 'Operations',
    icon: 'fish',
    groups: [
      {
        id: 'live',
        label: 'Live',
        pages: [
          {
            id: 'feeding',
            label: 'Feeding',
            path: '/sites/feeding',
            tabs: [
              { id: 'board', label: 'Board', path: '/sites/feeding' },
              { id: 'forecast', label: 'Forecast', path: '/sites/feeding?tab=forecast' },
            ],
          },
          { id: 'alarms', label: 'Alarms', path: '/sensor/alerts' },
        ],
      },
    ],
  },
  {
    id: 'overview',
    label: 'Overview',
    icon: 'gauge',
    groups: [
      {
        id: 'main',
        pages: [
          { id: 'dashboard', label: 'Dashboard', path: '/dashboard' },
          // A page several areas list leads to one route: listed once.
          { id: 'alarms', label: 'Alarms', path: '/sensor/alerts' },
        ],
      },
    ],
  },
] as const;

describe('palettePagesFromNav', () => {
  it('lists every page and every tab once, in navigation order', () => {
    const entries = palettePagesFromNav(AREAS, { context: 'Production' });
    expect(entries.map((entry) => [entry.label, entry.path, entry.nested ?? false])).toEqual([
      ['Feeding', '/sites/feeding', false],
      ['Feeding › Forecast', '/sites/feeding?tab=forecast', true],
      ['Alarms', '/sensor/alerts', false],
      ['Dashboard', '/dashboard', false],
    ]);
  });

  it('hints the area and matches the area, the group, the workspace and a tab’s page', () => {
    const [feeding, forecast, , dashboard] = palettePagesFromNav(AREAS, { context: 'Production' });
    expect(feeding).toMatchObject({ kind: 'link', id: '/sites/feeding', hint: 'Operations' });
    expect(feeding.keywords).toEqual(['Operations', 'Live', 'Production']);
    expect(forecast.keywords).toEqual(['Operations', 'Live', 'Production', 'Feeding']);
    expect(dashboard.keywords).toEqual(['Overview', 'Production']);
  });

  it('matches a page’s and a tab’s English label in another language', () => {
    // The Turkish nav as the shell builds it: each label from its catalogue key.
    const areas = [
      {
        id: 'operations',
        label: tr['nav.area.operations'],
        groups: [
          {
            pages: [
              {
                id: 'feeding',
                labelKey: 'nav.feeding',
                label: tr['nav.feeding'],
                path: '/sites/feeding',
                tabs: [
                  {
                    id: 'forecast',
                    labelKey: 'feedingV2.tab.forecast',
                    label: tr['feedingV2.tab.forecast'],
                    path: '/sites/feeding?tab=forecast',
                  },
                ],
              },
              // A page whose label has no catalogue key matches only itself.
              { id: 'custom', label: 'Özel', path: '/custom' },
            ],
          },
        ],
      },
    ] as const;
    const [feeding, forecast, custom] = palettePagesFromNav(areas);
    expect(feeding.keywords).toEqual([tr['nav.area.operations'], 'Feeding']);
    expect(forecast.keywords).toEqual([
      tr['nav.area.operations'],
      tr['nav.feeding'],
      'Feeding',
      'Forecast',
    ]);
    expect(custom.keywords).toEqual([tr['nav.area.operations']]);
    const pages = palettePagesFromNav(areas);
    const found = (query: string): string[] =>
      rankPalette(
        {
          pages,
          people: { status: 'unavailable' },
          devices: { status: 'unavailable' },
          commands: [],
        },
        query,
      ).flatMap((section) => section.entries.map((entry) => entry.label));
    expect(found('feeding')).toEqual([
      tr['nav.feeding'],
      `${tr['nav.feeding']} › ${tr['feedingV2.tab.forecast']}`,
    ]);
    expect(found('feeding forecast')).toEqual([
      `${tr['nav.feeding']} › ${tr['feedingV2.tab.forecast']}`,
    ]);
  });

  it('adds no English label where it is the label already', () => {
    const areas = [
      {
        id: 'operations',
        label: 'Operations',
        groups: [
          { pages: [{ id: 'feeding', labelKey: 'nav.feeding', label: 'Feeding', path: '/f' }] },
        ],
      },
    ] as const;
    expect(palettePagesFromNav(areas)[0].keywords).toEqual(['Operations']);
  });

  it('takes each area’s icon from the caller, else leaves the group default', () => {
    const icons = { fish: Fish, gauge: Gauge } as const;
    const withIcons = palettePagesFromNav(AREAS, { iconOf: (area) => icons[area.icon] });
    expect(withIcons.map((entry) => entry.icon)).toEqual([Fish, Fish, Fish, Gauge]);
    expect(palettePagesFromNav(AREAS).every((entry) => entry.icon === undefined)).toBe(true);
  });
});

describe('buildPaletteCommands', () => {
  const workspaces = [
    { id: 'aqua', label: 'Production' },
    { id: 'gh', label: 'Greenhouse' },
    { id: 'org', label: 'Company' },
  ] as const;

  it('offers the other theme, every other language, the rail and every other workspace', () => {
    const commands = buildPaletteCommands(
      { theme: 'light', locale: 'en', railCollapsed: false, workspaces, currentWorkspace: 'aqua' },
      t,
    );
    expect(commands.map((entry) => [entry.label, entry.command])).toEqual([
      ['Switch to dark theme', { type: 'theme', theme: 'dark' }],
      ['Switch language to Türkçe', { type: 'language', locale: 'tr' }],
      ['Collapse navigation', { type: 'rail', collapsed: true }],
      ['Go to Greenhouse', { type: 'workspace', workspace: 'gh' }],
      ['Go to Company', { type: 'workspace', workspace: 'org' }],
    ]);
    expect(new Set(commands.map((entry) => entry.id)).size).toBe(commands.length);
    expect(commands[0].icon).toBe(Moon);
    expect(commands[1].icon).toBe(Languages);
  });

  it('turns each toggle the other way from the current state', () => {
    const commands = buildPaletteCommands(
      {
        theme: 'dark',
        locale: 'tr',
        railCollapsed: true,
        workspaces: [],
        currentWorkspace: undefined,
      },
      t,
    );
    expect(commands.map((entry) => entry.command)).toEqual([
      { type: 'theme', theme: 'light' },
      { type: 'language', locale: 'en' },
      { type: 'rail', collapsed: false },
    ]);
    expect(commands[0].icon).toBe(Sun);
    expect(commands[2].icon).toBe(PanelLeftOpen);
  });

  it('lets the rail and workspace commands be found by what they act on', () => {
    const commands = buildPaletteCommands(
      { theme: 'light', locale: 'en', railCollapsed: false, workspaces, currentWorkspace: 'aqua' },
      t,
    );
    const rail = commands.find((entry) => entry.command.type === 'rail');
    const workspace = commands.find((entry) => entry.command.type === 'workspace');
    expect(rail?.keywords).toEqual([en['console.palette.command.railKeywords']]);
    expect(workspace?.keywords).toEqual([en['console.palette.command.workspaceKeywords']]);
  });
});
