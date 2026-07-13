import 'reflect-metadata';

import { NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { In } from 'typeorm';

import {
  UpdateTenantLocalizationPreferencesInput,
  UpdateTenantSecurityPolicyInput,
} from '../dto/tenant-policy.dto';
import { Tenant } from '../entities/tenant.entity';
import { TenantAdminService } from '../services/tenant-admin.service';

/**
 * ADR-042 — tenant auth-security policy + localization preferences
 * (ADMIN-HIGH-010 / ADMIN-MEDIUM-010).
 *
 * London-school: TenantAdminService is exercised against mocked repository
 * collaborators; the revocation-on-flip contract is asserted at the
 * refreshTokenRepository.update boundary (the same primitive logout-all /
 * deactivateUser use).
 */

const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADMIN_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const buildTenant = (overrides: Partial<Tenant> = {}): Tenant =>
  Object.assign(new Tenant(), {
    id: TENANT_ID,
    name: 'Acme Farms',
    slug: 'acme',
    ...overrides,
  });

describe('TenantAdminService — tenant security policy (ADR-042)', () => {
  const tenantRepository = { findOne: jest.fn(), save: jest.fn() };
  const userRepository = { findOne: jest.fn(), find: jest.fn() };
  const refreshTokenRepository = { update: jest.fn() };
  const auditLogService = { log: jest.fn().mockResolvedValue(undefined) };

  // Only the collaborators the ADR-042 methods touch are real mocks; the
  // rest of the constructor surface is inert.
  const buildService = (): TenantAdminService =>
    new TenantAdminService(
      tenantRepository as never,
      {} as never, // tenantModuleRepository
      userRepository as never,
      {} as never, // userModuleAssignmentRepository
      {} as never, // userSiteAssignmentRepository
      {} as never, // moduleRepository
      refreshTokenRepository as never,
      {} as never, // dataSource
      auditLogService as never,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    tenantRepository.save.mockImplementation((t: Tenant) => Promise.resolve(t));
    userRepository.findOne.mockResolvedValue({
      id: ADMIN_ID,
      email: 'admin@acme.test',
      tenantId: TENANT_ID,
    });
    userRepository.find.mockResolvedValue([]);
    refreshTokenRepository.update.mockResolvedValue({ affected: 0 });
    auditLogService.log.mockResolvedValue(undefined);
  });

  describe('getSecurityPolicy', () => {
    it('collapses NULL enforce_mfa to the effective default false', async () => {
      tenantRepository.findOne.mockResolvedValue(buildTenant());

      const policy = await buildService().getSecurityPolicy(TENANT_ID);

      expect(policy).toEqual({ enforceMfa: false, sessionTimeoutMinutes: null });
    });

    it('returns the stored policy values', async () => {
      tenantRepository.findOne.mockResolvedValue(
        buildTenant({ enforceMfa: true, sessionTimeoutMinutes: 45 }),
      );

      const policy = await buildService().getSecurityPolicy(TENANT_ID);

      expect(policy).toEqual({ enforceMfa: true, sessionTimeoutMinutes: 45 });
    });

    it('throws NotFound for an unknown tenant', async () => {
      tenantRepository.findOne.mockResolvedValue(null);

      await expect(buildService().getSecurityPolicy(TENANT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('updateSecurityPolicy', () => {
    it('persists the provided fields and returns the effective policy', async () => {
      tenantRepository.findOne.mockResolvedValue(buildTenant());

      const result = await buildService().updateSecurityPolicy(ADMIN_ID, TENANT_ID, {
        sessionTimeoutMinutes: 30,
      });

      expect(tenantRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ sessionTimeoutMinutes: 30 }),
      );
      expect(result).toEqual({ enforceMfa: false, sessionTimeoutMinutes: 30 });
      expect(auditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'TENANT_SECURITY_POLICY_UPDATED',
          tenantId: TENANT_ID,
          performedBy: ADMIN_ID,
        }),
      );
    });

    it('REVOCATION-ON-FLIP: false/NULL→true revokes refresh tokens of non-MFA users ONLY', async () => {
      tenantRepository.findOne.mockResolvedValue(buildTenant({ enforceMfa: null }));
      userRepository.find.mockResolvedValue([{ id: 'user-no-mfa-1' }, { id: 'user-no-mfa-2' }]);

      await buildService().updateSecurityPolicy(ADMIN_ID, TENANT_ID, { enforceMfa: true });

      // The user scan targets EXACTLY the non-enrolled population.
      expect(userRepository.find).toHaveBeenCalledWith({
        where: { tenantId: TENANT_ID, mfaEnabled: false },
        select: ['id'],
      });
      // Same revocation primitive as logout-all/deactivate, scoped to them.
      expect(refreshTokenRepository.update).toHaveBeenCalledWith(
        { userId: In(['user-no-mfa-1', 'user-no-mfa-2']), isRevoked: false },
        expect.objectContaining({
          isRevoked: true,
          revokedReason: 'Tenant MFA enforcement enabled',
        }),
      );
      // Security event carries the flip + blast radius at WARNING severity.
      expect(auditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'TENANT_SECURITY_POLICY_UPDATED',
          severity: 'warning',
          details: expect.objectContaining({
            enforcementFlippedOn: true,
            revokedUserCount: 2,
          }),
        }),
      );
    });

    it('no flip (true→true) → no revocation runs', async () => {
      tenantRepository.findOne.mockResolvedValue(buildTenant({ enforceMfa: true }));

      await buildService().updateSecurityPolicy(ADMIN_ID, TENANT_ID, { enforceMfa: true });

      expect(userRepository.find).not.toHaveBeenCalled();
      expect(refreshTokenRepository.update).not.toHaveBeenCalled();
    });

    it('disabling enforcement (true→false) never revokes', async () => {
      tenantRepository.findOne.mockResolvedValue(buildTenant({ enforceMfa: true }));

      await buildService().updateSecurityPolicy(ADMIN_ID, TENANT_ID, { enforceMfa: false });

      expect(refreshTokenRepository.update).not.toHaveBeenCalled();
    });

    it('flip with zero non-MFA users → no token UPDATE issued', async () => {
      tenantRepository.findOne.mockResolvedValue(buildTenant({ enforceMfa: false }));
      userRepository.find.mockResolvedValue([]);

      await buildService().updateSecurityPolicy(ADMIN_ID, TENANT_ID, { enforceMfa: true });

      expect(refreshTokenRepository.update).not.toHaveBeenCalled();
    });
  });

  describe('localization preferences', () => {
    it('persists and returns timezone + dateFormat', async () => {
      tenantRepository.findOne.mockResolvedValue(buildTenant());

      const result = await buildService().updateLocalizationPreferences(ADMIN_ID, TENANT_ID, {
        timezone: 'Europe/Istanbul',
        dateFormat: 'DD/MM/YYYY',
      });

      expect(tenantRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ timezone: 'Europe/Istanbul', dateFormat: 'DD/MM/YYYY' }),
      );
      expect(result).toEqual({ timezone: 'Europe/Istanbul', dateFormat: 'DD/MM/YYYY' });
      expect(auditLogService.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'TENANT_LOCALIZATION_PREFERENCES_UPDATED' }),
      );
    });

    it('reads back stored preferences (nulls when unset)', async () => {
      tenantRepository.findOne.mockResolvedValue(buildTenant());

      const result = await buildService().getLocalizationPreferences(TENANT_ID);

      expect(result).toEqual({ timezone: null, dateFormat: null });
    });
  });
});

describe('UpdateTenantSecurityPolicyInput — validation bounds (ADR-042)', () => {
  const buildInput = (
    overrides: Partial<UpdateTenantSecurityPolicyInput>,
  ): UpdateTenantSecurityPolicyInput =>
    Object.assign(new UpdateTenantSecurityPolicyInput(), overrides);

  it.each([4, 1441, 0, -5])('rejects sessionTimeoutMinutes=%i (outside 5..1440)', async (value) => {
    const errors = await validate(buildInput({ sessionTimeoutMinutes: value }));
    expect(errors.length).toBeGreaterThan(0);
  });

  it.each([5, 1440, 480])('accepts sessionTimeoutMinutes=%i', async (value) => {
    const errors = await validate(buildInput({ sessionTimeoutMinutes: value }));
    expect(errors).toHaveLength(0);
  });

  it('accepts an empty patch (both fields optional)', async () => {
    const errors = await validate(buildInput({}));
    expect(errors).toHaveLength(0);
  });
});

describe('UpdateTenantLocalizationPreferencesInput — validation (ADR-042)', () => {
  const buildInput = (
    overrides: Partial<UpdateTenantLocalizationPreferencesInput>,
  ): UpdateTenantLocalizationPreferencesInput =>
    Object.assign(new UpdateTenantLocalizationPreferencesInput(), overrides);

  it.each(['Europe/Istanbul', 'America/New_York', 'UTC'])(
    'accepts IANA timezone %s',
    async (timezone) => {
      const errors = await validate(buildInput({ timezone }));
      expect(errors).toHaveLength(0);
    },
  );

  it.each(['Not/AZone', 'Mars/Olympus_Mons', '<script>', ''])(
    'rejects invalid timezone %s',
    async (timezone) => {
      const errors = await validate(buildInput({ timezone }));
      expect(errors.length).toBeGreaterThan(0);
    },
  );

  it.each(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'] as const)(
    'accepts dateFormat %s',
    async (dateFormat) => {
      const errors = await validate(buildInput({ dateFormat }));
      expect(errors).toHaveLength(0);
    },
  );

  it('rejects a dateFormat outside the closed vocabulary', async () => {
    const errors = await validate(
      Object.assign(new UpdateTenantLocalizationPreferencesInput(), {
        dateFormat: 'YYYY/DD/MM',
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
  });
});
