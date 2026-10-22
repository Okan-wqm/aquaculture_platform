/**
 * Module scope — the one definition of "this employee belongs to that module".
 *
 * A department belongs to a module (`departments_hr.moduleCode`); an employee
 * has no module of their own, only a department (`departmentHrId`). So every
 * module-scoped listing — employees, attendance, shifts, leave — asks the same
 * question through the employee's live department, and asks it HERE. A handler
 * that spells the join itself is a second definition waiting to drift.
 *
 * Two shapes of the same predicate, for the two ways handlers query:
 *   - `employeeModuleWhere` for TypeORM find options on `Employee`;
 *   - `applyEmployeeModuleScope` for query builders that already select the
 *     employee (directly, or through a relation) under an alias.
 *
 * An absent module (undefined or null) means "no scope": the Company view, every module.
 *
 * "Live" here means the department is not deleted (isDeleted = false) and
 * nothing more: a department that was only switched off (isActive = false)
 * keeps the people already in it listed under its module. Putting someone INTO
 * a department is the stricter write rule — it also needs isActive = true
 * (hr/services/assignable-department.ts) — so the two are deliberately not the
 * same predicate: viewing is not hidden by a switch-off, assigning is refused.
 */
import type { FindOptionsWhere, ObjectLiteral, SelectQueryBuilder } from 'typeorm';

import type { DepartmentHR } from '../hr/entities/department.entity';
import type { HrModuleCode } from './enums';

/**
 * Whether a module scope is in force. `null` and `undefined` both mean "no scope": GraphQL hands a
 * handler `null` for an explicit `moduleCode: null`, and the Company view must not read that as a
 * module. Every scoped read asks this, so no handler decides "absent" its own way.
 */
export function isModuleScoped(
  moduleCode: HrModuleCode | null | undefined,
): moduleCode is HrModuleCode {
  return moduleCode !== undefined && moduleCode !== null;
}

/** `where.departmentHr` for `Employee` find options: the department is live and in the module. */
export function employeeModuleWhere(moduleCode: HrModuleCode): FindOptionsWhere<DepartmentHR> {
  return { moduleCode, isDeleted: false };
}

/**
 * Restricts a query builder to employees whose live department is in the module.
 * `employeeAlias` is the alias the builder already uses for the `Employee`
 * entity; a no-op when `moduleCode` is absent.
 */
export function applyEmployeeModuleScope<Entity extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<Entity>,
  employeeAlias: string,
  moduleCode: HrModuleCode | null | undefined,
): SelectQueryBuilder<Entity> {
  if (!isModuleScoped(moduleCode)) return queryBuilder;
  const department = `${employeeAlias}_scope_department`;
  return queryBuilder.innerJoin(
    `${employeeAlias}.departmentHr`,
    department,
    `${department}.moduleCode = :scopeModuleCode AND ${department}.isDeleted = false`,
    { scopeModuleCode: moduleCode },
  );
}
