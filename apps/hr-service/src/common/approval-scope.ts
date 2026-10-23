/**
 * Approval scope — the one rule for which department a pending-approval queue narrows to.
 *
 * Leave and attendance both have a queue of records waiting for a manager. It narrows to ONE
 * thing, chosen in this order: the explicit department, else the module (the module IS the scope,
 * so an approver in a company-wide department still sees the module's records), else — for a
 * manager in the Company view — the approver's own department. A tenant admin, or a viewer with
 * no employee record, is never narrowed implicitly: they approve across departments.
 *
 * "Department" is always the employee's LIVE department (`employee.departmentHrId`), never a
 * per-record snapshot: when an employee is moved, their pending records follow them to the new
 * approver. The two queues used to spell this separately and had already diverged; both handlers
 * ask here instead.
 */
import type { ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';

import { Employee } from '../hr/entities/employee.entity';
import type { HrModuleCode } from './enums';
import { isModuleScoped } from './module-scope';

export interface ApprovalScopeRequest {
  readonly tenantId: string;
  /** The approver's HR EMPLOYEE id (never the auth user id); null for a viewer with no employee record. */
  readonly approverId: string | null;
  readonly departmentId?: string;
  readonly moduleCode?: HrModuleCode | null;
  /** False for a tenant admin, who is never narrowed to a department implicitly. */
  readonly narrowToOwnDepartment: boolean;
}

export type ApprovalDepartment =
  /** Narrow to `departmentId`; undefined or null narrows nothing. */
  | { readonly kind: 'narrow'; readonly departmentId: string | null | undefined }
  /** The approver is not an employee of the tenant: the queue is empty, not wide. */
  | { readonly kind: 'unknown-approver' };

/**
 * The approver's department is looked up only when nothing explicit narrows the queue, so a call
 * that names a department or a module costs no extra round-trip.
 */
export async function resolveApprovalDepartment(
  employeeRepository: Repository<Employee>,
  request: ApprovalScopeRequest,
): Promise<ApprovalDepartment> {
  const { tenantId, approverId, departmentId, moduleCode, narrowToOwnDepartment } = request;

  if (departmentId || isModuleScoped(moduleCode) || !narrowToOwnDepartment || !approverId) {
    return { kind: 'narrow', departmentId };
  }

  const approver = await employeeRepository.findOne({
    where: { id: approverId, tenantId, isDeleted: false },
    select: ['id', 'departmentHrId'],
  });
  if (!approver) return { kind: 'unknown-approver' };
  return { kind: 'narrow', departmentId: approver.departmentHrId };
}

/**
 * Restricts a query builder to employees in the department, under the alias the builder already
 * uses for the `Employee` relation; a no-op when there is nothing to narrow by.
 */
export function applyApprovalDepartment<Entity extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<Entity>,
  employeeAlias: string,
  departmentId: string | null | undefined,
): SelectQueryBuilder<Entity> {
  if (!departmentId) return queryBuilder;
  return queryBuilder.andWhere(`${employeeAlias}.departmentHrId = :departmentId`, { departmentId });
}
