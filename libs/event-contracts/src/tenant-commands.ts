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

// ==================== Type Union ====================

/**
 * Union type for all tenant provisioning commands
 */
export type TenantProvisioningCommand =
  | CreateTenantAdminCommand
  | SetupTenantRolesCommand
  | AssignTenantModulesCommand
  | RollbackTenantProvisioningCommand;
