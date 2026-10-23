/**
 * The Team area of the module workspaces (module-scoped HR, decision D6): the
 * same five questions in Production, Greenhouse and Control — who is on today,
 * the shift plan, leave, the team list and the organisation — each one a page
 * object the Company workforce area shares, so a destination keeps one id, one
 * path and one label wherever it is listed.
 */
import { describe, expect, it } from 'vitest';

import { HR_PAGES, HR_PLANNED_PAGES } from '../pages/hr';
import { TENANT_PAGES } from '../pages/tenant';
import type { NavAreaDef, NavPageDef, WorkspaceDef, WorkspaceId } from '../types';
import { CONSOLE_WORKSPACES } from '../workspaces';

const TEAM_AREAS: Readonly<Record<'aqua' | 'gh' | 'ctl', string>> = {
  aqua: 'aq-team',
  gh: 'gh-team',
  ctl: 'ctl-team',
};

function workspace(id: WorkspaceId): WorkspaceDef {
  const found = CONSOLE_WORKSPACES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no workspace ${id}`);
  return found;
}

function area(ws: WorkspaceDef, areaId: string): NavAreaDef {
  const found = ws.areas.find((candidate) => candidate.id === areaId);
  if (found === undefined) throw new Error(`no area ${areaId} in ${ws.id}`);
  return found;
}

function pagesIn(ws: WorkspaceDef): NavPageDef[] {
  return ws.areas.flatMap((candidate) => candidate.groups.flatMap((group) => group.pages));
}

describe.each(Object.entries(TEAM_AREAS))('%s › Team', (workspaceId, areaId) => {
  const team = area(workspace(workspaceId as WorkspaceId), areaId);

  it('lists today, the shift schedule, leave requests and the team list first', () => {
    expect(team.groups[0]?.pages.map((page) => page.id)).toEqual([
      'hr-today',
      'hr-scheduling',
      'hr-leaves',
      'hr-employees',
    ]);
  });

  it('closes with the Organisation group: departments, the organization chart, roles', () => {
    const organisation = team.groups[1];
    expect(organisation?.labelKey).toBe('nav.group.organisation');
    expect(organisation?.pages).toEqual([
      HR_PAGES.departments,
      HR_PAGES.organizationChart,
      TENANT_PAGES.roles,
    ]);
    expect(team.groups).toHaveLength(2);
  });

  it('keeps the offshore crew assignments out: that page is not module-scoped', () => {
    const listed = team.groups.flatMap((group) => group.pages.map((page) => page.id));
    expect(listed).not.toContain('hr-crew');
  });
});

describe('the team list', () => {
  it('is the Company workforce area’s employees page — one object, one path, one label', () => {
    const company = pagesIn(workspace('org')).filter((page) => page.id === 'hr-employees');
    expect(company).toEqual([HR_PAGES.employees]);
    for (const [workspaceId, areaId] of Object.entries(TEAM_AREAS)) {
      const listed = area(workspace(workspaceId as WorkspaceId), areaId).groups[0]?.pages.find(
        (page) => page.id === 'hr-employees',
      );
      expect(listed, workspaceId).toBe(HR_PAGES.employees);
    }
    expect(HR_PAGES.employees.labelKey).toBe('nav.page.teamList');
    expect(HR_PAGES.employees.path).toBe('/hr/employees');
  });
});

describe('crew assignments', () => {
  it('is relabelled and stays in the Company workspace only', () => {
    expect(HR_PAGES.crew.labelKey).toBe('nav.page.crewAssignments');
    expect(HR_PAGES.crew.path).toBe('/hr/crew');
    const owners = CONSOLE_WORKSPACES.filter((ws) =>
      pagesIn(ws).some((page) => page.id === HR_PAGES.crew.id),
    ).map((ws) => ws.id);
    expect(owners).toEqual(['org']);
  });
});

describe('the organization chart', () => {
  it('is a real page at /hr/organization, and no planned placeholder claims that path', () => {
    expect(HR_PAGES.organizationChart).toEqual({
      id: 'hr-organization-chart',
      labelKey: 'nav.page.organizationChart',
      path: '/hr/organization',
    });
    const claimed = Object.values(HR_PLANNED_PAGES).filter(
      (page) => page.path === HR_PAGES.organizationChart.path,
    );
    expect(claimed).toEqual([]);
  });

  it('is listed in Company too, so a tenant with HR alone still reaches it', () => {
    const company = pagesIn(workspace('org')).filter((page) => page.id === 'hr-organization-chart');
    expect(company).toEqual([HR_PAGES.organizationChart]);
  });

  it('keeps Positions as the planned page below it', () => {
    expect(HR_PLANNED_PAGES.positions.path).toBe('/hr/organization/positions');
    expect(HR_PLANNED_PAGES.positions.status).toBe('planned');
  });
});
