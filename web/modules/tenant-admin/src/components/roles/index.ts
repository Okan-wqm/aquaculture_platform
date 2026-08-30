/**
 * Roles Components
 *
 * Role-related presentation components. The role create/edit and delete
 * dialogs live INLINE in pages/TenantRolesPage.tsx (the only consumer) —
 * the former RoleModal/DeleteRoleModal copies here were orphaned duplicates
 * with inferior a11y (no focus trap, no useId) and were deleted
 * (RBAC-MEDIUM-008); do not recreate them here without a real second
 * consumer. ROLE_COLORS lives in lib/constants (MED-18 SSoT).
 *
 * @module components/roles
 */

export { RoleCard, RoleBadge } from './RoleCard';
export type { RoleCardProps, RoleBadgeProps } from './RoleCard';
