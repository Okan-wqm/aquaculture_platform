# Module-scoped HR — findings (2026-10-22)

Raised while building the Team area for Production, Greenhouse and Control & sensors: employees
are registered once in HR, belong to a module through their department, and are listed in that
module's panel; Company sees every module. HR-HIGH-049, HR-MEDIUM-050, HR-MEDIUM-051 and
HR-MEDIUM-055 are closed by that change; the rest are the work it found and did not do, each with
an owner and a date.

---

## HR-HIGH-049 — Employee had no write path to an HR department

- **Evidence:** `CreateEmployeeInput` accepted only the legacy `department` enum. The employee form
  sent `departmentHrId`, which was never in the schema, and forced a department code into the enum
  through `mapDepartmentType`, so a custom department failed the enum check.
  `Employee.departmentHrId` existed as a column with no writer, which left `departments_hr` unable
  to hold anyone.
- **Fix:** `departmentHrId` is on `CreateEmployeeInput` (and, through `PartialType`, on the update
  input). One function, `assertAssignableDepartment`, is the only validation: the department must be
  live (not deleted, active) in the tenant. An explicit null unassigns. The employee form places a
  new employee and can move an existing one; only a changed value is sent.

## HR-MEDIUM-050 — People were not module-scoped

- **Evidence:** the console's Team area linked every workspace to the same global `/hr` pages, and
  the employee query had no module filter, so a module panel showed everyone's staff.
- **Fix:** `departments_hr.moduleCode` (null = company-wide). An employee has no module of their
  own; it is read through the department. One backend predicate (`common/module-scope.ts`) and one
  frontend reader (`useModuleScope`, fed by the shell's `WorkforceScopeProvider`) define the rule;
  ten Team-page queries take an optional `moduleCode`. Module names come from the console's
  workspace names (`WORKFORCE_MODULE_LABEL_KEYS`), translated. Module Team lists start empty after
  deploy: every migrated department is company-wide until an admin gives it a module.
- **Derived on the server:** `DepartmentHR.headCount`, `DepartmentHR.managerName` and
  `Employee.departmentHr` are field resolvers over request-scoped tenant dataloaders, so the
  organization chart reads no roster and every operation that returns an employee answers its
  department the same way.

## HR-MEDIUM-051 — Membership was stated twice

- **Evidence:** the legacy `Employee.department` enum and `Employee.isFarmWorker` restated what
  `departmentHrId` and the department's module say. Finance already keyed on `departmentHrId`.
- **Fix:** both retired from code and API; migration `1802500000000` backfills a department for
  every employee that only had the enum (matching an existing department by code without regard
  to case, choosing one deterministically), backfills the attendance snapshot of the people it
  places, and relaxes the NOT NULL. It is a data migration: each tenant with legacy employees gains
  up to eight company-wide departments. A real-Postgres spec verifies the data;
  `db-migration-check.yml` only migrates empty databases.

## HR-MEDIUM-052 — Orphan columns employees.department and employees.isFarmWorker

- **Plan:** drop both with `dropOrphanedColumns` in a later release. Old containers still read them
  during a blue-green rollout, so the drop cannot share the release. Re-run the backfill first: an
  old container creates employees with `department` but no `departmentHrId`.

## HR-MEDIUM-053 — farm-service keeps a second people and department vocabulary

- **Evidence:** Site workers (`farm_workers`) and Site departments (`departments`, 13 types) overlap
  HR employees and `departments_hr`.
- **Plan:** needs an owner decision before code. Consolidate Site workers into HR employees
  (veterinarian fields move with them) and decide what Site departments keep as physical units.

## HR-MEDIUM-054 — Four hr-module hook files use un-prefixed query keys

- **Evidence:** `useCertifications`, `usePerformance`, `useAquaculture` and `usePayroll` hold 39
  queries and their invalidations on keys with no tenant prefix (the FE-CRITICAL-014 class).
  `useLeaves`, `useAttendance`, `useScheduling` and the employee and department reads were migrated
  to `useTenantQuery` in the module-scoped HR change, because its workforce invalidation could not
  reach un-prefixed keys.
- **Plan:** the same mechanical migration for the four files: `useTenantQuery` with `select`, and
  tenant-prefixed invalidation. `useTenantQuery` now accepts `select`, so no cache shape changes.

## HR-MEDIUM-055 — Leave hooks had the wrong shapes

- **Evidence:** `usePendingLeaveApprovals` was typed as an array and sent an `approverId` the
  operation does not declare, while the operation returns the paginated shape, so the pending count
  showed 0 and the pending tab received an object as rows. `useMyLeaveRequests` sent a nested filter
  to flat variables, and the My Requests tab filtered by the auth user id, which is not an employee
  id, so it could never match.
- **Fix:** `usePendingLeaveApprovals(pagination)` returns the paginated object and the pages read
  `.items` / `.total`; `useMyLeaveRequests(status, pagination)` sends flat variables and the tab
  uses it. The attendance approver lookup had the same user-id-as-employee-id defect and is fixed
  the same way as leave. Both approval queues now narrow through one function
  (`common/approval-scope.ts`) and the employee's live department; attendance used a per-record
  snapshot that goes stale when an employee is moved.

## HR-HIGH-056 — Many hr-service operations have no role gate

- **Evidence:** `teamLeaveCalendar`, `checkLeaveOverlap`, `calculateLeaveDays`, `leaveTypes` and the
  scheduling reads (`weeklyPlans`, `weeklyPlan`, `teamWeeklyOverview`, `schedulingSettings`,
  `mySchedule`, `overtimeSummary`) declare only the class-level authentication guard, as do reads in
  the training and performance resolvers. The weekly plans return the nested `Employee` record, so
  its contact details reach any authenticated tenant user. The pending-approval queries also apply
  no department filter for an approver who has no department. Attendance approval has no
  self-approval check: the queue hides the approver's own records, the approve mutation does not
  refuse them.
- **Plan:** tier 3: an invariant that lists every hr-service operation with its gate and an explicit
  allow-list for self-service reads; and field-level masking of `Employee` contact data
  (`maskEmployeeContactPii`) on every path that returns an employee. The module scope narrows
  results but is a view filter, not an authorization boundary.

## HR-LOW-057 — Department consistency is client-side only

- **Evidence:** no server rule for a parent in another module or a `siteId` with a non-FARM module,
  and `DepartmentsPage` has no editor for `managerId` or `parentDepartmentId`. Employees already
  linked to a soft-deleted department are neither detected nor repaired by the migration, which only
  looks at a NULL link.
- **Plan:** until a manager is set through the API the organization chart shows "No manager
  assigned". Decide the rules, enforce them in the department handlers, add the editors.

## HR-LOW-058 — HR e2e specs run in no CI lane

- **Evidence:** `e2e/tests/modules/hr` is outside every lane, and no longer matches the schema
  (`employees.data` against `items`, a `createHRDepartment.type` that does not exist).
- **Plan:** revive against the live stack or delete. The module-scoped HR change only removed their
  uses of the retired API.

## HR-LOW-059 — hr-module leftovers

- **Evidence:** the employee list filters send lower-case enum values; `useEmployeeByNumber` is a
  dead hook on a filter field that does not exist, and about fifteen hooks in `useScheduling`,
  `useAttendance` and `useLeaves` have no caller; no frontend operation requests
  `pendingAttendanceApprovals`; the `?departmentId=` filter of the Team list is read once at
  mount; `useSeaLandSplit` reads only the first page and its offshore half is not module-scoped
  (the crew pages live in Company); `useSiteResponsibility`
  fires a farm request in Greenhouse and Control; `useLeaveTypes` sends a nested filter to flat
  variables and its key ignores the filter; `useLeaveBalanceSummary` selects a field the operation
  does not return, so `LeaveBalanceWidget` is always empty; the My Requests and Pending tabs ignore
  the leave type and date filters because their operations take none.
- **Plan:** all pre-existing; fix or delete each.

## HR-LOW-060 — Two shipped migrations may have matched no rows

- **Evidence:** `1801600000000` and `1802000000000` UPDATE `employees` without the RLS bypass, so
  they may have matched zero rows in tenant schemas.
- **Plan:** shipped migrations are immutable; check `laborCategory` coverage on a live tenant.

## HR-MEDIUM-061 — Department code uniqueness is case-sensitive in the schema

- **Evidence:** the unique index is `(tenantId, code)` and case-sensitive, while the application
  check and the retire-department migration compare codes without regard to case. Two concurrent
  creates of `ops` and `OPS` can both pass the application check.
- **Plan:** a functional unique index on `(tenantId, upper(code))` in a new migration that first
  reports and resolves existing case variants. Decide in the same change whether codes are unique
  per tenant (today) or per module — an owner decision.

## HR-LOW-062 — The FE operation gate does not validate fragments

- **Evidence:** a nonexistent field added to `EMPLOYEE_DEPARTMENT_FRAGMENT` passed
  `scripts/ci/validate-graphql-operations.mjs` with 0 drift; `graphql-codegen --check` printed no
  error for it in the same experiment, which is not conclusive about CI.
- **Plan:** validate every fragment definition against the supergraph in the same pass.

## HR-LOW-063 — The migration's data proof does not run when the migration changes

- **Evidence:** `libs/migration-harness` runs in CI only when the harness project is affected, and
  an edit to an hr-service migration does not make it so. The real-Postgres spec that proves the
  department backfill says in its header to keep it in step with the migration, and nothing makes CI
  do so.
- **Plan:** declare the spec as an implicit dependency of the hr-service migration files, or add a
  path trigger in `ci-affected.yml`.
