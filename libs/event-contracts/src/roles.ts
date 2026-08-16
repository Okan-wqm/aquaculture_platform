/**
 * Browser-safe role identity authority shared by token issuers, guards,
 * admin contracts, and federated clients.
 */
export const Role = Object.freeze({
  SUPER_ADMIN: 'SUPER_ADMIN',
  TENANT_ADMIN: 'TENANT_ADMIN',
  MODULE_MANAGER: 'MODULE_MANAGER',
  MODULE_USER: 'MODULE_USER',
} as const);

export type Role = (typeof Role)[keyof typeof Role];
export type PlatformRoleCode = Role;

export interface ActiveRoleVocabularyV1<TCode extends string> {
  readonly schemaVersion: 'role-vocabulary.v1';
  readonly vocabularyId: string;
  readonly domain: string;
  readonly lifecycle: 'ACTIVE';
  readonly codes: readonly TCode[];
}

export interface RetiredRoleVocabularyV1<TCode extends string> {
  readonly schemaVersion: 'role-vocabulary.v1';
  readonly vocabularyId: string;
  readonly domain: string;
  readonly lifecycle: 'RETIRED';
  readonly codes: readonly TCode[];
  readonly successorVocabularyId: string;
  readonly retirementPolicy: 'REJECT_AT_TRUST_BOUNDARY';
}

export type RoleVocabularyV1<TCode extends string = string> =
  | ActiveRoleVocabularyV1<TCode>
  | RetiredRoleVocabularyV1<TCode>;

function defineRoleVocabularyV1<const TCode extends string>(
  definition: RoleVocabularyV1<TCode>,
): Readonly<RoleVocabularyV1<TCode>> {
  if (definition.codes.length === 0 || new Set(definition.codes).size !== definition.codes.length) {
    throw new TypeError(`Role vocabulary ${definition.vocabularyId} must contain unique codes`);
  }
  return Object.freeze({ ...definition, codes: Object.freeze([...definition.codes]) });
}

/** Values are derived from the enum-like identity object; there is no second code list. */
export const PLATFORM_ROLE_CODES = Object.freeze(Object.values(Role));

export const PLATFORM_ROLE_VOCABULARY = defineRoleVocabularyV1({
  schemaVersion: 'role-vocabulary.v1',
  vocabularyId: 'platform-role/v1',
  domain: 'platform-authorization',
  lifecycle: 'ACTIVE',
  codes: PLATFORM_ROLE_CODES,
});

export const INVITABLE_ROLE_CODES = Object.freeze([
  Role.TENANT_ADMIN,
  Role.MODULE_MANAGER,
  Role.MODULE_USER,
] as const);

export type InvitableRoleCode = (typeof INVITABLE_ROLE_CODES)[number];

/**
 * Pre-v1 AquaMobil tokens used a different role vocabulary. That vocabulary is
 * explicitly retired, not silently translated: a trust boundary that sees one
 * of these values must fail to the minimum canonical privilege.
 */
export const RETIRED_AQUAMOBIL_ROLE_CODES = Object.freeze([
  'MANAGER',
  'OPERATOR',
  'VIEWER',
] as const);

export type RetiredAquamobilRoleCode = (typeof RETIRED_AQUAMOBIL_ROLE_CODES)[number];

export const RETIRED_AQUAMOBIL_ROLE_VOCABULARY = defineRoleVocabularyV1({
  schemaVersion: 'role-vocabulary.v1',
  vocabularyId: 'aquamobil-token-role/v0',
  domain: 'platform-authorization',
  lifecycle: 'RETIRED',
  codes: RETIRED_AQUAMOBIL_ROLE_CODES,
  successorVocabularyId: PLATFORM_ROLE_VOCABULARY.vocabularyId,
  retirementPolicy: 'REJECT_AT_TRUST_BOUNDARY',
});

/** SCADA operator authority is a separate bounded vocabulary, never a platform role alias. */
export const HmiRole = Object.freeze({
  VIEWER: 'viewer',
  OPERATOR: 'operator',
  ENGINEER: 'engineer',
  SUPERVISOR: 'supervisor',
  ADMIN: 'admin',
} as const);

export type HmiRole = (typeof HmiRole)[keyof typeof HmiRole];

export const HMI_ROLE_CODES = Object.freeze(Object.values(HmiRole));

export const HMI_ROLE_VOCABULARY = defineRoleVocabularyV1({
  schemaVersion: 'role-vocabulary.v1',
  vocabularyId: 'scada-hmi-role/v1',
  domain: 'scada-operator',
  lifecycle: 'ACTIVE',
  codes: HMI_ROLE_CODES,
});

export const HMI_ROLE_LEVELS: Readonly<Record<HmiRole, number>> = Object.freeze({
  [HmiRole.VIEWER]: 0,
  [HmiRole.OPERATOR]: 1,
  [HmiRole.ENGINEER]: 2,
  [HmiRole.SUPERVISOR]: 3,
  [HmiRole.ADMIN]: 4,
});

export const HMI_WRITE_ROLE_CODES = Object.freeze(
  HMI_ROLE_CODES.filter((role) => HMI_ROLE_LEVELS[role] >= HMI_ROLE_LEVELS[HmiRole.OPERATOR]),
);

export const ROLE_VOCABULARY_REGISTRY = Object.freeze({
  [PLATFORM_ROLE_VOCABULARY.vocabularyId]: PLATFORM_ROLE_VOCABULARY,
  [RETIRED_AQUAMOBIL_ROLE_VOCABULARY.vocabularyId]: RETIRED_AQUAMOBIL_ROLE_VOCABULARY,
  [HMI_ROLE_VOCABULARY.vocabularyId]: HMI_ROLE_VOCABULARY,
});

export type PlatformPermissionMode = 'all' | 'assigned';

export interface PlatformRoleDefinition {
  readonly code: Role;
  readonly name: string;
  readonly description: string;
  readonly level: number;
  readonly permissionMode: PlatformPermissionMode;
  readonly color: string;
  readonly icon: string;
}

/**
 * Role presentation and hierarchy are attributes of role identity. Keeping
 * them here prevents API and browser catalogues from inventing parallel ranks.
 */
export const PLATFORM_ROLE_DEFINITIONS: Readonly<Record<Role, PlatformRoleDefinition>> =
  Object.freeze({
    [Role.SUPER_ADMIN]: Object.freeze({
      code: Role.SUPER_ADMIN,
      name: 'Super Admin',
      description: 'Platform-wide administrator with full system access',
      level: 100,
      permissionMode: 'all',
      color: '#DC2626',
      icon: 'shield-check',
    }),
    [Role.TENANT_ADMIN]: Object.freeze({
      code: Role.TENANT_ADMIN,
      name: 'Tenant Admin',
      description: 'Tenant administrator with full tenant access',
      level: 90,
      permissionMode: 'all',
      color: '#7C3AED',
      icon: 'user-cog',
    }),
    [Role.MODULE_MANAGER]: Object.freeze({
      code: Role.MODULE_MANAGER,
      name: 'Module Manager',
      description: 'Manager whose capabilities come from tenant role assignments',
      level: 70,
      permissionMode: 'assigned',
      color: '#059669',
      icon: 'briefcase',
    }),
    [Role.MODULE_USER]: Object.freeze({
      code: Role.MODULE_USER,
      name: 'Module User',
      description: 'Member whose capabilities come from tenant role assignments',
      level: 10,
      permissionMode: 'assigned',
      color: '#4B5563',
      icon: 'user',
    }),
  });

function inheritedRoles(role: Role): readonly Role[] {
  const level = PLATFORM_ROLE_DEFINITIONS[role].level;
  return Object.freeze(
    PLATFORM_ROLE_CODES.filter(
      (candidate) => PLATFORM_ROLE_DEFINITIONS[candidate].level < level,
    ),
  );
}

/**
 * Canonical hierarchy projection for guards that need role inheritance.
 * A consumer must never infer privilege from enum declaration or array order.
 */
export const PLATFORM_ROLE_HIERARCHY: Readonly<Record<Role, readonly Role[]>> = Object.freeze({
  [Role.SUPER_ADMIN]: inheritedRoles(Role.SUPER_ADMIN),
  [Role.TENANT_ADMIN]: inheritedRoles(Role.TENANT_ADMIN),
  [Role.MODULE_MANAGER]: inheritedRoles(Role.MODULE_MANAGER),
  [Role.MODULE_USER]: inheritedRoles(Role.MODULE_USER),
});

export function roleAtLeast(userRole: Role, requiredRole: Role): boolean {
  return PLATFORM_ROLE_DEFINITIONS[userRole].level >= PLATFORM_ROLE_DEFINITIONS[requiredRole].level;
}

export function roleHasAllPermissions(role: Role): boolean {
  return PLATFORM_ROLE_DEFINITIONS[role].permissionMode === 'all';
}

const ALL_PERMISSIONS = Object.freeze(['*'] as const);
const ASSIGNED_PERMISSIONS = Object.freeze([] as const);

/**
 * Implicit permissions are derived from role semantics. Assigned-mode roles
 * receive only the capabilities present in their token; all-mode roles receive
 * the wildcard. This replaces per-service default-permission tables.
 */
export function implicitPermissionsForRole(value: unknown): readonly string[] {
  if (!isPlatformRole(value)) return ASSIGNED_PERMISSIONS;
  return roleHasAllPermissions(value) ? ALL_PERMISSIONS : ASSIGNED_PERMISSIONS;
}

export function isPlatformRole(value: unknown): value is Role {
  return typeof value === 'string' && PLATFORM_ROLE_CODES.some((role) => role === value);
}

export function isInvitableRole(value: unknown): value is InvitableRoleCode {
  return typeof value === 'string' && INVITABLE_ROLE_CODES.some((role) => role === value);
}

export function isRetiredAquamobilRole(value: unknown): value is RetiredAquamobilRoleCode {
  return (
    typeof value === 'string' && RETIRED_AQUAMOBIL_ROLE_CODES.some((role) => role === value)
  );
}

export function isHmiRole(value: unknown): value is HmiRole {
  return typeof value === 'string' && HMI_ROLE_CODES.some((role) => role === value);
}

export function hmiRoleAtLeast(userRole: HmiRole, requiredRole: HmiRole): boolean {
  return HMI_ROLE_LEVELS[userRole] >= HMI_ROLE_LEVELS[requiredRole];
}
