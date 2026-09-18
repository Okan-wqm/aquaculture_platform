import 'reflect-metadata';

import { collaborator, stub } from '@aquaculture/testing';

import { AuditLogService } from '../../../audit/audit-log.service';
import { Tenant, TenantPlan, TenantStatus } from '../../tenant/entities/tenant.entity';
import { TenantResolver } from '../../tenant/resolvers/tenant.resolver';
import { TenantProvisioningCommandService } from '../../tenant/services/tenant-provisioning-command.service';
import { TenantService } from '../../tenant/services/tenant.service';
import { AuthResolver } from '../resolvers/auth.resolver';

/**
 * Public-surface contract — SEC-CRITICAL-001 + MT-LOW-001 regression guards.
 *
 * WHY: the 2026-06-10 audit found the public `register` mutation accepted a
 * client-supplied tenantId with zero validation (anonymous cross-tenant
 * account injection), and the public `tenantBySlug` query leaked the internal
 * tenant UUID + lifecycle status — the exact harvest leg feeding the
 * injection. Both were removed. These tests make re-introduction loud:
 * adding the method back fails CI until a deliberate architectural decision
 * (a "new tenant + first admin" onboarding saga) replaces it.
 */
describe('Public surface contract (SEC-CRITICAL-001 / MT-LOW-001)', () => {
  it('AuthResolver does NOT expose a register mutation', () => {
    const descriptor = Object.getOwnPropertyDescriptor(AuthResolver.prototype, 'register');
    expect(descriptor).toBeUndefined();
  });

  it('AuthenticationService does NOT expose a register method', async () => {
    const { AuthenticationService } = await import('../services/authentication.service');
    const descriptor = Object.getOwnPropertyDescriptor(AuthenticationService.prototype, 'register');
    expect(descriptor).toBeUndefined();
  });

  it('tenantBySlug implementation returns only name/slug/logoUrl keys', async () => {
    // The leaky row the resolver must NOT forward: a full tenant entity whose
    // `id`/`status`/`plan` are exactly the fields MT-LOW-001 removed from the
    // public payload. `stub<Tenant>` keeps those field names checked against
    // the real entity, so a rename cannot quietly turn this into a fixture
    // that proves nothing.
    const leakyTenant = stub<Tenant>({
      id: 'internal-uuid-must-not-leak',
      name: 'Acme Farms',
      slug: 'acme',
      logoUrl: null,
      status: TenantStatus.ACTIVE,
      plan: TenantPlan.ENTERPRISE,
    });
    const resolver = new TenantResolver(
      collaborator<TenantService>(
        { findBySlug: jest.fn(() => Promise.resolve(leakyTenant)) },
        'TenantService',
      ),
      // The audit and command collaborators are unreachable from the public
      // query; an empty `collaborator` makes any future call to them a named
      // failure instead of a silent `undefined is not a function`.
      collaborator<AuditLogService>({}, 'AuditLogService'),
      collaborator<TenantProvisioningCommandService>({}, 'TenantProvisioningCommandService'),
    );

    const result = await resolver.tenantBySlug('acme');

    // WHY exact-keys assertion: a future field addition to the public payload
    // must be a deliberate decision, not an accidental spread. The exact key
    // set also structurally proves `id` and `status` are absent.
    expect(Object.keys(result).sort()).toEqual(['logoUrl', 'name', 'slug']);
  });
});
