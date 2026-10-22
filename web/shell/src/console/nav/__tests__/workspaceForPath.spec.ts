/**
 * workspaceForPath / findActivePage (FE-HIGH-335): the rail follows
 * navigation — a page of another workspace moves it, a shared page keeps the
 * current workspace, and the strongest entry lights.
 */
import { describe, expect, it } from 'vitest';

import { buildConsoleNav } from '../buildConsoleNav';
import type { WorkspaceDef } from '../types';
import { findActivePage, workspaceForPath } from '../workspaceForPath';
import { CONSOLE_WORKSPACES } from '../workspaces';

import { navInput } from './viewers.fixture';

function workspace(id: WorkspaceDef['id']): WorkspaceDef {
  const found = CONSOLE_WORKSPACES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`no workspace ${id}`);
  return found;
}

describe('workspaceForPath', () => {
  it('moves to the workspace owning a page the current one lacks', () => {
    expect(workspaceForPath('/sites/tanks', CONSOLE_WORKSPACES, 'gh')).toBe('aqua');
    expect(workspaceForPath('/sensor/plc/alarms', CONSOLE_WORKSPACES, 'aqua')).toBe('ctl');
    expect(workspaceForPath('/hydroponics/pid-simulator', CONSOLE_WORKSPACES, 'org')).toBe('gh');
    expect(workspaceForPath('/tenant/billing', CONSOLE_WORKSPACES, 'ctl')).toBe('org');
    // Offshore crew assignments are Company's alone (not module-scoped).
    expect(workspaceForPath('/hr/crew', CONSOLE_WORKSPACES, 'aqua')).toBe('org');
    expect(workspaceForPath('/hr/payroll', CONSOLE_WORKSPACES, 'gh')).toBe('org');
  });

  it('keeps the current workspace for a page it shares, else takes the first that lists it', () => {
    expect(workspaceForPath('/sites/tasks?tab=calendar', CONSOLE_WORKSPACES, 'ctl')).toBe('ctl');
    expect(workspaceForPath('/sites/tasks', CONSOLE_WORKSPACES, 'gh')).toBe('gh');
    expect(workspaceForPath('/sites/tasks', CONSOLE_WORKSPACES, 'org')).toBe('aqua');
    expect(workspaceForPath('/sites/tasks', CONSOLE_WORKSPACES)).toBe('aqua');
    expect(workspaceForPath('/tenant/roles', CONSOLE_WORKSPACES, 'org')).toBe('org');
    expect(workspaceForPath('/tenant/roles', CONSOLE_WORKSPACES, 'ctl')).toBe('ctl');
    // The team list (and its detail routes) is every module workspace's Team list
    // and Company's workforce list: it stays where the reader is.
    expect(workspaceForPath('/hr/employees/42/edit', CONSOLE_WORKSPACES, 'aqua')).toBe('aqua');
    expect(workspaceForPath('/hr/employees', CONSOLE_WORKSPACES, 'gh')).toBe('gh');
    expect(workspaceForPath('/hr/employees', CONSOLE_WORKSPACES, 'ctl')).toBe('ctl');
    expect(workspaceForPath('/hr/employees', CONSOLE_WORKSPACES, 'org')).toBe('org');
    expect(workspaceForPath('/hr/organization', CONSOLE_WORKSPACES, 'ctl')).toBe('ctl');
    expect(workspaceForPath('/hr/organization', CONSOLE_WORKSPACES, 'org')).toBe('org');
    // The analytics page is every module workspace's; Production's dashboard is its own.
    expect(workspaceForPath('/dashboard/analytics', CONSOLE_WORKSPACES, 'ctl')).toBe('ctl');
    expect(workspaceForPath('/dashboard/analytics', CONSOLE_WORKSPACES, 'org')).toBe('aqua');
    expect(workspaceForPath('/dashboard', CONSOLE_WORKSPACES, 'org')).toBe('aqua');
    expect(workspaceForPath('/dashboard/control', CONSOLE_WORKSPACES, 'aqua')).toBe('ctl');
    expect(workspaceForPath('/dashboard/greenhouse', CONSOLE_WORKSPACES, 'aqua')).toBe('gh');
  });

  it('prefers an exact entry elsewhere over a base match here', () => {
    // Production lists Finance › Overview (base /sites/finance); only Company lists Categories.
    expect(workspaceForPath('/sites/finance?tab=categories', CONSOLE_WORKSPACES, 'aqua')).toBe(
      'org',
    );
    expect(workspaceForPath('/sites/finance?tab=expenses', CONSOLE_WORKSPACES, 'ctl')).toBe('ctl');
  });

  it('follows detail and alias routes through matchPaths', () => {
    expect(workspaceForPath('/sites/batch/b-1/traceability', CONSOLE_WORKSPACES, 'org')).toBe(
      'aqua',
    );
    expect(workspaceForPath('/sensor/devices/d-9?tab=channels', CONSOLE_WORKSPACES, 'aqua')).toBe(
      'ctl',
    );
    expect(workspaceForPath('/hr/dashboard', CONSOLE_WORKSPACES, 'aqua')).toBe('org');
  });

  it('keeps the preferred workspace for a path no entry claims, else falls back to the first', () => {
    expect(workspaceForPath('/nowhere', CONSOLE_WORKSPACES, 'gh')).toBe('gh');
    expect(workspaceForPath('/nowhere', CONSOLE_WORKSPACES)).toBe('aqua');
    expect(workspaceForPath('/nowhere', [], 'gh')).toBeUndefined();
  });

  it('works on a built nav: a hidden workspace never owns a path', () => {
    const built = buildConsoleNav(
      navInput({ role: 'MODULE_USER', modules: ['hr'], permissions: [] }),
    );
    expect(built.map((ws) => ws.id)).toEqual(['org']);
    expect(workspaceForPath('/hr/today', built, 'aqua')).toBe('org');
    expect(workspaceForPath('/sites/tanks', built, 'org')).toBe('org');
  });
});

describe('findActivePage', () => {
  const aqua = workspace('aqua');

  it('lights an exact `?tab=` entry over its base page', () => {
    // Records is a Feeding tab (design digest §8.3: `feedrec` lights Feeding).
    expect(findActivePage('/sites/feeding?tab=records', aqua)?.page.id).toBe('feeding');
    expect(findActivePage('/sites/feeding?tab=forecast', aqua)?.page.id).toBe('feeding');
    expect(findActivePage('/sites/feeding', aqua)?.page.id).toBe('feeding');
    expect(findActivePage('/sites/finance?tab=overview', aqua)?.page.id).toBe('finance-overview');
    expect(findActivePage('/sites/finance?tab=budget', aqua)?.page.id).toBe('finance-budget');
    expect(findActivePage('/sites/water-chemistry?tab=sources', aqua)).toEqual({
      areaId: 'aq-records',
      page: expect.objectContaining({ id: 'reading-sources' }),
    });
  });

  it('lights a page through its path tabs and its patterns', () => {
    expect(findActivePage('/sites/reports/biomass', aqua)?.page.id).toBe('reports');
    expect(findActivePage('/sites/environment/site-3', aqua)?.page.id).toBe('environment');
    expect(findActivePage('/sites/batch/b-1/feeding', aqua)?.areaId).toBe('aq-operations');
  });

  it('prefers a literal route over a sibling parameter pattern', () => {
    const org = workspace('org');
    expect(findActivePage('/messaging/new-ai', org)?.page.id).toBe('messaging-new-ai');
    expect(findActivePage('/messaging/c-1', org)?.page.id).toBe('messaging');
  });

  it('lights nothing for a path outside the workspace', () => {
    expect(findActivePage('/sensor/plc', aqua)).toBeUndefined();
  });
});
