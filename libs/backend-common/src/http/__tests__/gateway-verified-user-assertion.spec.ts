import type { ImpersonationPermissionsContract } from '@aquaculture/shared-contracts';
import { Role } from '@platform/identity';

import {
  buildGatewayVerifiedUserAssertion,
  requireCanonicalGatewayAssertionRoles,
} from '../gateway-verified-user-assertion';

const FIXED_INPUT = Object.freeze({
  subject: 'admin-user-id',
  tenantId: '33333333-3333-4333-8333-333333333333',
  effectiveTenantId: '22222222-2222-4222-8222-222222222222',
  roles: [Role.SUPER_ADMIN],
  email: 'admin@example.test',
  mfaVerified: true,
  assertionId: '44444444-4444-4444-8444-444444444444',
  issuedAt: new Date('2026-08-09T12:00:00.000Z'),
  impersonationSessionId: '11111111-1111-4111-8111-111111111111',
});

describe('buildGatewayVerifiedUserAssertion impersonation provenance', () => {
  it('rejects the complete producer role list when any role is outside the platform SSoT', () => {
    expect(() =>
      requireCanonicalGatewayAssertionRoles([Role.SUPER_ADMIN, 'FARM_MANAGER']),
    ).toThrow('ASSERTION_INVALID_ROLES');
  });

  it('produces identical signed bytes for equivalent permission object key order', () => {
    const permissionsOne: ImpersonationPermissionsContract = {
      canViewData: true,
      canModifyData: false,
      canAccessSettings: true,
      canManageUsers: false,
      canViewBilling: true,
      canExportData: false,
      allowedModules: ['farm', 'billing'],
      restrictedModules: ['sensor', 'ai'],
    };
    const permissionsTwo: ImpersonationPermissionsContract = {
      restrictedModules: ['ai', 'sensor'],
      canExportData: false,
      canViewBilling: true,
      canManageUsers: false,
      canAccessSettings: true,
      canModifyData: false,
      canViewData: true,
      allowedModules: ['billing', 'farm'],
    };

    const first = buildGatewayVerifiedUserAssertion({
      ...FIXED_INPUT,
      impersonationPermissions: permissionsOne,
    });
    const second = buildGatewayVerifiedUserAssertion({
      impersonationPermissions: permissionsTwo,
      ...FIXED_INPUT,
    });

    expect(second).toBe(first);
    expect(JSON.parse(Buffer.from(first, 'base64url').toString('utf8'))).toMatchObject({
      effectiveTenantId: FIXED_INPUT.effectiveTenantId,
      impersonationSessionId: FIXED_INPUT.impersonationSessionId,
      impersonationPermissions: permissionsOne,
    });
  });

  it('rejects duplicate, overlapping, unknown, or incomplete permission provenance', () => {
    const baseline = {
      canViewData: true,
      canModifyData: false,
      canAccessSettings: true,
      canManageUsers: false,
      canViewBilling: true,
      canExportData: false,
    };
    const malformed: unknown[] = [
      { ...baseline, allowedModules: ['farm', 'farm'] },
      {
        ...baseline,
        allowedModules: ['farm'],
        restrictedModules: ['farm'],
      },
      { ...baseline, unexpected: true },
    ];

    for (const impersonationPermissions of malformed) {
      expect(() =>
        buildGatewayVerifiedUserAssertion({
          ...FIXED_INPUT,
          impersonationPermissions: impersonationPermissions as ImpersonationPermissionsContract,
        }),
      ).toThrow('ASSERTION_INVALID_SHAPE');
    }

    expect(() =>
      buildGatewayVerifiedUserAssertion({
        ...FIXED_INPUT,
        impersonationPermissions: baseline,
        impersonationSessionId: undefined,
      }),
    ).toThrow('ASSERTION_INVALID_SHAPE');
  });

  it('delegates present optional claims to the closed compiler without dropping them', () => {
    const encoded = buildGatewayVerifiedUserAssertion({
      ...FIXED_INPUT,
      assignedSiteIds: [],
      impersonationPermissions: {
        canViewData: true,
        canModifyData: false,
        canAccessSettings: false,
        canManageUsers: false,
        canViewBilling: false,
        canExportData: false,
      },
    });
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toHaveProperty(
      'assignedSiteIds',
      [],
    );
    expect(() =>
      buildGatewayVerifiedUserAssertion({
        ...FIXED_INPUT,
        clientIp: '',
        impersonationPermissions: {
          canViewData: true,
          canModifyData: false,
          canAccessSettings: false,
          canManageUsers: false,
          canViewBilling: false,
          canExportData: false,
        },
      }),
    ).toThrow('ASSERTION_INVALID_SHAPE');
  });

  it('cannot mint a cross-tenant assertion without impersonation provenance', () => {
    expect(() =>
      buildGatewayVerifiedUserAssertion({
        subject: FIXED_INPUT.subject,
        tenantId: FIXED_INPUT.tenantId,
        effectiveTenantId: FIXED_INPUT.effectiveTenantId,
        roles: FIXED_INPUT.roles,
        email: FIXED_INPUT.email,
        mfaVerified: FIXED_INPUT.mfaVerified,
        assertionId: FIXED_INPUT.assertionId,
        issuedAt: FIXED_INPUT.issuedAt,
      }),
    ).toThrow('ASSERTION_INVALID_SHAPE');
  });
});
