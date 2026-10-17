/**
 * The console nav definitions are well-formed (FE-HIGH-335): a page shared by
 * several workspaces is one destination, every destination has one owner, and
 * every id is unique where the rail keys by it.
 */
import { describe, expect, it } from 'vitest';

import { parseNavLocation } from '../match';
import type { NavPageDef, WorkspaceDef } from '../types';
import { CONSOLE_WORKSPACES } from '../workspaces';

interface Placement {
  readonly workspace: WorkspaceDef;
  readonly page: NavPageDef;
}

const PLACEMENTS: readonly Placement[] = CONSOLE_WORKSPACES.flatMap((workspace) =>
  workspace.areas.flatMap((area) =>
    area.groups.flatMap((group) => group.pages.map((page) => ({ workspace, page }))),
  ),
);

function destinationKey(path: string): string {
  const { pathname, tab } = parseNavLocation(path);
  return tab === null ? pathname : `${pathname}?tab=${tab}`;
}

/** Every URL a page answers to as itself: its path, its default tab spelled out, its tabs. */
function destinationsOf(page: NavPageDef): string[] {
  const defaultTab = page.defaultTab === undefined ? [] : [`${page.path}?tab=${page.defaultTab}`];
  return [page.path, ...defaultTab, ...(page.tabs ?? []).map((tab) => tab.path)];
}

describe('console nav definitions', () => {
  it('orders the four workspaces as the switcher does', () => {
    expect(CONSOLE_WORKSPACES.map((workspace) => workspace.id)).toEqual([
      'aqua',
      'gh',
      'ctl',
      'org',
    ]);
  });

  it('resolves a page shared across workspaces to one definition — one path, one label', () => {
    const byId = new Map<string, Set<NavPageDef>>();
    for (const { page } of PLACEMENTS)
      byId.set(page.id, (byId.get(page.id) ?? new Set()).add(page));
    const split = [...byId].filter(([, defs]) => defs.size > 1).map(([id]) => id);
    expect(split).toEqual([]);
    // The design's shared set really is shared.
    for (const id of [
      'dashboard',
      'alarms',
      'messaging',
      'tasks',
      'maintenance',
      'storage',
      'finance-overview',
      'hr-scheduling',
      'tenant-roles',
    ]) {
      const workspaces = new Set(
        PLACEMENTS.filter(({ page }) => page.id === id).map(({ workspace }) => workspace.id),
      );
      expect(workspaces.size, id).toBeGreaterThan(1);
    }
  });

  it('gives every destination — page path or tab — a single owning page', () => {
    const owner = new Map<string, string>();
    const clashes: string[] = [];
    for (const { page } of PLACEMENTS) {
      for (const path of destinationsOf(page)) {
        const key = destinationKey(path);
        const current = owner.get(key);
        if (current !== undefined && current !== page.id)
          clashes.push(`${key}: ${current} / ${page.id}`);
        owner.set(key, page.id);
      }
    }
    expect(clashes).toEqual([]);
  });

  it('never lists a page twice in one workspace, nor reuses an area or group id', () => {
    const areaIds = new Set<string>();
    const groupIds = new Set<string>();
    for (const workspace of CONSOLE_WORKSPACES) {
      const pageIds = workspace.areas.flatMap((area) =>
        area.groups.flatMap((group) => group.pages.map((page) => page.id)),
      );
      expect(pageIds.length, workspace.id).toBe(new Set(pageIds).size);
      for (const area of workspace.areas) {
        expect(areaIds.has(area.id), area.id).toBe(false);
        areaIds.add(area.id);
        for (const group of area.groups) {
          expect(groupIds.has(group.id), group.id).toBe(false);
          groupIds.add(group.id);
        }
      }
    }
  });

  it('keeps tab ids unique within a page and tab paths under the page', () => {
    for (const { page } of PLACEMENTS) {
      const tabs = page.tabs ?? [];
      expect(new Set(tabs.map((tab) => tab.id)).size, page.id).toBe(tabs.length);
      const base = parseNavLocation(page.path).pathname;
      for (const tab of tabs) {
        const { pathname, tab: query } = parseNavLocation(tab.path);
        const sameRoute = pathname === base && query === tab.id;
        const childRoute = query === null && pathname.endsWith(`/${tab.id}`);
        expect(sameRoute || childRoute, `${page.id} › ${tab.id} → ${tab.path}`).toBe(true);
      }
    }
  });

  it('draws a level-3 strip only for a real one: two tabs or more', () => {
    // A lone tab repeats its page under it in the rail; an alias of the
    // page's own view is `defaultTab`, which matches without drawing a row.
    const lone = [
      ...new Set(
        PLACEMENTS.filter(({ page }) => page.tabs !== undefined && page.tabs.length < 2).map(
          ({ page }) => page.id,
        ),
      ),
    ];
    expect(lone).toEqual([]);
  });

  it('names a default tab only on a page whose path is untabbed and whose strip lacks it', () => {
    for (const { page } of PLACEMENTS) {
      if (page.defaultTab === undefined) continue;
      expect(parseNavLocation(page.path).tab, page.id).toBeNull();
      expect(
        (page.tabs ?? []).some((tab) => parseNavLocation(tab.path).tab === page.defaultTab),
        page.id,
      ).toBe(false);
    }
  });

  it('declares no static badge: only the two data-backed sources', () => {
    const badged = PLACEMENTS.filter(({ page }) => page.badge !== undefined).map(
      ({ page }) => `${page.id}:${page.badge}`,
    );
    expect([...new Set(badged)].sort()).toEqual(['alarms:alarmsUnack', 'hr-leaves:leavePending']);
  });
});
