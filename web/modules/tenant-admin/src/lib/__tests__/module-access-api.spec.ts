/**
 * The tenant-admin client of module access (PKG-06; ADR-051 §2 "Change", §5).
 *
 * Assign / Remove Manager name the module by its code; a member's module roles are read and
 * replaced as a whole; the console shows the primary manager from the grant listing and stops
 * reading tenant_modules.managerId, which PKG-06 PR2 unmaps (ADR-051 §5: "the web stops reading
 * managerId in R3"). Replies are narrowed at the boundary and refused when malformed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const graphql = vi.hoisted(() => vi.fn());

vi.mock('../../services/api-client', () => ({
  apiClient: { graphql },
}));

import {
  ASSIGN_MODULE_MANAGER_MUTATION,
  MODULE_PRIMARY_MANAGERS_QUERY,
  MY_TENANT_MODULES_QUERY,
  REMOVE_MODULE_MANAGER_MUTATION,
  SET_USER_MODULE_ACCESS_MUTATION,
  USER_MODULE_ACCESS_QUERY,
} from '../../graphql';
import {
  assignModuleManager,
  getModulePrimaryManagers,
  getUserModuleAccess,
  removeModuleManager,
  setUserModuleAccess,
} from '../module-access-api';

const USER = '22222222-2222-4222-8222-222222222222';

describe('tenant-admin module-access API', () => {
  beforeEach(() => {
    graphql.mockReset();
  });

  it('assigns and removes a module manager by the module code', async () => {
    graphql.mockResolvedValueOnce({ assignModuleManager: { id: 'tm-farm', moduleId: 'm-farm' } });
    await assignModuleManager('farm', USER);
    expect(graphql).toHaveBeenLastCalledWith(ASSIGN_MODULE_MANAGER_MUTATION, {
      input: { moduleCode: 'farm', userId: USER },
    });

    graphql.mockResolvedValueOnce({ removeModuleManager: { id: 'tm-hr', moduleId: 'm-hr' } });
    await removeModuleManager('hr');
    expect(graphql).toHaveBeenLastCalledWith(REMOVE_MODULE_MANAGER_MUTATION, { moduleCode: 'hr' });
  });

  it("reads a member's module roles, one per owner module", async () => {
    graphql.mockResolvedValue({
      userModuleAccess: {
        userId: USER,
        moduleAccess: {
          farm: 'MODULE_MANAGER',
          hr: null,
          sensor: 'MODULE_USER',
          hydroponics: null,
        },
      },
    });

    await expect(getUserModuleAccess(USER)).resolves.toEqual({
      farm: 'MODULE_MANAGER',
      hr: null,
      sensor: 'MODULE_USER',
      hydroponics: null,
    });
    expect(graphql).toHaveBeenCalledWith(USER_MODULE_ACCESS_QUERY, { userId: USER });
  });

  it('refuses a reply for another member or with a role that is no module role', async () => {
    graphql.mockResolvedValueOnce({
      userModuleAccess: {
        userId: 'someone-else',
        moduleAccess: { farm: null, hr: null, sensor: null, hydroponics: null },
      },
    });
    await expect(getUserModuleAccess(USER)).rejects.toThrow('userModuleAccess');

    graphql.mockResolvedValueOnce({
      userModuleAccess: {
        userId: USER,
        moduleAccess: { farm: 'TENANT_ADMIN', hr: null, sensor: null, hydroponics: null },
      },
    });
    await expect(getUserModuleAccess(USER)).rejects.toThrow('userModuleAccess');
  });

  it("replaces a member's module roles as a whole", async () => {
    const moduleAccess = {
      farm: 'MODULE_USER',
      hr: null,
      sensor: null,
      hydroponics: null,
    } as const;
    graphql.mockResolvedValue({ setUserModuleAccess: { userId: USER, moduleAccess } });

    await expect(setUserModuleAccess(USER, moduleAccess)).resolves.toEqual(moduleAccess);
    expect(graphql).toHaveBeenCalledWith(SET_USER_MODULE_ACCESS_MUTATION, {
      input: { userId: USER, moduleAccess },
    });
  });

  it("lists each owner module's primary manager and refuses a module that owns no data", async () => {
    graphql.mockResolvedValueOnce({
      modulePrimaryManagers: [{ moduleCode: 'farm', userId: USER }],
    });
    await expect(getModulePrimaryManagers()).resolves.toEqual([
      { moduleCode: 'farm', userId: USER },
    ]);
    expect(graphql).toHaveBeenLastCalledWith(MODULE_PRIMARY_MANAGERS_QUERY);

    graphql.mockResolvedValueOnce({
      modulePrimaryManagers: [{ moduleCode: 'alert', userId: USER }],
    });
    await expect(getModulePrimaryManagers()).rejects.toThrow('modulePrimaryManagers');
  });

  it('no longer reads tenant_modules.managerId', () => {
    for (const document of [
      MY_TENANT_MODULES_QUERY,
      ASSIGN_MODULE_MANAGER_MUTATION,
      REMOVE_MODULE_MANAGER_MUTATION,
    ]) {
      expect(document).not.toContain('managerId');
    }
  });
});
