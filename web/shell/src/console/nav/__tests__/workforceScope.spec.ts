/**
 * workforceScopeOf (module-scoped HR): the one place a workspace's module
 * becomes the HR service's module code. The Team area of a module workspace
 * lists that module's people only because this answer reaches the HR hooks
 * (WorkforceScopeProvider); Company spans every module and carries none.
 */
import { describe, expect, it } from 'vitest';

import { WORKFORCE_MODULE_LABEL_KEYS } from '@aquaculture/shared-ui';

import { ALARM_WORKSPACE_MODULE, ALARM_WORKSPACES } from '../../rail/alarmWorkspaces';
import { workforceScopeOf } from '../workforceScope';
import { CONSOLE_WORKSPACES } from '../workspaces';

import { ALL_MODULES } from './viewers.fixture';

describe('workforceScopeOf', () => {
  it('maps each module a workspace is built on to the HR module code of the same module', () => {
    expect(workforceScopeOf('farm')).toBe('FARM');
    expect(workforceScopeOf('hydroponics')).toBe('HYDROPONICS');
    expect(workforceScopeOf('sensor')).toBe('SENSOR');
  });

  it('gives the HR module itself no scope: it is the company-wide view, not a department module', () => {
    expect(workforceScopeOf('hr')).toBeNull();
  });

  it('gives a workspace with no module (Company) no scope', () => {
    expect(workforceScopeOf(undefined)).toBeNull();
  });

  it('answers for every tenant module code (a new code cannot go undecided)', () => {
    for (const module of ALL_MODULES) {
      expect(workforceScopeOf(module), module).not.toBeUndefined();
    }
  });

  it('scopes each console workspace the way its definition declares its module', () => {
    const scopes = Object.fromEntries(
      CONSOLE_WORKSPACES.map((workspace) => [workspace.id, workforceScopeOf(workspace.module)]),
    );
    expect(scopes).toEqual({ aqua: 'FARM', gh: 'HYDROPONICS', ctl: 'SENSOR', org: null });
  });

  it('scopes each workspace to the module its alarm column counts', () => {
    // WHY: the alarm column and the Team pages are two tables over the same
    // WorkspaceDef.module; a change to one that misses the other would show one
    // module's people beside another module's alarms.
    for (const id of ALARM_WORKSPACES) {
      const workspace = CONSOLE_WORKSPACES.find((candidate) => candidate.id === id);
      expect(workforceScopeOf(workspace?.module), id).toBe(ALARM_WORKSPACE_MODULE[id]);
    }
  });

  it('names each module the way its workspace is named in the console', () => {
    // WHY: the HR pages print a module with WORKFORCE_MODULE_LABEL_KEYS; the workspace menu prints
    // it with WorkspaceDef.labelKey. Two hand-typed tables over the same workspaces, tied here.
    for (const workspace of CONSOLE_WORKSPACES) {
      const scope = workforceScopeOf(workspace.module);
      if (scope === null) continue;
      expect(WORKFORCE_MODULE_LABEL_KEYS[scope], workspace.id).toBe(workspace.labelKey);
    }
  });
});
