/**
 * GET /users/:id/activity response row.
 *
 * `metadata` is the projection of the auth.audit_logs `details` jsonb column
 * (the auth-service AuditLog entity owns it — there is NO `metadata` column on
 * auth.audit_logs). admin-api reads the auth schema via raw SQL because it has
 * no entity for it. See APA-053.
 */
export interface UserActivity {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  ipAddress: string;
  userAgent: string;
  createdAt: Date;
}
