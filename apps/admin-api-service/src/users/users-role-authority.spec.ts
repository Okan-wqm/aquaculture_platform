import { PLATFORM_ROLE_CODES, Role } from '@platform/identity';
import { TENANT_PERMISSION_CODES } from '@platform/tenant-permissions';
import { validate } from 'class-validator';

import { RoleTemplateService } from './services/role-template.service';
import { CreateUserDto, InviteUserRequestDto } from './users.controller';

function createUserDto(role: unknown): CreateUserDto {
  const dto = new CreateUserDto();
  dto.email = 'admin@example.com';
  dto.firstName = 'Admin';
  dto.lastName = 'User';
  dto.password = 'Strong1!Password';
  Reflect.set(dto, 'role', role);
  return dto;
}

function invitationDto(role: unknown): InviteUserRequestDto {
  const dto = new InviteUserRequestDto();
  dto.tenantId = '8f8eb7fe-9042-4eca-91e5-c3523f4fd42e';
  dto.email = 'invitee@example.com';
  Reflect.set(dto, 'role', role);
  return dto;
}

describe('admin user role DTO authority', () => {
  it.each(PLATFORM_ROLE_CODES)('accepts canonical create-user role %s', async (role) => {
    const errors = await validate(createUserDto(role));
    expect(errors.filter((error) => error.property === 'role')).toEqual([]);
  });

  it.each(['VIEWER', 'OPERATOR', 'MANAGER'])('rejects legacy create-user role %s', async (role) => {
    const errors = await validate(createUserDto(role));
    expect(errors.some((error) => error.property === 'role')).toBe(true);
  });

  it('keeps invitation policy on the canonical non-super-admin subset', async () => {
    for (const role of [Role.TENANT_ADMIN, Role.MODULE_MANAGER, Role.MODULE_USER]) {
      expect(
        (await validate(invitationDto(role))).filter((error) => error.property === 'role'),
      ).toEqual([]);
    }
    expect(
      (await validate(invitationDto(Role.SUPER_ADMIN))).some((error) => error.property === 'role'),
    ).toBe(true);
  });
});

describe('admin role template projection', () => {
  const service = new RoleTemplateService();

  it('projects exactly four canonical immutable templates', () => {
    const templates = service.getAllRoleTemplates();
    expect(templates.map((template) => template.code)).toEqual(PLATFORM_ROLE_CODES);
    expect(Object.isFrozen(templates)).toBe(true);
    expect(templates.every(Object.isFrozen)).toBe(true);
    const firstTemplate = templates[0];
    expect(firstTemplate).toBeDefined();
    if (!firstTemplate) throw new TypeError('canonical role projection must be non-empty');
    expect(Reflect.set(firstTemplate, 'name', 'mutated')).toBe(false);
  });

  it('reports all-mode and assigned-mode permission counts without fabricated grants', () => {
    const hierarchy = service.getRoleHierarchy();
    expect(hierarchy.map((role) => role.code)).toEqual([
      Role.SUPER_ADMIN,
      Role.TENANT_ADMIN,
      Role.MODULE_MANAGER,
      Role.MODULE_USER,
    ]);
    expect(service.getRolePermissions(Role.SUPER_ADMIN)).toEqual(TENANT_PERMISSION_CODES);
    expect(service.getRolePermissions(Role.TENANT_ADMIN)).toEqual(TENANT_PERMISSION_CODES);
    expect(service.getRolePermissions(Role.MODULE_MANAGER)).toEqual([]);
    expect(service.getRolePermissions(Role.MODULE_USER)).toEqual([]);
    expect(hierarchy.find((role) => role.code === Role.SUPER_ADMIN)?.permissionCount).toBe(
      TENANT_PERMISSION_CODES.length,
    );
    expect(hierarchy.find((role) => role.code === Role.MODULE_USER)?.permissionCount).toBe(0);
    expect(Object.isFrozen(hierarchy)).toBe(true);
    expect(hierarchy.every(Object.isFrozen)).toBe(true);
  });
});
