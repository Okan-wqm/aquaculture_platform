/**
 * Whether the signed-in role may read farm finance figures.
 *
 * WHY one gate: farm-service serves every finance read (financeLedger,
 * financeSummary, financeCategories) only to TENANT_ADMIN and MODULE_MANAGER,
 * and its roles guard lets SUPER_ADMIN through. The finance page and every
 * finance figure shown elsewhere — the facility node's cost share — ask this
 * hook, so a role never sees a cost on one screen that another hides from it,
 * nor fires a read the server would refuse.
 */
import { useAuth, type UserRole } from '@aquaculture/shared-ui';

const FINANCE_READ_ROLES: UserRole[] = ['SUPER_ADMIN', 'TENANT_ADMIN', 'MODULE_MANAGER'];

export function useCanReadFinance(): boolean {
  const { hasAnyRole } = useAuth();
  return hasAnyRole(FINANCE_READ_ROLES);
}
