/**
 * Canonical impersonation session enums and interfaces.
 *
 * Source of truth: admin-api-service `ImpersonationSession` entity.
 * Both backend guards and frontend admin panel MUST use these definitions.
 *
 * ## Existing definitions reconciled
 * - admin-api `ImpersonationSession` entity: single backend definition (authoritative)
 *
 * Values are lowercase to match the database column values.
 */

// ── Enums ──

/** Status of a super-admin impersonation session. */
export enum ImpersonationStatus {
  /** Session is currently active — super-admin is impersonating the target user. */
  ACTIVE = 'active',

  /** Session ended normally by the super-admin. */
  ENDED = 'ended',

  /** Session expired due to TTL (maxSessionDurationMinutes exceeded). */
  EXPIRED = 'expired',

  /** Session was forcibly terminated by another admin or security system. */
  TERMINATED = 'terminated',
}

/** Reason why a super-admin initiated an impersonation session. */
export enum ImpersonationReason {
  /** Tenant submitted a support ticket requiring hands-on investigation. */
  SUPPORT_REQUEST = 'support_request',

  /** Debugging a production issue reported by the tenant. */
  DEBUGGING = 'debugging',

  /** Assisting with tenant-level configuration changes. */
  CONFIGURATION = 'configuration',

  /** Helping a new tenant set up their account during onboarding. */
  ONBOARDING_ASSISTANCE = 'onboarding_assistance',

  /** Investigating a potential security incident on the tenant's account. */
  SECURITY_INVESTIGATION = 'security_investigation',

  /** Verifying data integrity or correctness on behalf of the tenant. */
  DATA_VERIFICATION = 'data_verification',

  /** Reason not covered by predefined categories — requires freetext detail. */
  OTHER = 'other',
}

// ── Interfaces ──

/**
 * Permissions granted to a super-admin during an impersonation session.
 *
 * Stored as JSONB on the `ImpersonationSession` entity. Controls what actions
 * the impersonating admin can perform within the target tenant's scope.
 */
export interface ImpersonationPermissions {
  /** Whether the admin can view tenant data (read-only access). */
  canViewData: boolean;

  /** Whether the admin can modify tenant data (create/update/delete). */
  canModifyData: boolean;

  /** Whether the admin can access tenant-level settings. */
  canAccessSettings: boolean;

  /** Whether the admin can manage tenant users (invite, deactivate, etc.). */
  canManageUsers: boolean;

  /** Whether the admin can view billing and subscription details. */
  canViewBilling: boolean;

  /** Whether the admin can export tenant data. */
  canExportData: boolean;

  /** Optional list of module codes the admin is restricted TO (whitelist). */
  restrictedModules?: string[];

  /** Optional list of module codes the admin is allowed to access. */
  allowedModules?: string[];
}

/**
 * A single auditable action performed during an impersonation session.
 *
 * Stored as JSONB array on `ImpersonationSession.actionsPerformed`.
 * Provides a complete audit trail of what the admin did while impersonating.
 */
export interface ImpersonationAction {
  /** The action performed (e.g. 'VIEW', 'UPDATE', 'DELETE'). */
  action: string;

  /** The resource type affected (e.g. 'farm', 'user', 'setting'). */
  resource: string;

  /** The specific resource ID affected, if applicable. */
  resourceId?: string;

  /** ISO 8601 timestamp of when the action was performed. */
  timestamp: string;

  /** Additional context about the action. */
  details?: Record<string, unknown>;
}
