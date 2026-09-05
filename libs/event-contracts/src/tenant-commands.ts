/**
 * Tenant Provisioning NATS Command Contracts
 *
 * Request-reply commands used by admin-api-service to delegate cross-schema
 * writes to the auth-service (or whichever service owns the auth.* tables).
 *
 * Pattern: admin-api publishes a command on a NATS request subject and waits
 * for a typed result. This eliminates direct SQL writes from admin-api into
 * auth-schema tables, enforcing single-writer ownership.
 *
 * Subject convention: request.auth.tenant.<CommandType>
 */

import type { PlatformCapability } from './enums/platform-capability.enum';

// ==================== NATS Subject Constants ====================

export const TENANT_COMMAND_SUBJECTS = {
  RESERVE_TENANT: 'request.auth.tenant.ReserveTenant',
  SETUP_TENANT_ROLES: 'request.auth.tenant.SetupRoles',
  ASSIGN_TENANT_MODULES: 'request.auth.tenant.AssignModules',
  CREATE_FIRST_ADMIN_INVITE: 'request.auth.tenant.CreateFirstAdminInvite',
  BEGIN_PROVISIONING: 'request.auth.tenant.BeginProvisioning',
  ACTIVATE_TENANT: 'request.auth.tenant.ActivateTenant',
  FAIL_PROVISIONING: 'request.auth.tenant.FailProvisioning',
  DEPROVISION_TENANT: 'request.auth.tenant.DeprovisionTenant',
  SUSPEND_TENANT: 'request.auth.tenant.SuspendTenant',
  ARCHIVE_TENANT: 'request.auth.tenant.ArchiveTenant',
  REMOVE_TENANT_MODULE: 'request.auth.tenant.RemoveModule',
  ROLLBACK_TENANT_PROVISIONING: 'request.auth.tenant.RollbackProvisioning',
} as const;

export interface AuthTenantCommandActor {
  id: string;
  type?: 'user' | 'service' | 'system';
  email?: string;
}

export interface AuthTenantCommandMetadata {
  /** Durable provisioning/lifecycle operation id owned by the orchestrator. */
  operationId: string;
  /** Tenant aggregate id. Admin may generate the UUID; auth-service owns the row write. */
  tenantId: string;
  /** Actor that requested the lifecycle mutation. */
  actor: AuthTenantCommandActor;
  /** Optional caller/audit reference. Auth-service derives receipt identity itself. */
  requestReference?: string;
  /** Safe audit metadata. Must not contain raw tokens or secrets. */
  auditMetadata?: Record<string, unknown>;
}

export interface AuthTenantCommandResult {
  success: boolean;
  operationId?: string;
  tenantId?: string;
  status?: string;
  error?: string;
}

export interface AuthTenantSnapshot {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  customDomain?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  settings?: Record<string, unknown> | null;
  createdAt?: string;
  updatedAt?: string;
}

// ==================== ReserveTenant ====================

export interface ReserveTenantCommand extends AuthTenantCommandMetadata {
  name: string;
  slug: string;
  description?: string;
  customDomain?: string;
  contactEmail?: string;
  contactPhone?: string;
  plan: string;
  maxUsers?: number;
  maxStorage?: number;
  // MT-MEDIUM-001: trial state is derived from trialEndsAt (the SSoT). The
  // redundant isTrialActive input was removed — a tenant is on trial iff
  // trialEndsAt is set and in the future.
  trialEndsAt?: string;
  settings?: Record<string, unknown>;
  createdBy: string;
}

export interface ReserveTenantResult extends AuthTenantCommandResult {
  tenant?: AuthTenantSnapshot;
}

// ==================== CreateTenantAdmin ====================

/**
 * Command to create the first admin user for a newly provisioned tenant.
 * Sent via NATS request-reply to the auth-service which owns auth.users
 * and auth.invitations tables.
 */
export interface CreateTenantAdminCommand extends AuthTenantCommandMetadata {
  /** Admin user email */
  email: string;
  /** Admin first name */
  firstName: string;
  /** Admin last name */
  lastName: string;
  /** User/service actor that initiated provisioning */
  invitedBy?: string;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
}

/**
 * Result returned by the auth-service after processing CreateTenantAdminCommand.
 * The invitationToken is intentionally omitted -- it must only travel via email
 * to prevent token leakage through API responses or logs.
 */
export interface CreateTenantAdminResult {
  success: boolean;
  operationId?: string;
  tenantId?: string;
  /** UUID of the created user (only present on success) */
  userId?: string;
  /** UUID of the canonical auth.invitations row (only present on success) */
  invitationId?: string;
  /** Admin email echoed back for confirmation */
  email?: string;
  /** Error message (only present on failure) */
  error?: string;
}

// ==================== SetupTenantRoles ====================

/**
 * Command to create default roles (e.g., TENANT_ADMIN) for a tenant.
 * Sent via NATS request-reply to the auth-service which owns auth.tenant_roles.
 */
export interface SetupTenantRolesCommand extends AuthTenantCommandMetadata {
  /** Roles to create. If omitted, the handler creates the default set. */
  roles?: Array<{
    code: string;
    name: string;
    description: string;
    permissions: string[];
    isDefault: boolean;
    isEditable: boolean;
    displayOrder: number;
  }>;
  /** User/service actor that initiated provisioning */
  createdBy?: string;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
}

/**
 * Result returned by the auth-service after processing SetupTenantRolesCommand.
 */
export interface SetupTenantRolesResult {
  success: boolean;
  operationId?: string;
  tenantId?: string;
  /** Number of roles created */
  rolesCreated?: number;
  /** Error message (only present on failure) */
  error?: string;
}

// ==================== AssignTenantModules ====================

/**
 * Command to assign modules to a tenant in auth.tenant_modules.
 * Sent via NATS request-reply to the auth-service which owns the table.
 */
export interface AssignTenantModulesCommand extends AuthTenantCommandMetadata {
  /** Module UUIDs to assign */
  moduleIds: string[];
  /** Optional per-module configuration used by provisioning/pricing flows */
  modules?: Array<{
    moduleId: string;
    quantities?: Record<string, number | undefined>;
    configuration?: Record<string, unknown>;
    expiresAt?: string;
  }>;
  /** User/service actor that initiated provisioning */
  assignedBy?: string;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
}

/**
 * Result returned by the auth-service after processing AssignTenantModulesCommand.
 */
export interface AssignTenantModulesResult {
  success: boolean;
  operationId?: string;
  tenantId?: string;
  /** Number of modules actually assigned (excludes duplicates) */
  modulesAssigned?: number;
  /** Error message (only present on failure) */
  error?: string;
}

// ==================== RemoveTenantModule ====================

/**
 * Command to disable a tenant module assignment.
 * Sent via NATS request-reply to the auth-service which owns auth.tenant_modules.
 */
export interface RemoveTenantModuleCommand extends AuthTenantCommandMetadata {
  /** Module UUID to disable */
  moduleId: string;
  /** User/service actor that initiated the removal */
  removedBy?: string;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
}

export interface RemoveTenantModuleResult {
  success: boolean;
  operationId?: string;
  tenantId?: string;
  /** Number of rows disabled */
  modulesRemoved?: number;
  /** Error message (only present on failure) */
  error?: string;
}

// ==================== RollbackTenantProvisioning ====================

/**
 * Command to roll back a partially-provisioned tenant.
 * The auth-service should:
 *   1. Delete the admin user (if created)
 *   2. Delete tenant roles
 *   3. Remove module assignments
 *   4. Optionally reset tenant status back to PENDING
 *
 * This is a best-effort compensating action; the handler should log
 * failures but not throw, since we are already in an error path.
 */
export interface RollbackTenantProvisioningCommand extends AuthTenantCommandMetadata {
  /** Which provisioning steps completed and need rollback */
  completedSteps: Array<
    'create_admin' | 'setup_roles' | 'assign_modules' | 'activate_tenant'
  >;
  /** Reason for rollback (for audit logging) */
  reason: string;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
}

export interface RollbackTenantProvisioningResult {
  success: boolean;
  operationId?: string;
  tenantId?: string;
  removedUsers?: number;
  removedInvitations?: number;
  removedRoles?: number;
  removedModules?: number;
  error?: string;
}

// ==================== Tenant lifecycle status commands ====================

/**
 * Marks a reserved (PENDING) tenant as PROVISIONING — the saga's first
 * lifecycle action, issued after ReserveTenant and before the provisioning
 * work steps. Makes the in-flight provisioning phase a real, observable status
 * (PENDING → PROVISIONING → ACTIVE) so the canonical TenantStatusMachine is the
 * truthful single authority over the lifecycle, with no PENDING→ACTIVE skip.
 */
export type BeginProvisioningCommand = AuthTenantCommandMetadata;

export type ActivateTenantCommand = AuthTenantCommandMetadata;

export interface FailProvisioningCommand extends AuthTenantCommandMetadata {
  reason: string;
}

export interface SuspendTenantLifecycleCommand extends AuthTenantCommandMetadata {
  reason: string;
}

export interface DeprovisionTenantCommand extends AuthTenantCommandMetadata {
  reason: string;
}

export interface ArchiveTenantLifecycleCommand extends AuthTenantCommandMetadata {
  reason?: string;
}

// ==================== Admin User Lifecycle (SUPER_ADMIN ops) ====================

/**
 * NATS subject constants for admin-api → auth-service user lifecycle
 * commands. Consumed by AuthAdminNatsHandler on auth-service.
 *
 * Architectural rule enforced by these contracts:
 *   admin-api-service MUST NOT write to auth.* tables directly.
 *   All writes are delegated to auth-service which owns the schema.
 *   The request/response shapes flow through the TypeORM User entity
 *   on auth-service, so schema drift between the JSON payload and the
 *   actual column names is structurally impossible — the entity is the
 *   single writer and the column name is defined once on the entity.
 */
export const AUTH_ADMIN_COMMAND_SUBJECTS = {
  CREATE_USER: 'request.auth.admin.createUser',
  RESET_USER_PASSWORD: 'request.auth.admin.resetUserPassword',
  UPDATE_USER: 'request.auth.admin.updateUser',
  DEACTIVATE_USER: 'request.auth.admin.deactivateUser',
  FORCE_LOGOUT_USER: 'request.auth.admin.forceLogoutUser',
  INVITE_USER: 'request.auth.admin.inviteUser',
  CHECK_USER_LIMIT: 'request.auth.admin.checkUserLimit',
  CREATE_MODULE: 'request.auth.admin.createModule',
  UPDATE_MODULE: 'request.auth.admin.updateModule',
  DELETE_MODULE: 'request.auth.admin.deleteModule',
  // ADR-0016: platform capabilities are auth.platform_capability_grants rows;
  // admin-api grants and revokes them here and reads them back for the panel.
  GRANT_PLATFORM_CAPABILITY: 'request.auth.admin.grantPlatformCapability',
  REVOKE_PLATFORM_CAPABILITY: 'request.auth.admin.revokePlatformCapability',
  LIST_PLATFORM_CAPABILITY_GRANTS: 'request.auth.admin.listPlatformCapabilityGrants',
} as const;

export const AUTH_PUBLIC_COMMAND_SUBJECTS = {
  REQUEST_PASSWORD_RESET: 'request.auth.public.requestPasswordReset',
  RESET_PASSWORD: 'request.auth.public.resetPassword',
} as const;

/**
 * Command to create a user by a SUPER_ADMIN operator.
 *
 * Sent via NATS request-reply to the auth-service which owns auth.users.
 * The auth-service writes through the User TypeORM entity — the entity's
 * @BeforeInsert hook applies HMAC-peppered bcrypt to the password, so the
 * caller MUST NOT pre-hash.
 *
 * Unlike the tenant-scoped CreateTenantAdminCommand (first-admin bootstrap
 * flow), this command is used by platform operators to create users at
 * arbitrary roles, for any tenant, without sending an invitation.
 */
export interface AdminCreateUserCommand {
  /** User email — unique, lowercased by handler */
  email: string;
  /** Given name */
  firstName: string;
  /** Family name */
  lastName: string;
  /**
   * Plaintext password — the auth-service User entity's @BeforeInsert
   * hook applies the platform's HMAC-peppered bcrypt. The admin MUST NOT
   * pre-hash. Plaintext never touches a log line (SENSITIVE_FIELDS mask).
   */
  password: string;
  /** Platform role (SUPER_ADMIN / TENANT_ADMIN / MODULE_MANAGER / MODULE_USER) */
  role: string;
  /** Tenant UUID — NULL for SUPER_ADMIN users */
  tenantId?: string | null;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
}

/**
 * Result returned by the auth-service after processing AdminCreateUserCommand.
 * Shape mirrors the fields admin-api surfaces via its REST UserDto — no
 * sensitive fields (password hash, reset tokens, MFA secrets) are returned.
 */
export interface AdminCreateUserResult {
  success: boolean;
  user?: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    role: string;
    tenantId: string | null;
    isActive: boolean;
    createdAt: string;
  };
  /** Error code from a fixed vocabulary so callers can map to HTTP status */
  errorCode?:
    | 'DUPLICATE_EMAIL'
    | 'TENANT_NOT_FOUND'
    | 'INVALID_ROLE'
    | 'VALIDATION_ERROR'
    | 'INTERNAL_ERROR';
  /** Human-readable error detail (safe for logs — no PII) */
  error?: string;
}

/**
 * Command to reset a user's password by SUPER_ADMIN operator (out-of-band).
 *
 * Sent via NATS request-reply to the auth-service. The entity's
 * @BeforeUpdate hook applies the platform's HMAC-peppered bcrypt; caller
 * MUST NOT pre-hash. On successful reset, auth-service revokes ALL refresh
 * tokens for the user — the admin's reset is a security event that forces
 * full re-authentication on every device.
 */
export interface AdminResetUserPasswordCommand {
  /** Target user UUID */
  userId: string;
  /**
   * Plaintext new password — auth-service applies the password hash. The
   * admin MUST NOT pre-hash. Plaintext never touches a log line.
   */
  newPassword: string;
  /** UUID of the SUPER_ADMIN performing the reset (for audit) */
  performedBy: string;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
}

/**
 * Result returned by the auth-service after processing
 * AdminResetUserPasswordCommand.
 */
export interface AdminResetUserPasswordResult {
  success: boolean;
  /** Echoed user id for confirmation */
  userId?: string;
  /** Number of refresh tokens revoked as a side-effect of the reset */
  refreshTokensRevoked?: number;
  errorCode?: 'USER_NOT_FOUND' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR';
  error?: string;
}

export interface PublicRequestPasswordResetCommand {
  email: string;
  ipAddress?: string;
  correlationId?: string;
}

export interface PublicRequestPasswordResetResult {
  success: boolean;
  errorCode?: 'VALIDATION_ERROR' | 'INTERNAL_ERROR';
  error?: string;
}

export interface PublicResetPasswordCommand {
  token: string;
  newPassword: string;
  ipAddress?: string;
  userAgent?: string;
  correlationId?: string;
}

export interface PublicResetPasswordResult {
  success: boolean;
  errorCode?: 'INVALID_OR_EXPIRED_TOKEN' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR';
  error?: string;
}

/**
 * Snapshot of an auth.modules catalogue row.
 *
 * WHY no price field: billing owns all subscription pricing (platform rule
 * D14). Per-module prices live in the module-pricing catalog
 * (admin.module_pricing, managed by admin-api's ModulePricingService) and
 * plan/subscription pricing lives in billing.plans / billing.subscriptions.
 * auth.modules carries catalogue metadata only (code/name/description/
 * enablement). isCore stays: it is catalogue metadata ("included in every
 * plan"), not a price input.
 */
export interface AuthModuleSnapshot {
  id: string;
  code: string;
  name: string;
  description: string | null;
  defaultRoute: string;
  icon: string | null;
  isCore: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AdminCreateModuleCommand {
  code: string;
  name: string;
  description?: string | null;
  defaultRoute: string;
  icon?: string | null;
  isCore?: boolean;
  correlationId?: string;
}

export interface AdminCreateModuleResult {
  success: boolean;
  module?: AuthModuleSnapshot;
  errorCode?: 'DUPLICATE_MODULE' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR';
  error?: string;
}

export interface AdminUpdateModuleCommand {
  moduleId: string;
  name?: string;
  description?: string | null;
  defaultRoute?: string;
  icon?: string | null;
  isActive?: boolean;
  correlationId?: string;
}

export interface AdminUpdateModuleResult {
  success: boolean;
  module?: AuthModuleSnapshot;
  errorCode?: 'MODULE_NOT_FOUND' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR';
  error?: string;
}

export interface AdminDeleteModuleCommand {
  moduleId: string;
  correlationId?: string;
}

export interface AdminDeleteModuleResult {
  success: boolean;
  moduleId?: string;
  errorCode?: 'MODULE_NOT_FOUND' | 'MODULE_ASSIGNED' | 'INTERNAL_ERROR';
  error?: string;
}

// ==================== Type Union ====================

/**
 * Union type for all tenant provisioning commands
 */
export type TenantProvisioningCommand =
  | ReserveTenantCommand
  | CreateTenantAdminCommand
  | SetupTenantRolesCommand
  | AssignTenantModulesCommand
  | ActivateTenantCommand
  | FailProvisioningCommand
  | SuspendTenantLifecycleCommand
  | DeprovisionTenantCommand
  | ArchiveTenantLifecycleCommand
  | RemoveTenantModuleCommand
  | RollbackTenantProvisioningCommand;

/**
 * Command to update mutable fields of a user by a SUPER_ADMIN operator.
 *
 * Sent via NATS request-reply to the auth-service. Written through the
 * TypeORM `User` entity — the `password` column is explicitly NOT patchable
 * via this command (password changes use `AdminResetUserPasswordCommand`
 * which applies bcrypt via @BeforeUpdate). All fields are optional; only
 * fields present in the payload are modified. `null` for `tenantId` is
 * meaningful (promotes the user to a platform-level SUPER_ADMIN) and is
 * distinct from omitting the field.
 *
 * CRITICAL-002 in `docs/reviews/code-reviewer/2026-04-21-raw-sql-audit.md`:
 * this contract replaces admin-api's raw SQL `UPDATE auth.users SET ...`
 * which would silently drift the next time a column renamed on the entity.
 */
export interface AdminUpdateUserCommand {
  /** Target user UUID */
  userId: string;
  /** Given name — set to patch, undefined to leave unchanged */
  firstName?: string;
  /** Family name — set to patch, undefined to leave unchanged */
  lastName?: string;
  /** Platform role (SUPER_ADMIN / TENANT_ADMIN / MODULE_MANAGER / MODULE_USER) */
  role?: string;
  /**
   * Tenant UUID or null. `undefined` leaves the current value; `null`
   * is an explicit assignment (user becomes tenantless, typical for
   * promoting to SUPER_ADMIN).
   */
  tenantId?: string | null;
  /** Active flag */
  isActive?: boolean;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
}

/**
 * Result of `AdminUpdateUserCommand`.
 *
 * Returns the full user shape so admin-api's REST DTO (`UserDto`) can be
 * assembled without a follow-up read. The `tenantName` join is performed
 * READ-SIDE on admin-api (it's a local read, not a cross-service write).
 */
export interface AdminUpdateUserResult {
  success: boolean;
  user?: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
    role: string;
    tenantId: string | null;
    isActive: boolean;
    lastLoginAt: string | null;
    createdAt: string;
    updatedAt: string;
  };
  errorCode?:
    | 'USER_NOT_FOUND'
    | 'TENANT_NOT_FOUND'
    | 'INVALID_ROLE'
    | 'VALIDATION_ERROR'
    | 'INTERNAL_ERROR';
  error?: string;
}

/**
 * Command to deactivate (soft-delete) a user by a SUPER_ADMIN operator.
 *
 * Sent via NATS request-reply. Semantics:
 *  - Sets `isActive = false` on the User record.
 *  - Deletes ALL refresh tokens for the user (hard delete — matches the
 *    pre-existing admin-api DELETE semantics; prevents any session from
 *    continuing). Refresh-token records are not retained for audit on
 *    this path because the audit log captures the deactivation event
 *    separately.
 *
 * This command is platform-scoped (no tenant required, valid for
 * SUPER_ADMIN users too). The tenant-scoped
 * `UserLifecycleService.deleteUser(tenantId, userId, deletedBy)` remains
 * the path for tenant-admin deletions and applies stricter guards
 * (prevents deleting another TENANT_ADMIN, prevents self-deletion).
 */
export interface AdminDeactivateUserCommand {
  /** Target user UUID */
  userId: string;
  /** UUID of the SUPER_ADMIN performing the deactivation (for audit) */
  performedBy?: string;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
}

export interface AdminDeactivateUserResult {
  success: boolean;
  /** Echoed user id */
  userId?: string;
  /** Number of refresh tokens removed as a side-effect */
  refreshTokensRemoved?: number;
  errorCode?: 'USER_NOT_FOUND' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR';
  error?: string;
}

/**
 * Command to forcibly log a user out of every session without otherwise
 * altering their account. Equivalent to deleting every outstanding
 * refresh token for the user. The user remains `isActive = true` and
 * can re-authenticate immediately.
 *
 * Used by the admin-panel "Force Logout" action, typically after a
 * suspected credential leak where the operator wants to invalidate
 * sessions but keep the account usable.
 */
export interface AdminForceLogoutUserCommand {
  /** Target user UUID */
  userId: string;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
}

export interface AdminForceLogoutUserResult {
  success: boolean;
  userId?: string;
  /** Number of sessions invalidated */
  sessionsInvalidated?: number;
  errorCode?: 'USER_NOT_FOUND' | 'INTERNAL_ERROR';
  error?: string;
}

/**
 * Command to invite a user to a tenant (tenant-admin-initiated flow).
 *
 * Unlike `AdminCreateUserCommand` (used by platform SUPER_ADMIN to mint
 * users at arbitrary roles), this command is the admin-panel "invite
 * user" button: a tenant admin invites a new user into their own tenant
 * with a specific role, optionally scoped to a set of modules. The
 * handler enforces:
 *   - User-count limit for the tenant (`Tenant.maxUsers`).
 *   - Email uniqueness (case-insensitive).
 *   - Role-hierarchy rule: inviter's role must be ≥ target role, and a
 *     non-SUPER_ADMIN inviter cannot invite into a different tenant.
 *   - Atomic multi-row write: User + Invitation + optional
 *     UserModuleAssignments + Tenant.userCount increment, all in one
 *     repository transaction.
 *
 * CRITICAL-005 (docs/reviews/code-reviewer/2026-04-21-raw-sql-audit.md
 * finding #4): the previous admin-api implementation wrote three
 * cross-service INSERTs against `auth.*` tables using snake_case column
 * names that drift from the TypeORM entities (same class as
 * CRITICAL-001). This contract fully replaces that path.
 */
export interface AdminInviteUserCommand {
  /** Tenant UUID the user is being invited into */
  tenantId: string;
  /** Invitee email — unique, lowercased by handler */
  email: string;
  /** Given name (optional; filled in at invite-accept time if omitted) */
  firstName?: string;
  /** Family name (optional) */
  lastName?: string;
  /**
   * Role to assign on invite-accept. Must be ≤ inviter's role.
   * Allowed: TENANT_ADMIN, MODULE_MANAGER, MODULE_USER.
   * SUPER_ADMIN is NEVER invited — SUPER_ADMIN accounts are minted
   * via AdminCreateUserCommand by a platform operator.
   */
  role: string;
  /** Module UUIDs the invitee is granted access to. Ignored for TENANT_ADMIN. */
  moduleIds?: string[];
  /**
   * Primary module for a MODULE_MANAGER. Must appear in `moduleIds`.
   * Ignored for non-manager roles.
   */
  primaryModuleId?: string;
  /** Inviter's user ID — used for role-hierarchy validation + audit */
  invitedBy: string;
  /** Optional human message stored on the Invitation row */
  message?: string;
  /** Whether auth-service should publish the UserInvited delivery event */
  sendInvitation?: boolean;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
}

/**
 * Result of `AdminInviteUserCommand`.
 *
 * Raw invitation tokens never cross this boundary. Auth-service stores the
 * token hash and publishes a safe `UserInvited` notification event with an
 * opaque action-token reference for delivery.
 */
export interface AdminInviteUserResult {
  success: boolean;
  userId?: string;
  invitationId?: string;
  deliveryStatus?: 'queued';
  errorCode?:
    | 'USER_LIMIT_REACHED'
    | 'DUPLICATE_EMAIL'
    | 'ROLE_VALIDATION_FAILED'
    | 'TENANT_NOT_FOUND'
    | 'INVITER_NOT_FOUND'
    | 'INVALID_ROLE'
    | 'VALIDATION_ERROR'
    | 'INTERNAL_ERROR';
  error?: string;
}

/**
 * Query to check whether a tenant can add more users.
 *
 * Used by admin-panel to gate the "invite user" button before the user
 * fills in the form. Returns a snapshot of currentCount + limit +
 * remaining so the UI can show "3 of 10 user slots used" style messaging.
 *
 * `limit === -1` means unlimited (enterprise tier).
 */
export interface AdminCheckUserLimitQuery {
  /** Tenant UUID */
  tenantId: string;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
}

export interface AdminCheckUserLimitResult {
  success: boolean;
  canCreate?: boolean;
  currentCount?: number;
  /** -1 means unlimited */
  limit?: number;
  remaining?: number;
  message?: string;
  errorCode?: 'TENANT_NOT_FOUND' | 'INTERNAL_ERROR';
  error?: string;
}

/**
 * Union type for all admin-api → auth-service user lifecycle commands.
 */
/**
 * ADR-0016 — a platform capability grant as auth-service reports it.
 * `revokedAt`/`revokedBy` are null while the grant is live; `expiresAt` is
 * null for a standing grant and mandatory (≤ 4 h) for `break-glass`.
 */
export interface PlatformCapabilityGrantSnapshot {
  id: string;
  userId: string;
  capability: PlatformCapability;
  grantedBy: string;
  grantedAt: string;
  expiresAt: string | null;
  revokedBy: string | null;
  revokedAt: string | null;
  reason: string;
}

/**
 * Grant one capability to a SUPER_ADMIN. auth-service enforces the policy:
 * the target must be an active SUPER_ADMIN; `break-glass` needs an
 * `expiresAt` within four hours and a grantor other than the target
 * (dual control); a duplicate live grant is a conflict. The grant revokes
 * the target's refresh tokens and advances the durable access-token
 * invalidation epoch so the claim re-mints on the next token.
 */
export interface AdminGrantPlatformCapabilityCommand {
  userId: string;
  capability: PlatformCapability;
  /** UUID of the SUPER_ADMIN performing the grant — the actor, never client-supplied on the REST side. */
  grantedBy: string;
  /** ISO-8601; required for `break-glass`, optional standing grants otherwise. */
  expiresAt?: string;
  /** Why the grant exists — a ticket or an incident reference. */
  reason: string;
  correlationId?: string;
}

export interface AdminGrantPlatformCapabilityResult {
  success: boolean;
  grant?: PlatformCapabilityGrantSnapshot;
  errorCode?:
    | 'USER_NOT_FOUND'
    | 'NOT_PLATFORM_ADMIN'
    | 'INVALID_CAPABILITY'
    | 'SELF_GRANT_FORBIDDEN'
    | 'EXPIRY_REQUIRED'
    | 'EXPIRY_TOO_LONG'
    | 'EXPIRY_IN_PAST'
    | 'ALREADY_GRANTED'
    | 'VALIDATION_ERROR'
    | 'INTERNAL_ERROR';
  error?: string;
}

/** Revoke the live grant of one capability. Same token-invalidation side effect as a grant. */
export interface AdminRevokePlatformCapabilityCommand {
  userId: string;
  capability: PlatformCapability;
  revokedBy: string;
  reason: string;
  correlationId?: string;
}

export interface AdminRevokePlatformCapabilityResult {
  success: boolean;
  grant?: PlatformCapabilityGrantSnapshot;
  errorCode?: 'USER_NOT_FOUND' | 'GRANT_NOT_FOUND' | 'INVALID_CAPABILITY' | 'VALIDATION_ERROR' | 'INTERNAL_ERROR';
  error?: string;
}

/** Every grant row of one user, live and historical, newest first. */
export interface AdminListPlatformCapabilityGrantsQuery {
  userId: string;
  correlationId?: string;
}

export interface AdminListPlatformCapabilityGrantsResult {
  success: boolean;
  grants?: PlatformCapabilityGrantSnapshot[];
  /** The capabilities the user holds right now — what the next token will carry. */
  active?: PlatformCapability[];
  errorCode?: 'USER_NOT_FOUND' | 'INTERNAL_ERROR';
  error?: string;
}

export type AuthAdminCommand =
  | AdminCreateUserCommand
  | AdminResetUserPasswordCommand
  | AdminUpdateUserCommand
  | AdminDeactivateUserCommand
  | AdminForceLogoutUserCommand
  | AdminInviteUserCommand
  | AdminCheckUserLimitQuery
  | AdminCreateModuleCommand
  | AdminUpdateModuleCommand
  | AdminDeleteModuleCommand
  | AdminGrantPlatformCapabilityCommand
  | AdminRevokePlatformCapabilityCommand
  | AdminListPlatformCapabilityGrantsQuery;

export type AuthPublicCommand =
  | PublicRequestPasswordResetCommand
  | PublicResetPasswordCommand;
