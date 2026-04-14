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
 * Subject convention: tenant.commands.<CommandType>
 */

// ==================== NATS Subject Constants ====================

export const TENANT_COMMAND_SUBJECTS = {
  CREATE_TENANT_ADMIN: 'tenant.commands.CreateTenantAdmin',
  SETUP_TENANT_ROLES: 'tenant.commands.SetupTenantRoles',
  ASSIGN_TENANT_MODULES: 'tenant.commands.AssignTenantModules',
  ROLLBACK_TENANT_PROVISIONING: 'tenant.commands.RollbackTenantProvisioning',
} as const;

// ==================== CreateTenantAdmin ====================

/**
 * Command to create the first admin user for a newly provisioned tenant.
 * Sent via NATS request-reply to the auth-service which owns auth.users
 * and auth.invitations tables.
 */
export interface CreateTenantAdminCommand {
  /** Tenant UUID */
  tenantId: string;
  /** Admin user email */
  email: string;
  /** Admin first name */
  firstName: string;
  /** Admin last name */
  lastName: string;
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
  /** UUID of the created user (only present on success) */
  userId?: string;
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
export interface SetupTenantRolesCommand {
  /** Tenant UUID */
  tenantId: string;
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
  /** Correlation ID for distributed tracing */
  correlationId?: string;
}

/**
 * Result returned by the auth-service after processing SetupTenantRolesCommand.
 */
export interface SetupTenantRolesResult {
  success: boolean;
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
export interface AssignTenantModulesCommand {
  /** Tenant UUID */
  tenantId: string;
  /** Module UUIDs to assign */
  moduleIds: string[];
  /** Correlation ID for distributed tracing */
  correlationId?: string;
}

/**
 * Result returned by the auth-service after processing AssignTenantModulesCommand.
 */
export interface AssignTenantModulesResult {
  success: boolean;
  /** Number of modules actually assigned (excludes duplicates) */
  modulesAssigned?: number;
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
export interface RollbackTenantProvisioningCommand {
  /** Tenant UUID */
  tenantId: string;
  /** Which provisioning steps completed and need rollback */
  completedSteps: Array<
    'create_admin' | 'setup_roles' | 'assign_modules' | 'activate_tenant'
  >;
  /** Reason for rollback (for audit logging) */
  reason: string;
  /** Correlation ID for distributed tracing */
  correlationId?: string;
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

// ==================== Type Union ====================

/**
 * Union type for all tenant provisioning commands
 */
export type TenantProvisioningCommand =
  | CreateTenantAdminCommand
  | SetupTenantRolesCommand
  | AssignTenantModulesCommand
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
 * Union type for all admin-api → auth-service user lifecycle commands.
 */
export type AuthAdminCommand =
  | AdminCreateUserCommand
  | AdminResetUserPasswordCommand
  | AdminUpdateUserCommand
  | AdminDeactivateUserCommand
  | AdminForceLogoutUserCommand;
