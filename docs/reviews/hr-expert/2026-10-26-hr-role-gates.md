# HR operation role gates — findings (2026-10-26)

Raised while closing HR-HIGH-056, which made every hr-service operation declare who may call it,
redacted employee contact details on the `Employee` type, made an approver without a department
see an empty queue, and refused attendance self-approval. The findings below are what that change
found and did not do, each with an owner and a deadline.

---

## HR-MEDIUM-064 — Module and department arguments are views, not authorization

- **Evidence:** `moduleCode` and `departmentId` narrow what an operation returns, and nothing
  checks that the caller belongs to the module or department they name. hr-service reads no
  `modules` claim from the token. A module manager of Production can ask the approval queues, the
  team list and the scheduling reads for Greenhouse by naming it.
- **Plan:** decide what a manager of one module may see of another (owner decision). Then derive the
  allowed modules once from the token (`CurrentUserPayload.modules` against `HrModuleCode`) and
  apply them in `common/module-scope.ts`, the one predicate every module-scoped read already uses.
- **Owner / deadline:** Okan-wqm, 2026-11-05 (defaults; adjust).

## HR-MEDIUM-065 — Team reads show drafts, overtime and pending leave to every staff member

- **Evidence:** `teamWeeklyOverview` returns DRAFT plan entries, the plan status and every
  employee's `overtimeMinutes`; `teamLeaveCalendar` returns PENDING requests and the leave type
  name (sick, parental) of everyone. Both are open to all staff on purpose, a roster and a
  calendar, but a roster is the published plan.
- **Plan:** for a viewer who is not a workforce manager, return published plans without overtime,
  and approved leave only. Whether colleagues see the leave type is an owner decision.
- **Owner / deadline:** Okan-wqm, 2026-11-05 (defaults; adjust).

## HR-MEDIUM-066 — Approval-like mutations let the subject approve themselves

- **Evidence:** attendance approval now refuses the approver's own record, as leave already did.
  The same shape remains in `approvePayroll` (the employee a payroll is for may approve it unless
  they created it), `submitManagerAssessment`, `finalizeReview`, `reopenReview`,
  `verifyCertification`, `completeTraining`, `confirmSafetyTrainingAttendance` and
  `approveRotation`. None compares the actor with the record's employee.
- **Plan:** `assertNotOwnRecord` (`common/viewer.ts`) in each handler with a spec per mutation.
  Where the only manager is the subject, require a second approver.
- **Owner / deadline:** Okan-wqm, 2026-11-05 (defaults; adjust).

## HR-LOW-067 — A mobile command receipt is not bound to the caller

- **Evidence:** `MobileCommandReceiptService.begin` finds a replay by `(tenantId, clientCommandId)`
  and the payload hash. The replay branch of clock-in and clock-out returns the stored attendance
  record without comparing the caller with its employee. Exploiting it needs another employee's
  client-generated command id and payload hash.
- **Plan:** record the acting user in the receipt and refuse a replay by anyone else. The service
  is shared, so the change lives in `libs/backend-common` with a column on each receipt table.
- **Owner / deadline:** Okan-wqm, 2026-11-21 (defaults; adjust).

## HR-MEDIUM-068 — Goals and reviews: no owner rule, a status bypass, a visible draft

- **Evidence:** every goal mutation is manager-only after HR-HIGH-056, because no handler compares
  the caller with `goal.employeeId`; an employee cannot update progress on their own goal.
  `updateGoal` accepts a client-supplied `status`, COMPLETED, CANCELLED and DEFERRED included, so it
  skips what `completeGoal`, `cancelGoal` and `deferGoal` do. `updateGoalProgress` ignores its
  `notes`, and `createGoal` does not validate `alignedReviewId`. `myPerformanceReviews` now
  returns the employee's own reviews in every status, so they read the manager's draft rating and
  calibration notes (including a reopen reason) before the review is finalised.
- **Plan:** decide who edits a goal (the employee, their manager, both), enforce it in the handlers
  through the viewer helper, and take `status` out of `UpdateGoalInput`. Decide what the subject
  sees of a review that is not yet finalised.
- **Owner / deadline:** Okan-wqm, 2026-11-21 (defaults; adjust).

## HR-MEDIUM-069 — `Employee.userId` is not unique

- **Evidence:** `employees.userId` links the auth user to the HR employee. Every self-service
  operation, approval check and contact-detail rule resolves the viewer through it
  (`findViewerEmployee`), and the column has no unique index per tenant. Two employees carrying one
  user id make the lookup return an arbitrary one of them.
- **Plan:** a partial unique index on `(tenantId, userId)` where `userId` is not null and the row is
  not deleted, in a migration that first reports existing duplicates.
- **Owner / deadline:** Okan-wqm, 2026-11-21 (defaults; adjust).

## HR-LOW-070 — hr-module sends the auth user id where an employee id is due

- **Evidence:** `useCurrentEmployeeId` returns the auth user id. `TimeClockWidget` sends it as the
  `employeeId` of `clockIn` and `clockOut`, which the resolver compares with the HR employee id;
  `PerformancePage` passes it as `reviewerId`. `NewLeaveRequestModal` lets the user pick any
  employee, and the resolver refuses everyone but the caller.
- **Plan:** read the viewer's own employee once from the server, send no employee id for a request
  that is about the caller, and drop the picker for anyone who cannot file for others.
- **Owner / deadline:** Okan-wqm, 2026-11-21 (defaults; adjust).

## HR-LOW-071 — The viewer is still read in places other than common/viewer.ts

- **Evidence:** `RolesGuard` keeps its claim normalisation private, so `common/viewer.ts` repeats it
  (upper-case, the legacy single `role`, the hierarchy). Seven hand-written lookups of the viewer's
  employee by user id remain: the submit, cancel, update and withdraw leave handlers, and the
  attendance resolver's `findEmployee`, the scheduling resolver's `mySchedule` and the aquaculture
  resolver's `myWorkRotations` (the last one does not filter deleted employees, unlike the rest).
- **Plan:** extract the normalisation from `RolesGuard` into `libs/backend-common` as a pure
  function both use, and point the seven sites at `findViewerEmployee`.
- **Owner / deadline:** Okan-wqm, 2026-11-21 (defaults; adjust).
