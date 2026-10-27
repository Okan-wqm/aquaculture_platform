import 'reflect-metadata';

import { ROLES_KEY, Role } from '@aquaculture/backend-common/decorators';
import { collaborator } from '@aquaculture/testing';

import { ModuleAccessReadinessView } from '../../dto/module-access-readiness.dto';
import type { ModuleAccessReadinessReport } from '../../services/module-access-readiness';
import type { ModuleAccessReadinessService } from '../../services/module-access-readiness.service';
import { ModuleAccessReadinessResolver } from '../module-access-readiness.resolver';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const REPORT: ModuleAccessReadinessReport = {
  windowDays: 90,
  membersWithoutGrants: [
    { role: 'MODULE_MANAGER', count: 0 },
    { role: 'MODULE_USER', count: 2 },
  ],
  modules: [
    {
      moduleCode: 'farm',
      grantsByRole: [
        { role: 'MODULE_MANAGER', count: 1 },
        { role: 'MODULE_USER', count: 3 },
      ],
      recentWritersWithoutGrant: { status: 'UNAVAILABLE', byUserRole: [] },
    },
  ],
  payrollViewers: {
    byGlobalRole: [
      { role: 'TENANT_ADMIN', count: 1 },
      { role: 'MODULE_MANAGER', count: 4 },
    ],
    byGrant: [
      { role: 'TENANT_ADMIN', count: 1 },
      { role: 'MODULE_MANAGER', count: 0 },
    ],
  },
};

/**
 * moduleAccessReadiness (PKG-06): a tenant administrator's query, for the caller's own tenant
 * from the verified claim, answered with the report's counts as they are.
 */
describe('ModuleAccessReadinessResolver', () => {
  it('requires TenantAdminOrHigher', () => {
    const descriptor = Object.getOwnPropertyDescriptor(
      ModuleAccessReadinessResolver.prototype,
      'moduleAccessReadiness',
    );
    expect(descriptor).toBeDefined();
    expect(Reflect.getMetadata(ROLES_KEY, descriptor?.value)).toEqual([
      Role.SUPER_ADMIN,
      Role.TENANT_ADMIN,
    ]);
  });

  it("reports the caller's tenant", async () => {
    const readiness = jest.fn().mockResolvedValue(REPORT);
    const resolver = new ModuleAccessReadinessResolver(
      collaborator<ModuleAccessReadinessService>({ readiness }, 'ModuleAccessReadinessService'),
    );

    const view = await resolver.moduleAccessReadiness(TENANT);

    expect(readiness).toHaveBeenCalledWith(TENANT);
    expect(view).toBeInstanceOf(ModuleAccessReadinessView);
    expect(JSON.parse(JSON.stringify(view))).toEqual(REPORT);
  });
});
