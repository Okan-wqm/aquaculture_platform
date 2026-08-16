import {
  INVITABLE_ROLE_CODES,
  PLATFORM_ROLE_CODES,
  PLATFORM_ROLE_DEFINITIONS,
  Role,
  isInvitableRole,
  isPlatformRole,
  type InvitableRoleCode,
} from '@platform/identity';

function roleOptions(codes: readonly Role[]): readonly { readonly value: Role; readonly label: string }[] {
  return Object.freeze(
    codes.map((role) =>
      Object.freeze({
        value: role,
        label: PLATFORM_ROLE_DEFINITIONS[role].name,
      }),
    ),
  );
}

export const ALL_ROLE_OPTIONS = roleOptions(PLATFORM_ROLE_CODES);
export const INVITABLE_ROLE_OPTIONS = roleOptions(INVITABLE_ROLE_CODES);

export function selectedPlatformRole(value: string): Role {
  return isPlatformRole(value) ? value : Role.MODULE_USER;
}

export function selectedInvitableRole(value: string): InvitableRoleCode {
  return isInvitableRole(value) ? value : Role.MODULE_USER;
}
