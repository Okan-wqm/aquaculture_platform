/**
 * Who may read an employee's contact details, and what everyone else sees instead.
 *
 * DB-PEOPLE-MEDIUM-001: the employee read operations are open to the broad workforce role, so
 * without this a colleague could read any other colleague's home address, personal phone and
 * emergency contacts. `EmployeeFieldsResolver` applies it to the `Employee` type itself, so it holds
 * for every operation that returns an employee, directly or nested in a leave request, a weekly plan
 * or a certification (HR-HIGH-056; ADR-054 draft D-G).
 *
 * HR-HIGH-067: the manager tier was the tenant-wide MODULE_MANAGER role, which Assign Manager writes
 * for a manager of any module, so a sensor manager read the home address and emergency contacts of
 * every farm and HR employee. Full details now go to:
 *   - a tenant administrator (or a platform administrator acting for the tenant);
 *   - the employee themselves;
 *   - the hr manager: the holder of an hr MODULE_MANAGER grant (owner decision D6, the same
 *     definition pay uses);
 *   - a manager of the employee's module by grant: a farm manager sees the farm workforce it runs,
 *     not the sensor or HR people (D5, a module manager sees only their slice). The module is the
 *     one of the employee's live department (common/module-scope.ts); an employee placed in no
 *     department, or in a company-wide one, belongs to no module manager.
 * Grants are read from the verified `moduleAccess` claim (`managesModuleByGrant`), never from
 * `users.role`. Everyone else gets the directory projection.
 *
 * Direct-supervisor visibility for a line manager who is not a module manager is a tracked
 * refinement (ORPHAN-MEDIUM-347); `findViewerEmployee` (common/viewer.ts) provides the lookup it was
 * waiting for.
 */
import { OWNER_MODULE, type OwnerModuleCode } from '@aquaculture/shared-contracts';

import { isSameUser, isTenantAdmin, managesModuleByGrant } from '../../common/viewer';
import type { ViewerClaims } from '../../common/viewer';
import type { Address, ContactInfo, Employee } from '../entities/employee.entity';

const REDACTED = 'REDACTED';

/**
 * @param employeeModule the module of the employee's live department; null when they are placed in
 *   no department, in a deleted one, or in a company-wide one.
 */
export function canViewEmployeeContact(
  employee: Pick<Employee, 'userId'>,
  employeeModule: OwnerModuleCode | null,
  viewer: ViewerClaims,
): boolean {
  if (isTenantAdmin(viewer) || isSameUser(employee.userId, viewer)) return true;
  if (managesModuleByGrant(viewer, OWNER_MODULE.HR)) return true;
  return employeeModule !== null && managesModuleByGrant(viewer, employeeModule);
}

/** The work email stays (it is already public as `Employee.email`); phone numbers go. */
export function redactContactInfo(contactInfo: ContactInfo): ContactInfo {
  return {
    email: contactInfo.email,
    phone: REDACTED,
    emergencyContact: undefined,
    emergencyPhone: undefined,
  };
}

export function redactAddress(): Address {
  return {
    street: REDACTED,
    city: REDACTED,
    state: REDACTED,
    postalCode: REDACTED,
    country: REDACTED,
  };
}
