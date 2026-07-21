/**
 * User-role DTO validation — regression for APA-050.
 *
 * Before the fix, the admin-api DTOs whitelisted a phantom vocabulary
 * (['SUPER_ADMIN','TENANT_ADMIN','MANAGER','OPERATOR','VIEWER']) so the
 * frontend's canonical MODULE_MANAGER / MODULE_USER roles 400'd with
 * 'Invalid role' — the platform's two most common roles could not be
 * created, edited, or filtered through the panel, while MANAGER/OPERATOR/
 * VIEWER passed the DTO only to be rejected downstream by auth-service's
 * isCanonicalRole. These tests pin the DTOs to the canonical `Role`
 * vocabulary (and the invite DTO to the invitable subset) by running the
 * exact class-validator decorators the global ValidationPipe applies.
 *
 * @see docs/reviews/claude/2026-07-20-admin-panel-e2e-audit/findings/users-roles.md#APA-050
 */
import { PLATFORM_ROLE_CODES, INVITABLE_ROLE_CODES } from '@platform/event-contracts';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  CreateUserDto,
  UpdateUserDto,
  ListUsersQueryDto,
  InviteUserRequestDto,
} from '../users.controller';

/** A canonical, otherwise-valid CreateUserDto payload with a variable role. */
const createBase = {
  email: 'user@example.com',
  firstName: 'Jane',
  lastName: 'Doe',
  password: 'Password1!',
  tenantId: '11111111-1111-4111-8111-111111111111',
};

/** A canonical, otherwise-valid InviteUserRequestDto payload with a variable role. */
const inviteBase = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  email: 'invitee@example.com',
};

/** Roles the DTOs must never accept — the retired phantom vocabulary. */
const PHANTOM_ROLES = ['MANAGER', 'OPERATOR', 'VIEWER'] as const;

async function roleErrors(dto: object): Promise<boolean> {
  const errors = await validate(dto);
  return errors.some((e) => e.property === 'role');
}

describe('APA-050: user-role DTOs are pinned to the canonical vocabulary', () => {
  describe('all four canonical roles validate on Create/Update/List DTOs', () => {
    it.each(PLATFORM_ROLE_CODES)('CreateUserDto accepts %s', async (role) => {
      const dto = plainToInstance(CreateUserDto, { ...createBase, role });
      expect(await roleErrors(dto)).toBe(false);
    });

    it.each(PLATFORM_ROLE_CODES)('UpdateUserDto accepts %s', async (role) => {
      const dto = plainToInstance(UpdateUserDto, { role });
      expect(await roleErrors(dto)).toBe(false);
    });

    it.each(PLATFORM_ROLE_CODES)('ListUsersQueryDto accepts %s', async (role) => {
      const dto = plainToInstance(ListUsersQueryDto, { role });
      expect(await roleErrors(dto)).toBe(false);
    });
  });

  describe('invite DTO accepts the invitable subset and rejects SUPER_ADMIN', () => {
    it.each(INVITABLE_ROLE_CODES)('InviteUserRequestDto accepts %s', async (role) => {
      const dto = plainToInstance(InviteUserRequestDto, { ...inviteBase, role });
      expect(await roleErrors(dto)).toBe(false);
    });

    it('InviteUserRequestDto rejects SUPER_ADMIN (platform-level, never invitable)', async () => {
      const dto = plainToInstance(InviteUserRequestDto, {
        ...inviteBase,
        role: 'SUPER_ADMIN',
      });
      expect(await roleErrors(dto)).toBe(true);
    });
  });

  describe('the retired phantom roles are rejected by every DTO', () => {
    it.each(PHANTOM_ROLES)('CreateUserDto rejects %s', async (role) => {
      const dto = plainToInstance(CreateUserDto, { ...createBase, role });
      expect(await roleErrors(dto)).toBe(true);
    });

    it.each(PHANTOM_ROLES)('UpdateUserDto rejects %s', async (role) => {
      const dto = plainToInstance(UpdateUserDto, { role });
      expect(await roleErrors(dto)).toBe(true);
    });

    it.each(PHANTOM_ROLES)('ListUsersQueryDto rejects %s', async (role) => {
      const dto = plainToInstance(ListUsersQueryDto, { role });
      expect(await roleErrors(dto)).toBe(true);
    });

    it.each(PHANTOM_ROLES)('InviteUserRequestDto rejects %s', async (role) => {
      const dto = plainToInstance(InviteUserRequestDto, { ...inviteBase, role });
      expect(await roleErrors(dto)).toBe(true);
    });
  });
});
