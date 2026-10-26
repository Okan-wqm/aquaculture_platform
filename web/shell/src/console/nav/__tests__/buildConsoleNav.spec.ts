/**
 * buildConsoleNav (FE-HIGH-335): what each viewer sees.
 *
 * Exhaustive over every role × module set × delegated capability set, against
 * two oracles independent of the nav's own fields: the route guards that serve
 * each path (so no offered link is refused), and the pre-console nav (so no
 * page a viewer had is lost — legacyTenantNav.fixture.ts).
 */
import { describe, expect, it } from 'vitest';

import { buildConsoleNav } from '../buildConsoleNav';
import { parseNavLocation } from '../match';
import type {
  ConsoleRole,
  ModuleCode,
  NavPage,
  NavPermission,
  TenantCapability,
  Workspace,
  WorkspaceDef,
  WorkspaceId,
} from '../types';

import { legacyTenantNav } from './legacyTenantNav.fixture';
import { allViewers, describeViewer, fakeT, navInput, type Viewer } from './viewers.fixture';

function pagesOf(nav: readonly Workspace[]): NavPage[] {
  return nav.flatMap((ws) =>
    ws.areas.flatMap((area) => area.groups.flatMap((group) => group.pages)),
  );
}

function nav(viewer: Viewer): Workspace[] {
  return buildConsoleNav(navInput(viewer));
}

const MODULE_PREFIXES: readonly (readonly [string, ModuleCode])[] = [
  ['/sites', 'farm'],
  ['/hydroponics', 'hydroponics'],
  ['/sensor', 'sensor'],
  ['/hr', 'hr'],
];
const TENANT_ROUTE_CAPABILITY: Readonly<Record<string, TenantCapability>> = {
  '/tenant/users': 'users:view',
  '/tenant/roles': 'roles:view',
  '/tenant/settings': 'settings:view',
};
const PRIVILEGED: readonly ConsoleRole[] = ['TENANT_ADMIN', 'MODULE_MANAGER'];
/**
 * Pages that refuse a role in-page with an "Access Restricted" view, read off
 * the pages: FinancePage and HRFinancePage `canView`, PayrollPage
 * `isAuthorised` (SEC-003), CertificationDashboardPage and PerformancePage
 * (HR-HIGH-056).
 */
const IN_PAGE_ROLE_GATES: Readonly<Record<string, readonly ConsoleRole[]>> = {
  '/sites/finance': PRIVILEGED,
  '/hr/finance': PRIVILEGED,
  '/hr/payroll': PRIVILEGED,
  '/hr/training/certifications': PRIVILEGED,
  '/hr/performance': PRIVILEGED,
};
/**
 * Pages that refuse a viewer lacking a resource permission in-page:
 * NewAiChatPage `canUseAi` shows `messaging.ai.noAccess` (FE-MEDIUM-065).
 */
const IN_PAGE_PERMISSION_GATES: Readonly<Record<string, NavPermission>> = {
  '/messaging/new-ai': 'ai_assistant:use',
};
/**
 * Module routes whose element carries a role gate: sensor-module
 * CommandLogRoute (RequireRole MODULE_MANAGER, hierarchy-aware).
 */
const ROUTE_ROLE_GATES: Readonly<Record<string, readonly ConsoleRole[]>> = {
  '/sensor/commands': PRIVILEGED,
};

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * What the routes admit, written from the guards themselves: App.tsx's
 * ProtectedRoute (requiredModule passes a tenant admin for every module),
 * tenant-admin's RequireTenantCapability (three delegatable pages, the rest
 * admin-only), the module routes with a role gate, and the pages that refuse
 * a viewer in-page (role or permission; useAuth().hasPermission passes a
 * tenant admin).
 */
function routeAdmits(viewer: Viewer, path: string): boolean {
  const { pathname } = parseNavLocation(path);
  const isAdmin = viewer.role === 'TENANT_ADMIN';
  // The company dashboard (/tenant index) admits every tenant member.
  if (pathname === '/tenant') return true;
  if (under(pathname, '/tenant')) {
    const capability = TENANT_ROUTE_CAPABILITY[pathname];
    return isAdmin || (capability !== undefined && viewer.permissions.includes(capability));
  }
  const roles = IN_PAGE_ROLE_GATES[pathname] ?? ROUTE_ROLE_GATES[pathname];
  if (roles !== undefined && !roles.includes(viewer.role)) return false;
  const permission = IN_PAGE_PERMISSION_GATES[pathname];
  if (permission !== undefined && !isAdmin && !viewer.permissions.includes(permission)) {
    return false;
  }
  const mount = MODULE_PREFIXES.find(([prefix]) => under(pathname, prefix));
  return mount === undefined || isAdmin || viewer.modules.includes(mount[1]);
}

/** True when the nav lists `path` as an entry (a level-2 row), not only as a tab or pattern. */
function offersEntry(workspaces: readonly Workspace[], path: string): boolean {
  const target = parseNavLocation(path);
  return pagesOf(workspaces).some((page) => {
    const own = parseNavLocation(page.path);
    return own.pathname === target.pathname && own.tab === target.tab;
  });
}

/** True when the nav lists `path` as one of a page's level-3 tabs. */
function offersTab(workspaces: readonly Workspace[], path: string): boolean {
  const target = parseNavLocation(path);
  return pagesOf(workspaces).some((page) =>
    (page.tabs ?? []).some((tab) => {
      const own = parseNavLocation(tab.path);
      return own.pathname === target.pathname && own.tab === target.tab;
    }),
  );
}

const VIEWERS = allViewers();

describe('buildConsoleNav — every role × module set × capability set', () => {
  it('covers the full matrix (16 module sets; admin once, two roles × 16 permission sets)', () => {
    expect(VIEWERS).toHaveLength(16 * (1 + 2 * 16));
  });

  it('never offers a page or tab the route would refuse', () => {
    const refused: string[] = [];
    for (const viewer of VIEWERS) {
      for (const page of pagesOf(nav(viewer))) {
        const targets = [page.path, ...(page.tabs ?? []).map((tab) => tab.path)];
        for (const target of targets) {
          if (!routeAdmits(viewer, target)) refused.push(`${describeViewer(viewer)} → ${target}`);
        }
      }
    }
    expect([...new Set(refused)]).toEqual([]);
  });

  it('lists module pages only for modules assigned to the tenant (Company excepted for the admin)', () => {
    for (const viewer of VIEWERS) {
      for (const page of pagesOf(nav(viewer))) {
        const mount = MODULE_PREFIXES.find(([prefix]) =>
          under(parseNavLocation(page.path).pathname, prefix),
        );
        if (mount === undefined || viewer.modules.includes(mount[1])) continue;
        expect(
          page.tenantWide === true && viewer.role === 'TENANT_ADMIN',
          `${describeViewer(viewer)} sees ${page.id} without ${mount[1]}`,
        ).toBe(true);
      }
    }
  });

  it('keeps every page the pre-console nav gave the viewer, at its real destination', () => {
    const wrong: string[] = [];
    for (const viewer of VIEWERS) {
      const built = nav(viewer);
      for (const entry of legacyTenantNav(viewer)) {
        const moduleServes =
          entry.brokenUnless === undefined || viewer.modules.includes(entry.brokenUnless);
        const pageAdmits = entry.refusedRoles?.includes(viewer.role) !== true;
        const workspaceServes =
          entry.onlyWith === undefined ||
          entry.onlyWith.some((module) => viewer.modules.includes(module));
        const reachable =
          (moduleServes || viewer.role === 'TENANT_ADMIN') && pageAdmits && workspaceServes;
        const offered =
          entry.reachedAs === 'tab'
            ? offersTab(built, entry.lands)
            : offersEntry(built, entry.lands);
        if (offered !== reachable) {
          wrong.push(
            `${describeViewer(viewer)}: legacy ${entry.id} (${entry.lands}) reachable=${reachable} offered=${offered}`,
          );
        }
      }
    }
    expect([...new Set(wrong)]).toEqual([]);
  });

  it('prunes bottom-up: no empty group, area or workspace, and a module workspace needs its module', () => {
    for (const viewer of VIEWERS) {
      for (const workspace of nav(viewer)) {
        expect(workspace.areas.length).toBeGreaterThan(0);
        for (const area of workspace.areas) {
          expect(area.groups.length).toBeGreaterThan(0);
          for (const group of area.groups) expect(group.pages.length).toBeGreaterThan(0);
        }
        if (workspace.module !== undefined) {
          expect(viewer.modules, describeViewer(viewer)).toContain(workspace.module);
        }
      }
    }
  });

  it('gives every viewer the Company workspace (company dashboard, messages and profile at least)', () => {
    for (const viewer of VIEWERS) {
      const org = nav(viewer).find((workspace) => workspace.id === 'org');
      expect(org, describeViewer(viewer)).toBeDefined();
      for (const path of ['/tenant', '/messaging', '/settings/profile']) {
        expect(offersEntry(org === undefined ? [] : [org], path)).toBe(true);
      }
    }
  });

  it('opens each module workspace on its own dashboard; Company lists none of them', () => {
    const own: Readonly<Record<string, string>> = {
      aqua: '/dashboard',
      gh: '/dashboard/greenhouse',
      ctl: '/dashboard/control',
    };
    for (const viewer of VIEWERS) {
      for (const workspace of nav(viewer)) {
        const paths = pagesOf([workspace]).map((page) => page.path);
        const dashboards = paths.filter((path) => path.startsWith('/dashboard'));
        if (workspace.id === 'org') {
          expect(dashboards, describeViewer(viewer)).toEqual([]);
        } else {
          expect(workspace.areas[0]?.groups[0]?.pages[0]?.path).toBe(own[workspace.id]);
          expect(dashboards).toEqual([own[workspace.id], '/dashboard/analytics']);
        }
      }
    }
  });

  it('shows a module workspace exactly when its module is assigned', () => {
    const moduleWorkspaces: readonly (readonly [WorkspaceId, ModuleCode])[] = [
      ['aqua', 'farm'],
      ['gh', 'hydroponics'],
      ['ctl', 'sensor'],
    ];
    for (const viewer of VIEWERS) {
      const ids = nav(viewer).map((workspace) => workspace.id);
      for (const [ws, module] of moduleWorkspaces) {
        expect(ids.includes(ws), `${describeViewer(viewer)} ${ws}`).toBe(
          viewer.modules.includes(module),
        );
      }
    }
  });
});

describe('buildConsoleNav — representative viewers', () => {
  const ids = (viewer: Viewer): string[] => pagesOf(nav(viewer)).map((page) => page.id);

  it('gives a tenant admin with no modules the Company workspace with the whole tenant panel', () => {
    const viewer: Viewer = { role: 'TENANT_ADMIN', modules: [], permissions: [] };
    expect(nav(viewer).map((workspace) => workspace.id)).toEqual(['org']);
    expect(ids(viewer)).toEqual(
      expect.arrayContaining([
        'tenant-dashboard',
        'company',
        'tenant-users',
        'tenant-roles',
        'tenant-settings',
        'tenant-devices',
        'tenant-billing',
        'tenant-architecture-review',
        'profile',
      ]),
    );
    expect(ids(viewer).some((id) => id.startsWith('hr-') || id.startsWith('finance-'))).toBe(false);
  });

  it('gives a tenant admin with every module all four workspaces in switcher order', () => {
    const viewer: Viewer = {
      role: 'TENANT_ADMIN',
      modules: ['hr', 'sensor', 'hydroponics', 'farm'],
      permissions: [],
    };
    expect(nav(viewer).map((workspace) => workspace.id)).toEqual(['aqua', 'gh', 'ctl', 'org']);
  });

  it('keeps finance from a module user and gives it to a module manager', () => {
    const user: Viewer = { role: 'MODULE_USER', modules: ['farm', 'hr'], permissions: [] };
    const manager: Viewer = { ...user, role: 'MODULE_MANAGER' };
    expect(ids(user).filter((id) => id.includes('finance'))).toEqual([]);
    expect(ids(manager)).toEqual(
      expect.arrayContaining(['finance-overview', 'finance-budget', 'hr-finance']),
    );
  });

  it('shows a module user tenant pages only through the capabilities their role delegates', () => {
    const plain: Viewer = { role: 'MODULE_USER', modules: ['farm'], permissions: [] };
    const delegate: Viewer = { ...plain, permissions: ['roles:view'] };
    // The company dashboard is every member's; the rest needs a capability.
    expect(ids(plain).filter((id) => id.startsWith('tenant-'))).toEqual(['tenant-dashboard']);
    expect([...new Set(ids(delegate).filter((id) => id.startsWith('tenant-')))]).toEqual([
      'tenant-roles',
      'tenant-dashboard',
    ]);
  });

  it('drops a farm page from a workspace whose tenant lacks farm (sensor alone: no maintenance area)', () => {
    const viewer: Viewer = { role: 'MODULE_MANAGER', modules: ['sensor'], permissions: [] };
    const ctl = nav(viewer).find((workspace) => workspace.id === 'ctl');
    expect(ctl?.areas.map((area) => area.id)).toEqual(['ctl-home', 'ctl-control', 'ctl-config']);
  });

  it('replaces the two dead module-user links with the routes that serve them', () => {
    const viewer: Viewer = { role: 'MODULE_USER', modules: ['farm'], permissions: [] };
    const paths = pagesOf(nav(viewer)).map((page) => page.path);
    expect(paths).not.toContain('/analytics');
    expect(paths).not.toContain('/reports');
    expect(paths).toEqual(
      expect.arrayContaining(['/dashboard/analytics', '/sites/reports/sea-lice']),
    );
  });

  it('lists Company for a module user only with farm, whose route serves it', () => {
    const withFarm: Viewer = { role: 'MODULE_USER', modules: ['farm'], permissions: [] };
    const withoutFarm: Viewer = { role: 'MODULE_USER', modules: ['hr'], permissions: [] };
    expect(ids(withFarm)).toContain('company');
    expect(ids(withoutFarm)).not.toContain('company');
  });

  it('offers the new AI chat only with the AI surface capability (FE-MEDIUM-065)', () => {
    const plain: Viewer = { role: 'MODULE_USER', modules: ['hr'], permissions: [] };
    const granted: Viewer = { ...plain, permissions: ['ai_assistant:use'] };
    const manager: Viewer = { ...plain, role: 'MODULE_MANAGER' };
    const admin: Viewer = { role: 'TENANT_ADMIN', modules: [], permissions: [] };
    expect(ids(plain)).not.toContain('messaging-new-ai');
    expect(ids(manager)).not.toContain('messaging-new-ai');
    expect(ids(granted)).toContain('messaging-new-ai');
    expect(ids(admin)).toContain('messaging-new-ai');
    // The rest of Messages stays: only the AI entry is gated.
    expect(ids(plain)).toContain('messaging');
  });

  it('offers payroll only to the roles the page admits (SEC-003)', () => {
    const user: Viewer = { role: 'MODULE_USER', modules: ['hr'], permissions: [] };
    const manager: Viewer = { ...user, role: 'MODULE_MANAGER' };
    const admin: Viewer = { ...user, role: 'TENANT_ADMIN' };
    expect(ids(user)).not.toContain('hr-payroll');
    expect(ids(manager)).toContain('hr-payroll');
    expect(ids(admin)).toContain('hr-payroll');
    // Its "coming soon" sub-pages are placeholders, open to the module's users.
    expect(ids(user)).toContain('hr-planned-payslips');
  });

  it('offers the command log only to the roles its route admits (module managers and up)', () => {
    const user: Viewer = { role: 'MODULE_USER', modules: ['sensor'], permissions: [] };
    const manager: Viewer = { ...user, role: 'MODULE_MANAGER' };
    const admin: Viewer = { ...user, role: 'TENANT_ADMIN' };
    expect(ids(user)).not.toContain('sensor-commands');
    expect(ids(manager)).toContain('sensor-commands');
    expect(ids(admin)).toContain('sensor-commands');
  });

  it('lists the HR "coming soon" routes as planned pages', () => {
    const viewer: Viewer = { role: 'MODULE_USER', modules: ['hr'], permissions: [] };
    const planned = pagesOf(nav(viewer)).filter((page) => page.status === 'planned');
    expect(planned).toHaveLength(15);
    expect(planned.every((page) => page.path.startsWith('/hr/'))).toBe(true);
  });

  it('resolves every label through t and keeps the key beside it', () => {
    const viewer: Viewer = { role: 'TENANT_ADMIN', modules: ['farm'], permissions: [] };
    const [aqua] = nav(viewer);
    expect(aqua?.label).toBe(fakeT('nav.workspace.aqua'));
    expect(aqua?.description).toBe(fakeT('nav.workspace.aqua.description'));
    const feeding = pagesOf(nav(viewer)).find((page) => page.id === 'feeding');
    expect(feeding?.label).toBe(fakeT('nav.feeding'));
    expect(feeding?.tabs?.[0]).toEqual({
      id: 'meal-board',
      labelKey: 'feedingV2.tab.mealBoard',
      label: fakeT('feedingV2.tab.mealBoard'),
      path: '/sites/feeding?tab=meal-board',
    });
    const live = aqua?.areas.find((area) => area.id === 'aq-operations')?.groups[0];
    expect(live?.label).toBe(fakeT('nav.group.live'));
  });

  it('carries an area badge only from pages the viewer can see', () => {
    const withSensor: Viewer = {
      role: 'TENANT_ADMIN',
      modules: ['farm', 'sensor', 'hr'],
      permissions: [],
    };
    const farmOnly: Viewer = { role: 'TENANT_ADMIN', modules: ['farm'], permissions: [] };
    const area = (viewer: Viewer, id: string) =>
      nav(viewer)
        .flatMap((workspace) => workspace.areas)
        .find((candidate) => candidate.id === id);
    expect(area(withSensor, 'aq-home')?.badge).toEqual(['alarmsUnack']);
    expect(area(withSensor, 'aq-team')?.badge).toEqual(['leavePending']);
    expect(area(farmOnly, 'aq-home')?.badge).toBeUndefined();
  });
});

describe('buildConsoleNav — pruning on given definitions', () => {
  const definitions: readonly WorkspaceDef[] = [
    {
      id: 'aqua',
      labelKey: 'nav.workspace.aqua',
      descriptionKey: 'nav.workspace.aqua.description',
      accentToken: '--color-sd-ws-aqua',
      areas: [
        {
          id: 'kept',
          labelKey: 'nav.overview',
          icon: 'gauge',
          groups: [
            {
              id: 'open',
              // Trends: open to every member (the module dashboards are gated by module).
              pages: [{ id: 'trends', labelKey: 'nav.dashboard', path: '/dashboard/analytics' }],
            },
            {
              id: 'admin-only',
              labelKey: 'nav.platform',
              pages: [
                {
                  id: 'billing',
                  labelKey: 'nav.billing',
                  path: '/tenant/billing',
                  requiredRoles: ['TENANT_ADMIN'],
                },
              ],
            },
          ],
        },
        {
          id: 'gone',
          labelKey: 'nav.reports',
          icon: 'clipboard-check',
          groups: [
            {
              id: 'farm',
              pages: [{ id: 'health', labelKey: 'nav.healthEvents', path: '/sites/health' }],
            },
          ],
        },
      ],
    },
    {
      id: 'gh',
      labelKey: 'nav.workspace.gh',
      descriptionKey: 'nav.workspace.gh.description',
      accentToken: '--color-sd-ws-gh',
      areas: [
        {
          id: 'empty',
          labelKey: 'nav.overview',
          icon: 'gauge',
          groups: [
            { id: 'hr', pages: [{ id: 'hr-dashboard', labelKey: 'nav.dashboard', path: '/hr' }] },
          ],
        },
      ],
    },
  ];

  it('drops the hidden page, then its empty group, area and workspace', () => {
    const built = buildConsoleNav(
      navInput({ role: 'MODULE_USER', modules: [], permissions: [] }),
      definitions,
    );
    expect(built.map((workspace) => workspace.id)).toEqual(['aqua']);
    expect(built[0]?.areas.map((area) => area.id)).toEqual(['kept']);
    expect(built[0]?.areas[0]?.groups.map((group) => group.id)).toEqual(['open']);
    expect(built[0]?.areas[0]?.groups[0]?.label).toBeUndefined();
  });
});
