/**
 * One role vocabulary, from the enum outward (ADMIN-CRITICAL-133).
 *
 * The platform defines four roles in `Role`. Three places had each retyped
 * that list by hand and each had drifted to a DIFFERENT wrong set:
 *
 *   - `users.dto.ts` validated create, update, invite and the list filter
 *     against `['SUPER_ADMIN', 'TENANT_ADMIN', 'MANAGER', 'OPERATOR',
 *     'VIEWER']`. `MANAGER` and `VIEWER` are not roles; `MODULE_MANAGER` and
 *     `MODULE_USER` are, and were rejected. So creating a user at the New User
 *     form's default role, changing a user to a module role, inviting anyone
 *     below TENANT_ADMIN, and even FILTERING the list by a module role each
 *     returned 400.
 *   - the role-template catalogue published six templates, two of them
 *     (`SUPERVISOR`, `OPERATOR`) for roles the platform does not define — and
 *     the admin-panel's invite form renders whatever the catalogue returns, so
 *     both appeared as choices that could only fail.
 *   - the admin-panel's own fallback option list was a fourth copy.
 *
 * These tests hold the two directions that matter: every role the catalogue
 * publishes must be assignable, and every assignable role must be a role.
 */

import { INVITABLE_ROLES, PLATFORM_ROLES, Role } from '@aquaculture/backend-common/decorators';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { CreateUserDto, InviteUserRequestDto, UpdateUserDto } from '../dto/users.dto';
import { RoleTemplateService } from '../services/role-template.service';

const VALID_PASSWORD = 'Str0ng!Passw0rd';

async function roleErrors(dto: object): Promise<string[]> {
  const errors = await validate(dto);
  return errors.filter((error) => error.property === 'role').map((error) => error.property);
}

describe('the platform role vocabulary has one source', () => {
  it('derives the value lists from the enum rather than repeating it', () => {
    expect([...PLATFORM_ROLES].sort()).toEqual([...Object.values(Role)].sort());
    expect(PLATFORM_ROLES).toContain(Role.SUPER_ADMIN);
    expect(INVITABLE_ROLES).not.toContain(Role.SUPER_ADMIN);
    expect([...INVITABLE_ROLES].sort()).toEqual(
      [...Object.values(Role)].filter((role) => role !== Role.SUPER_ADMIN).sort(),
    );
  });

  it('publishes exactly one role template per platform role', () => {
    const codes = new RoleTemplateService().getAllRoleTemplates().map((template) => template.code);

    // The regression: SUPERVISOR and OPERATOR were offered here and accepted
    // nowhere.
    expect([...codes].sort()).toEqual([...PLATFORM_ROLES].sort());
    expect(codes).toHaveLength(new Set(codes).size);
  });
});

describe('every platform role survives the user write DTOs', () => {
  it.each([...PLATFORM_ROLES])('accepts %s on create', async (role) => {
    const dto = plainToInstance(CreateUserDto, {
      email: 'someone@example.com',
      firstName: 'Some',
      lastName: 'One',
      password: VALID_PASSWORD,
      role,
    });

    await expect(roleErrors(dto)).resolves.toEqual([]);
  });

  it.each([...PLATFORM_ROLES])('accepts %s on update', async (role) => {
    await expect(roleErrors(plainToInstance(UpdateUserDto, { role }))).resolves.toEqual([]);
  });

  it.each([...INVITABLE_ROLES])('accepts %s on invite', async (role) => {
    const dto = plainToInstance(InviteUserRequestDto, {
      email: 'someone@example.com',
      role,
    });

    await expect(roleErrors(dto)).resolves.toEqual([]);
  });

  it('refuses to invite a platform administrator', async () => {
    const dto = plainToInstance(InviteUserRequestDto, {
      email: 'someone@example.com',
      role: Role.SUPER_ADMIN,
    });

    await expect(roleErrors(dto)).resolves.toEqual(['role']);
  });

  it.each(['MANAGER', 'OPERATOR', 'VIEWER', 'SUPERVISOR'])(
    'refuses the legacy code %s, which no guard or hierarchy recognises',
    async (role) => {
      await expect(roleErrors(plainToInstance(UpdateUserDto, { role }))).resolves.toEqual(['role']);
    },
  );
});
