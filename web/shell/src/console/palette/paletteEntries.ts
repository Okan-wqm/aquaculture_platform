/**
 * The console's command-palette entries (FE-HIGH-334, design README §8).
 *
 * WHY here: the palette (shared-ui) ranks what it is handed and runs nothing;
 * where an entry leads is the shell's, because only the shell knows the nav
 * the viewer was built and which pages can open a person or a device. Every
 * link is a page the viewer's nav offers, so the palette can never lead to a
 * route that refuses them.
 *
 * WHAT:
 *  - pages: every workspace's pages and tabs (shared-ui palettePagesFromNav),
 *    the current workspace first, so a shared page is listed once, under it;
 *  - suggestions: the design's curated pages the current workspace lists,
 *    offered before anything is typed;
 *  - people: to the users list filtered to the person (`?search=`), offered
 *    only with the users page;
 *  - devices: to the edge device's page — the sensor module's when the viewer
 *    has it, else the tenant devices page — offered only with one of them;
 *  - runPaletteCommand: a command entry handed to the shell's handlers.
 */
import {
  CONSOLE_RAIL_ICONS,
  palettePagesFromNav,
  type I18nContextValue,
  type PaletteCommand,
  type PaletteLinkEntry,
  type PaletteRemoteSource,
  type SupportedLocale,
} from '@aquaculture/shared-ui';
import { Cpu, User } from 'lucide-react';

import type { PaletteSources as PaletteData } from '../data';
import { findNavPage, type Workspace, type WorkspaceId } from '../nav';

type Translate = I18nContextValue['t'];

/** Whether the nav offers the page with this id in any workspace. */
export function hasPage(workspaces: readonly Workspace[], pageId: string): boolean {
  return findNavPage(workspaces, pageId) !== undefined;
}

/** Pages and tabs of every workspace, the current one first; a destination once. */
export function palettePages(
  workspaces: readonly Workspace[],
  current: WorkspaceId | undefined,
): PaletteLinkEntry[] {
  const ordered = [
    ...workspaces.filter((workspace) => workspace.id === current),
    ...workspaces.filter((workspace) => workspace.id !== current),
  ];
  const seen = new Set<string>();
  return ordered.flatMap((workspace) =>
    palettePagesFromNav(workspace.areas, {
      context: workspace.label,
      iconOf: (area) => CONSOLE_RAIL_ICONS[area.icon],
    }).filter((entry) => {
      if (seen.has(entry.path)) return false;
      seen.add(entry.path);
      return true;
    }),
  );
}

/**
 * The design's suggested pages (tenant-core paletteItems: dashboard, users,
 * roles, devices, billing, tanks), in its order. The dashboard is the current
 * workspace's own — Production's, Greenhouse's, Control & sensors' or the
 * company dashboard — and devices are the sensor module's page in Control &
 * sensors and the tenant devices page in Company; a workspace lists at most
 * one of each.
 */
const SUGGESTED_PAGE_IDS: readonly string[] = [
  'dashboard',
  'dashboard-greenhouse',
  'dashboard-control',
  'tenant-dashboard',
  'tenant-users',
  'tenant-roles',
  'sensor-devices',
  'tenant-devices',
  'tenant-billing',
  'tanks',
];

/**
 * The paths offered before anything is typed: the suggested pages the
 * current workspace's nav lists (design: "only those the current workspace
 * nav has"), so they follow the workspace as the rail does and never name a
 * page the viewer cannot open. Undefined without a current workspace: the
 * palette then offers the first pages of the nav.
 */
export function paletteSuggestions(
  workspaces: readonly Workspace[],
  current: WorkspaceId | undefined,
): string[] | undefined {
  const workspace = workspaces.find((candidate) => candidate.id === current);
  if (workspace === undefined) return undefined;
  return SUGGESTED_PAGE_IDS.flatMap((id) => {
    const page = findNavPage([workspace], id);
    return page === undefined ? [] : [page.path];
  });
}

function stateHint(isOnline: boolean, t: Translate): string {
  return t(isOnline ? 'console.palette.hint.online' : 'console.palette.hint.offline');
}

/**
 * People, linked to the users list filtered to each; the caller fetches them
 * only with the users page. Found by name or email (design §8), shown with
 * their role; a user who has set no name is listed by email.
 */
export function peopleSource(people: PaletteData['people'], t: Translate): PaletteRemoteSource {
  if (people.status !== 'ready') return { status: people.status };
  return {
    status: 'ready',
    entries: people.items.map((person): PaletteLinkEntry => {
      const label = person.name === '' ? person.email : person.name;
      return {
        kind: 'link',
        id: person.id,
        label,
        keywords: [person.email],
        hint: t(`console.role.${person.role}`),
        icon: User,
        path: `/tenant/users?search=${encodeURIComponent(label)}`,
      };
    }),
  };
}

/**
 * Where a device opens for this viewer: the sensor module's edge-device page,
 * else the tenant admin's devices page, else nowhere (no device entries).
 */
export function devicePathFor(workspaces: readonly Workspace[]): ((id: string) => string) | null {
  if (hasPage(workspaces, 'sensor-devices')) {
    return (id) => `/sensor/devices/edge/${encodeURIComponent(id)}`;
  }
  if (hasPage(workspaces, 'tenant-devices')) {
    return (id) => `/tenant/devices/${encodeURIComponent(id)}`;
  }
  return null;
}

/**
 * Devices, named by name and found by device code or site name too (design
 * §8), hinted "site · Online|Offline" — the state alone when the device's
 * site is not one the viewer can name. Null `pathOf` means the viewer has no
 * device page.
 */
export function devicesSource(
  devices: PaletteData['devices'],
  pathOf: ((id: string) => string) | null,
  t: Translate,
): PaletteRemoteSource {
  if (devices.status !== 'ready') return { status: devices.status };
  if (pathOf === null) return { status: 'unavailable' };
  return {
    status: 'ready',
    entries: devices.items.map((device): PaletteLinkEntry => {
      const state = stateHint(device.isOnline, t);
      return {
        kind: 'link',
        id: device.id,
        label: device.name,
        keywords: device.siteName === null ? [device.code] : [device.code, device.siteName],
        hint:
          device.siteName === null
            ? state
            : t('console.palette.hint.device', { site: device.siteName, state }),
        icon: Cpu,
        path: pathOf(device.id),
      };
    }),
  };
}

/** What each console command does — the shell's own state and preferences. */
export interface PaletteCommandHandlers {
  readonly theme: (theme: 'light' | 'dark') => void;
  readonly language: (locale: SupportedLocale) => void;
  readonly rail: (collapsed: boolean) => void;
  readonly workspace: (workspace: WorkspaceId) => void;
}

export function runPaletteCommand(
  command: PaletteCommand<WorkspaceId>,
  handlers: PaletteCommandHandlers,
): void {
  switch (command.type) {
    case 'theme':
      handlers.theme(command.theme);
      return;
    case 'language':
      handlers.language(command.locale);
      return;
    case 'rail':
      handlers.rail(command.collapsed);
      return;
    case 'workspace':
      handlers.workspace(command.workspace);
      return;
  }
}
