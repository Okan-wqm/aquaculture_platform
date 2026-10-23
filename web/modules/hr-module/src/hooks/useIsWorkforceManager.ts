/**
 * useIsWorkforceManager — whether the reader manages the workforce.
 *
 * Hiring, editing, payroll and the like belong to these roles; the HR service
 * rejects everyone else, so a screen that offers such an action to anyone else
 * only hands them an error. One definition for hr-module: its pages ask here
 * instead of each spelling the role list.
 */
import { useAuth, type UserRole } from '@aquaculture/shared-ui';

const WORKFORCE_MANAGER_ROLES: readonly UserRole[] = [
  'SUPER_ADMIN',
  'TENANT_ADMIN',
  'MODULE_MANAGER',
];

export function useIsWorkforceManager(): boolean {
  const { user } = useAuth();
  return user !== null && WORKFORCE_MANAGER_ROLES.includes(user.role);
}
