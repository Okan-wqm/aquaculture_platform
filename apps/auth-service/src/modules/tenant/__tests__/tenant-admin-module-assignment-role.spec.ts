import { Role } from '@aquaculture/backend-common/decorators';
import { collaborator, stub, stubMember } from '@aquaculture/testing';
import type { DataSource, EntityManager, Repository } from 'typeorm';

import type { AuditLogService } from '../../../audit/audit-log.service';
import type { RefreshToken } from '../../authentication/entities/refresh-token.entity';
import { UserModuleAssignment } from '../../authentication/entities/user-module-assignment.entity';
import type { UserSiteAssignment } from '../../authentication/entities/user-site-assignment.entity';
import { User } from '../../authentication/entities/user.entity';
import type { DurableUserTokenInvalidationService } from '../../authentication/services/durable-user-token-invalidation.service';
import type { Module } from '../../system-module/entities/module.entity';
import { Tenant, TenantStatus } from '../entities/tenant.entity';
import type { TenantModule } from '../entities/tenant-module.entity';
import type { FarmSiteAssignmentValidator } from '../services/farm-site-assignment-validator.service';
import { TenantAdminService } from '../services/tenant-admin.service';

const ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_ID = '22222222-2222-4222-8222-222222222222';
const MODULE_ID = '33333333-3333-4333-8333-333333333333';

interface Fixture {
  service: TenantAdminService;
  saved: Array<Partial<UserModuleAssignment>>;
}

/** assignUserToModule over doubles: an existing member of the tenant, and a module of a code. */
function makeFixture(options: {
  moduleCode: string;
  userRole: Role;
  existing?: UserModuleAssignment | null;
  managerId?: string | null;
}): Fixture {
  const saved: Array<Partial<UserModuleAssignment>> = [];
  const admin = Object.assign(new User(), {
    id: ADMIN_ID,
    role: Role.TENANT_ADMIN,
    tenantId: TENANT_ID,
  });
  const member = Object.assign(new User(), {
    id: USER_ID,
    email: 'member@example.test',
    role: options.userRole,
    tenantId: TENANT_ID,
  });
  const tenant = Object.assign(new Tenant(), {
    id: TENANT_ID,
    name: 'Acme',
    status: TenantStatus.ACTIVE,
    maxUsers: 50,
  });
  const assignmentRepository = stub<Repository<UserModuleAssignment>>({
    findOne: jest.fn().mockResolvedValue(options.existing ?? null),
    create: stubMember<Repository<UserModuleAssignment>['create']>(
      (input: Partial<UserModuleAssignment>) => Object.assign(new UserModuleAssignment(), input),
    ),
    save: stubMember<Repository<UserModuleAssignment>['save']>(
      (input: Partial<UserModuleAssignment>) => {
        saved.push({ ...input });
        return Promise.resolve(input);
      },
    ),
  });
  const manager = stub<EntityManager>({
    getRepository: stubMember<EntityManager['getRepository']>((entity: unknown) => {
      if (entity === UserModuleAssignment) return assignmentRepository;
      if (entity === User) return stub<Repository<User>>({});
      throw new Error('unexpected repository');
    }),
  });
  const dataSource = stub<DataSource>({
    transaction: stubMember<DataSource['transaction']>(
      (work: (transactionManager: EntityManager) => Promise<unknown>) => work(manager),
    ),
  });

  const service = new TenantAdminService(
    stub<Repository<Tenant>>({ findOne: jest.fn().mockResolvedValue(tenant) }),
    stub<Repository<TenantModule>>({
      findOne: jest.fn().mockResolvedValue({
        tenantId: TENANT_ID,
        moduleId: MODULE_ID,
        managerId: options.managerId ?? null,
        module: { code: options.moduleCode, name: options.moduleCode },
      }),
    }),
    stub<Repository<User>>({
      findOne: jest.fn((query: { where: { id?: string; email?: string } }) =>
        Promise.resolve(query.where.id === ADMIN_ID ? admin : member),
      ),
    }),
    stub<Repository<UserModuleAssignment>>({}),
    stub<Repository<UserSiteAssignment>>({}),
    stub<Repository<Module>>({}),
    stub<Repository<RefreshToken>>({}),
    dataSource,
    collaborator<AuditLogService>({}, 'AuditLogService'),
    collaborator<FarmSiteAssignmentValidator>({}, 'FarmSiteAssignmentValidator'),
    collaborator<DurableUserTokenInvalidationService>({}, 'DurableUserTokenInvalidationService'),
  );
  return { service, saved };
}

const input = (
  role: 'manager' | 'operator',
): {
  firstName: string;
  lastName: string;
  email: string;
  moduleId: string;
  role: string;
} => ({
  firstName: 'Mem',
  lastName: 'Ber',
  email: 'member@example.test',
  moduleId: MODULE_ID,
  role,
});

/**
 * RBAC-HIGH-027: assignUserToModule writes the module role with the grant, by the backfill's
 * rule (until PKG-06 deletes this mutation, which no web document calls).
 */
describe('TenantAdminService.assignUserToModule writes the module role (RBAC-HIGH-027)', () => {
  it('writes MODULE_MANAGER for the primary manager the admin chose, hr included', async () => {
    const fixture = makeFixture({ moduleCode: 'hr', userRole: Role.MODULE_USER });

    await fixture.service.assignUserToModule(ADMIN_ID, input('manager'));

    expect(fixture.saved).toEqual([
      expect.objectContaining({ isPrimaryManager: true, role: 'MODULE_MANAGER' }),
    ]);
  });

  it('never derives an hr manager grant from the global MODULE_MANAGER role (D6)', async () => {
    const fixture = makeFixture({ moduleCode: 'hr', userRole: Role.MODULE_MANAGER });

    await fixture.service.assignUserToModule(ADMIN_ID, input('operator'));

    expect(fixture.saved).toEqual([
      expect.objectContaining({ isPrimaryManager: false, role: 'MODULE_USER' }),
    ]);
  });

  it('keeps a legacy global MODULE_MANAGER managing a non-hr module, as today', async () => {
    const fixture = makeFixture({ moduleCode: 'sensor', userRole: Role.MODULE_MANAGER });

    await fixture.service.assignUserToModule(ADMIN_ID, input('operator'));

    expect(fixture.saved).toEqual([
      expect.objectContaining({ isPrimaryManager: false, role: 'MODULE_MANAGER' }),
    ]);
  });

  it("gives the module's designated manager (Assign Manager) a manager grant, never in hr (D6)", async () => {
    const farm = makeFixture({
      moduleCode: 'farm',
      userRole: Role.MODULE_USER,
      managerId: USER_ID,
    });
    const hr = makeFixture({ moduleCode: 'hr', userRole: Role.MODULE_USER, managerId: USER_ID });

    await farm.service.assignUserToModule(ADMIN_ID, input('operator'));
    await hr.service.assignUserToModule(ADMIN_ID, input('operator'));

    expect(farm.saved).toEqual([
      expect.objectContaining({ isPrimaryManager: false, role: 'MODULE_MANAGER' }),
    ]);
    expect(hr.saved).toEqual([
      expect.objectContaining({ isPrimaryManager: false, role: 'MODULE_USER' }),
    ]);
  });

  it('sets the role again when it reactivates an assignment', async () => {
    const existing = Object.assign(new UserModuleAssignment(), {
      userId: USER_ID,
      moduleId: MODULE_ID,
      tenantId: TENANT_ID,
      isActive: false,
      isPrimaryManager: true,
      role: null,
    });
    const fixture = makeFixture({ moduleCode: 'farm', userRole: Role.MODULE_USER, existing });

    await fixture.service.assignUserToModule(ADMIN_ID, input('operator'));

    expect(fixture.saved).toEqual([
      expect.objectContaining({ isActive: true, isPrimaryManager: false, role: 'MODULE_USER' }),
    ]);
  });
});
