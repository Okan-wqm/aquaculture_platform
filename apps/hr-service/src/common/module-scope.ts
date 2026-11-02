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
import { In, type FindOptionsWhere, type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';

import type { DepartmentHR } from '../hr/entities/department.entity';
import type { Employee } from '../hr/entities/employee.entity';
import type { ModuleScope, OwnerModuleCode } from '@aquaculture/shared-contracts';

/**
 * Whether a module scope is in force. `null` and `undefined` both mean "no scope": GraphQL hands a
 * handler `null` for an explicit `moduleCode: null`, and the Company view must not read that as a
 * module. Every scoped read asks this, so no handler decides "absent" its own way.
 */
export function isModuleScoped(
  moduleCode: OwnerModuleCode | null | undefined,
): moduleCode is OwnerModuleCode {
  return moduleCode !== undefined && moduleCode !== null;
}

/** `where.departmentHr` for `Employee` find options: the department is live and in the module. */
export function employeeModuleWhere(moduleCode: OwnerModuleCode): FindOptionsWhere<DepartmentHR> {
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
  moduleCode: OwnerModuleCode | null | undefined,
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

/**
 * The workforce scope — which modules' people a caller may see (ADR-051 §1 `scoped('workforce')`;
 * HR-HIGH-066). Unlike a `moduleCode`, which is the view a client asks for, the scope is decided on
 * the server: `@AccessCaller()` derives it from the caller's verified grants
 * (common/workforce-scope.ts), and the client's `moduleCode` only narrows it. An employee belongs to
 * the module of their live department, as above; an employee placed in no department, or in a
 * company-wide one (no module), is inside `ALL` only.
 *
 * Fail closed: a handler that receives no scope returns nothing (`undefined` is never read as
 * "every module"), so a call site that forgets to pass one shows an empty list, not the tenant.
 */
export function applyEmployeeScope<Entity extends ObjectLiteral>(
  queryBuilder: SelectQueryBuilder<Entity>,
  employeeAlias: string,
  scope: ModuleScope | undefined,
): SelectQueryBuilder<Entity> {
  if (scope === undefined) return queryBuilder.andWhere('1 = 0');
  if (scope.kind === 'all') return queryBuilder;
  const department = `${employeeAlias}_workforce_department`;
  return queryBuilder.innerJoin(
    `${employeeAlias}.departmentHr`,
    department,
    `${department}.moduleCode IN (:...workforceModuleCodes) AND ${department}.isDeleted = false`,
    { workforceModuleCodes: [...scope.modules] },
  );
}

/**
 * The workforce scope as `Employee` find options to spread into a `where`: `{}` for `ALL`, the
 * live department in one of the modules otherwise, and null when no scope was decided (the caller
 * sees no one).
 */
export function employeeScopeWhere(
  scope: ModuleScope | undefined,
): Pick<FindOptionsWhere<Employee>, 'departmentHr'> | null {
  if (scope === undefined) return null;
  if (scope.kind === 'all') return {};
  return { departmentHr: { moduleCode: In([...scope.modules]), isDeleted: false } };
}
