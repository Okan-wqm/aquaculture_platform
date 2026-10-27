import 'reflect-metadata';
import { isTenantCapability } from '@aquaculture/shared-contracts';
import { createMockDataSource } from '@aquaculture/testing';
import { Logger } from '@nestjs/common';
import type { QueryRunner } from 'typeorm';

import { RemoveInertTenantCapabilities1810500000000 } from '../1810500000000-RemoveInertTenantCapabilities';
import {
  INERT_TENANT_CAPABILITIES,
  overridesWithoutInert,
  panelWithoutInert,
} from '../support/inert-tenant-capabilities';

/**
 * RBAC-HIGH-025 cleanup. PKG-03 removed from the catalogue the 81 keys no backend check read; the
 * token mint already drops them (it intersects grants with the catalogue), so a stored grant of
 * one has no effect. This migration removes them from what is stored — role grants, role panels
 * and per-user overrides — so the role editor never round-trips a key the write path refuses,
 * and it logs per-tenant counts. It is idempotent: a second run changes nothing.
 */

interface RoleRow {
  role_id: string;
  tenant_id: string;
  panel_permissions: unknown;
  resource_permissions: string[] | null;
}

type QueryMock = jest.Mocked<QueryRunner>['query'];

interface AssignmentRow {
  id: string;
  tenant_id: string;
  permission_overrides: unknown;
}

function runnerOver(
  roles: RoleRow[],
  assignments: AssignmentRow[],
): { runner: QueryRunner; query: QueryMock } {
  const { mockQueryRunner } = createMockDataSource();
  mockQueryRunner.query.mockImplementation((sql: string) => {
    if (sql.includes('FROM "auth"."tenant_role_permissions"')) return Promise.resolve(roles);
    if (sql.includes('FROM "auth"."user_role_assignments"')) return Promise.resolve(assignments);
    return Promise.resolve([]);
  });
  return { runner: mockQueryRunner, query: mockQueryRunner.query };
}

function updatesOf(query: QueryMock, table: string): unknown[][] {
  return query.mock.calls
    .filter(([sql]) => typeof sql === 'string' && sql.includes(`UPDATE "auth"."${table}"`))
    .map(([, params]) => params as unknown[]);
}

describe('RemoveInertTenantCapabilities1810500000000', () => {
  let logged: string[];

  beforeEach(() => {
    logged = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => {
      logged.push(String(message));
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('the inert set (a snapshot of the keys PKG-03 removed)', () => {
    it('holds 81 unique resource:action keys', () => {
      expect(INERT_TENANT_CAPABILITIES).toHaveLength(81);
      expect(new Set(INERT_TENANT_CAPABILITIES).size).toBe(81);
      for (const key of INERT_TENANT_CAPABILITIES) {
        expect(key).toMatch(/^[a-z_]+:[a-z_]+$/);
      }
      expect(INERT_TENANT_CAPABILITIES).toEqual(
        expect.arrayContaining([
          'batches:create',
          'tanks:assign',
          'employees:view',
          'dashboard:analytics',
          'settings:edit',
          'channels:view',
          'messages:send',
        ]),
      );
    });

    it('removes no key the catalogue offers (a key re-added later had its R1 grants wiped)', () => {
      expect(INERT_TENANT_CAPABILITIES.filter(isTenantCapability)).toEqual([]);
      // settings:view stays until the PKG-03 web part (release R2) stops reading it.
      expect(INERT_TENANT_CAPABILITIES).not.toContain('settings:view');
    });
  });

  describe('panelWithoutInert', () => {
    it('drops inert actions, then resources and categories left empty', () => {
      expect(
        panelWithoutInert({
          farm: { sites: { view: true, create: false } },
          admin: { settings: { view: true, edit: false }, users: { view: true } },
          messaging: { channels: { view: true, create_group: true }, messages: { send: true } },
        }),
      ).toEqual({
        admin: { settings: { view: true }, users: { view: true } },
        messaging: { channels: { create_group: true } },
      });
    });

    it('keeps what it does not know (only the snapshot is removed)', () => {
      const panel = { hr: { 'HR Finance': { view_salary: true } } };
      expect(panelWithoutInert(panel)).toEqual(panel);
    });
  });

  describe('overridesWithoutInert', () => {
    it('drops inert keys from grants and revokes, and reports no change when there is none', () => {
      expect(
        overridesWithoutInert({ grants: ['users:view', 'tanks:edit'], revokes: ['sites:view'] }),
      ).toEqual({ grants: ['users:view'], revokes: [] });
      expect(overridesWithoutInert({ grants: ['users:view'], revokes: [] })).toBeNull();
      expect(overridesWithoutInert('{"grants":["feeding:record"],"revokes":[]}')).toEqual({
        grants: [],
        revokes: [],
      });
    });
  });

  it('cleans the roles and overrides that hold an inert key, and logs counts per tenant', async () => {
    const { runner, query } = runnerOver(
      [
        {
          role_id: 'role-a1',
          tenant_id: 'tenant-a',
          panel_permissions: { farm: { sites: { view: true } }, admin: { users: { view: true } } },
          resource_permissions: ['sites:view', 'users:view', 'tanks:view'],
        },
        {
          role_id: 'role-a2',
          tenant_id: 'tenant-a',
          panel_permissions: '{"admin":{"roles":{"view":true}}}',
          resource_permissions: ['roles:view'],
        },
        {
          role_id: 'role-b1',
          tenant_id: 'tenant-b',
          panel_permissions: { messaging: { messages: { send: true } } },
          resource_permissions: ['messages:send'],
        },
      ],
      [
        {
          id: 'assignment-b1',
          tenant_id: 'tenant-b',
          permission_overrides: { grants: ['batches:create'], revokes: ['users:view'] },
        },
        {
          id: 'assignment-b2',
          tenant_id: 'tenant-b',
          permission_overrides: { grants: [], revokes: [] },
        },
      ],
    );

    await new RemoveInertTenantCapabilities1810500000000().up(runner);

    expect(updatesOf(query, 'tenant_role_permissions')).toEqual([
      [JSON.stringify({ admin: { users: { view: true } } }), ['users:view'], 'role-a1'],
      [JSON.stringify({}), [], 'role-b1'],
    ]);
    expect(updatesOf(query, 'user_role_assignments')).toEqual([
      [JSON.stringify({ grants: [], revokes: ['users:view'] }), 'assignment-b1'],
    ]);
    const events = logged.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual([
      {
        event: 'inert_tenant_capabilities_removed',
        tenantId: 'tenant-a',
        roles: 1,
        roleGrants: 2,
        assignments: 0,
        overrideEntries: 0,
      },
      {
        event: 'inert_tenant_capabilities_removed',
        tenantId: 'tenant-b',
        roles: 1,
        roleGrants: 1,
        assignments: 1,
        overrideEntries: 1,
      },
      { event: 'inert_tenant_capabilities_cleanup_done', tenants: 2, roles: 2, assignments: 1 },
    ]);
  });

  it('locks the rows it reads', async () => {
    const { runner, query } = runnerOver([], []);
    await new RemoveInertTenantCapabilities1810500000000().up(runner);
    const reads = query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes('SELECT'));
    expect(reads).toHaveLength(2);
    expect(reads[0]).toContain('FOR UPDATE OF trp');
    expect(reads[1]).toContain('FOR UPDATE OF ura');
  });

  it('is idempotent: clean rows are left alone', async () => {
    const { runner, query } = runnerOver(
      [
        {
          role_id: 'role-a1',
          tenant_id: 'tenant-a',
          panel_permissions: { admin: { users: { view: true } } },
          resource_permissions: ['users:view'],
        },
      ],
      [
        {
          id: 'assignment-a1',
          tenant_id: 'tenant-a',
          permission_overrides: { grants: [], revokes: [] },
        },
      ],
    );

    await new RemoveInertTenantCapabilities1810500000000().up(runner);

    expect(updatesOf(query, 'tenant_role_permissions')).toEqual([]);
    expect(updatesOf(query, 'user_role_assignments')).toEqual([]);
    expect(logged.map((line) => JSON.parse(line) as Record<string, unknown>)).toEqual([
      { event: 'inert_tenant_capabilities_cleanup_done', tenants: 0, roles: 0, assignments: 0 },
    ]);
  });

  it('down restores nothing: the keys were inert, and which role held which is not kept', async () => {
    const { runner, query } = runnerOver([], []);
    await new RemoveInertTenantCapabilities1810500000000().down(runner);
    expect(query).not.toHaveBeenCalled();
  });
});
