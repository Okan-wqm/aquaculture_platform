/**
 * Who may read an employee's contact details, and what everyone else sees instead.
 *
 * DB-PEOPLE-MEDIUM-001: the employee read operations are open to the broad workforce role, so
 * without this a colleague could read any other colleague's home address, personal phone and
 * emergency contacts. Full contact details go to a workforce manager, or to the employee themselves;
 * everyone else gets a directory projection. `EmployeeFieldsResolver` applies it to the `Employee`
 * type itself, so it holds for every operation that returns an employee, directly or nested in a
 * leave request, a weekly plan or a certification (HR-HIGH-056).
 *
 * Direct-supervisor visibility for a line manager who is not a workforce manager is a tracked
 * refinement (ORPHAN-MEDIUM-347); `findViewerEmployee` (common/viewer.ts) now provides the lookup
 * it was waiting for.
 */
import { isSameUser, isWorkforceManager } from '../../common/viewer';
import type { ViewerClaims } from '../../common/viewer';
import type { Address, ContactInfo, Employee } from '../entities/employee.entity';

const REDACTED = 'REDACTED';

export function canViewEmployeeContact(
  employee: Pick<Employee, 'userId'>,
  viewer: ViewerClaims,
): boolean {
  return isWorkforceManager(viewer) || isSameUser(employee.userId, viewer);
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
