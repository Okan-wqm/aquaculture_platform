/**
 * Shared fixtures for the console rail specs: three workspaces in the shape the
 * shell's buildConsoleNav returns (localized labels, badge sources, a planned
 * page, a page with level-3 tabs), and a controllable matchMedia.
 */
import type { RailWorkspace } from '../railTypes';

export const AQUA: RailWorkspace = {
  id: 'aqua',
  label: 'Production',
  description: 'Fish sites, feeding, health, reports and production finance',
  areas: [
    {
      id: 'aq-home',
      label: 'Overview',
      icon: 'gauge',
      groups: [
        {
          id: 'aq-home-main',
          pages: [
            { id: 'dashboard', label: 'Dashboard', path: '/dashboard' },
            { id: 'alarms', label: 'Alarms', path: '/sensor/alerts', badge: 'alarmsUnack' },
          ],
        },
      ],
    },
    {
      id: 'aq-ops',
      label: 'Operations',
      icon: 'fish',
      groups: [
        {
          id: 'aq-ops-live',
          label: 'Live',
          pages: [
            {
              id: 'feeding',
              label: 'Feeding',
              path: '/sites/feeding',
              tabs: [
                { id: 'board', label: 'Meal board', path: '/sites/feeding?tab=board' },
                { id: 'records', label: 'Records', path: '/sites/feeding?tab=records' },
              ],
            },
            { id: 'tanks', label: 'Tanks & ponds', path: '/sites/tanks' },
          ],
        },
        {
          id: 'aq-ops-work',
          label: 'Site work',
          pages: [{ id: 'tasks', label: 'Tasks', path: '/sites/tasks' }],
        },
      ],
    },
    {
      id: 'aq-team',
      label: 'Team',
      icon: 'users',
      groups: [
        {
          id: 'aq-team-main',
          pages: [
            { id: 'team-today', label: 'Today', path: '/hr/today', status: 'planned' },
            {
              id: 'team-leave',
              label: 'Leave requests',
              path: '/hr/leaves',
              badge: 'leavePending',
            },
          ],
        },
      ],
    },
  ],
};

export const GH: RailWorkspace = {
  id: 'gh',
  label: 'Greenhouse',
  description: 'Nutrient solution, greenhouse tools and greenhouse finance',
  areas: [
    {
      id: 'gh-ops',
      label: 'Greenhouse operations',
      icon: 'sprout',
      groups: [
        {
          id: 'gh-ops-live',
          pages: [{ id: 'gh-water', label: 'Water analysis', path: '/hydroponics/water' }],
        },
      ],
    },
  ],
};

export const ORG: RailWorkspace = {
  id: 'org',
  label: 'Company',
  description: 'Consolidated finance, workforce, facility and account',
  areas: [
    {
      id: 'account',
      label: 'Account',
      icon: 'shield-check',
      groups: [
        { id: 'account-main', pages: [{ id: 'users', label: 'Users', path: '/tenant/users' }] },
      ],
    },
  ],
};

export const WORKSPACES: readonly RailWorkspace[] = [AQUA, GH, ORG];

/** A MediaQueryList whose `matches` follows the module's `narrowWindow` flag. */
class FakeMediaQueryList extends EventTarget implements MediaQueryList {
  readonly media: string;
  onchange: ((this: MediaQueryList, ev: MediaQueryListEvent) => unknown) | null = null;

  constructor(query: string) {
    super();
    this.media = query;
  }

  get matches(): boolean {
    if (this.media.includes('min-width: 768px')) return desktopWindow;
    if (this.media.includes('max-width: 1099px')) return narrowWindow;
    return false;
  }

  addListener(): void {
    // legacy API; the rail subscribes through addEventListener
  }

  removeListener(): void {
    // legacy API; the rail subscribes through addEventListener
  }
}

let narrowWindow = false;
let desktopWindow = true;
const lists: FakeMediaQueryList[] = [];

/** Install a matchMedia whose answers the spec controls; returns the setters. */
export function installMatchMedia(): {
  setNarrow: (narrow: boolean) => void;
  setDesktop: (desktop: boolean) => void;
} {
  narrowWindow = false;
  desktopWindow = true;
  lists.length = 0;
  window.matchMedia = (query: string): MediaQueryList => {
    const list = new FakeMediaQueryList(query);
    lists.push(list);
    return list;
  };
  const notify = (): void => {
    for (const list of lists) list.dispatchEvent(new Event('change'));
  };
  return {
    setNarrow: (narrow) => {
      narrowWindow = narrow;
      notify();
    },
    setDesktop: (desktop) => {
      desktopWindow = desktop;
      notify();
    },
  };
}
