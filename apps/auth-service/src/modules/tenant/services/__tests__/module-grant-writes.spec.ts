import { TenantContextError } from '@aquaculture/backend-common/database';
import { collaborator, stub, stubMember } from '@aquaculture/testing';
import type { EntityManager, Repository } from 'typeorm';

import { UserModuleAssignment } from '../../../authentication/entities/user-module-assignment.entity';
import { writeGrant, type GrantWrite } from '../module-grant-writes';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const WRITE: GrantWrite = {
  userId: '22222222-2222-4222-8222-222222222222',
  moduleId: '10000000-0000-4000-8000-000000000001',
  moduleCode: 'farm',
  row: undefined,
  target: { role: 'MODULE_USER', isPrimaryManager: false },
  assignedBy: '00000000-0000-4000-8000-0000000000ad',
  note: null,
};

function managerBoundTo(binding: readonly unknown[]): {
  manager: EntityManager;
  table: Repository<UserModuleAssignment>;
} {
  // Any write reaching the table fails the spec by name.
  const table = collaborator<Repository<UserModuleAssignment>>({}, 'user_module_assignments');
  const manager = stub<EntityManager>({
    query: stubMember<EntityManager['query']>(() => Promise.resolve(binding)),
    getRepository: stubMember<EntityManager['getRepository']>((entity: unknown) => {
      if (entity !== UserModuleAssignment) throw new Error('unexpected entity');
      return table;
    }),
  });
  return { manager, table };
}

/**
 * The module grant writers (PKG-06) write on a transaction their caller opened and bound to the
 * tenant (user_module_assignments carries the forced tenant-isolation policy). A writer must not
 * re-bind a caller's tenant — a write for tenant B inside tenant A's transaction is the defect to
 * refuse — so it reads the binding back (assertTenantRlsBound) and refuses to write unless the
 * transaction is bound to the tenant it writes for.
 */
describe('writeGrant', () => {
  it.each([
    ['bound to another tenant', [{ tenant: OTHER_TENANT, bypass: 'off' }]],
    ['with the bypass on', [{ tenant: TENANT, bypass: 'on' }]],
    ['with no binding at all', []],
  ])('refuses to write on a transaction %s', async (_label, binding) => {
    const { manager } = managerBoundTo(binding);

    await expect(writeGrant(manager, TENANT, WRITE, new Date())).rejects.toThrow(
      TenantContextError,
    );
  });
});
