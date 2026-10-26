/**
 * hr-service operation role gates — every GraphQL operation names who may call it
 * ============================================================================
 *
 * Closes HR-HIGH-056 (docs/reviews/hr-expert/2026-10-22-module-scoped-hr.md).
 *
 *   `RolesGuard` is global and opt-in: an operation with no `@Roles` is open to every
 *   authenticated user, and nothing in the code says that was a decision. More than fifty
 *   hr-service operations were open that way — among them reads keyed by an arbitrary employee id
 *   (performance reviews, goals, certifications, rotations, weekly plans) that any staff member
 *   could page through.
 *
 * # What this spec enforces (Tier 3, "make it detectable")
 *
 *   1. Every `@Query` / `@Mutation` / `@Subscription` of the hr-service subgraph declares its gate
 *      on the operation: `@Roles(...)` or `@ModuleUserOrHigher()`. A gate that is merely absent is
 *      not a gate.
 *   2. An operation open to EVERY staff member (`MODULE_USER` and up) is an explicit decision:
 *      it must be listed in ANY_STAFF below with why that is safe. A new operation that returns
 *      someone else's data therefore cannot be opened to everyone by leaving a decorator off, nor
 *      by copying `@ModuleUserOrHigher()` from the next method: the list is what a reviewer reads.
 *   3. The list holds no stale entry: every name is still an operation, still open to all staff.
 *   4. No operation is `@Public()`.
 *   5. Contact details of an employee are redacted on the `Employee` type itself, so no operation
 *      that returns an employee — directly or nested in a leave request, a plan, a certification —
 *      has to remember to mask them (`EmployeeFieldsResolver`).
 *
 * The operation surface comes from the shared decorator scan (`helpers/farm-graphql-surface`), the
 * same one the FE↔BE parity gates read, so this spec and those cannot disagree about what the
 * subgraph serves.
 *
 * # When this spec fails
 *
 *   - "declares no gate": add `@UseGuards(RolesGuard) @Roles(Role.TENANT_ADMIN,
 *     Role.MODULE_MANAGER)` for anything that returns or changes another person's data, or
 *     `@ModuleUserOrHigher()` for a call that is about the caller or about reference data.
 *   - "open to all staff but not listed": decide which kind it is, add it to ANY_STAFF with the
 *     reason. If you cannot write the reason in one sentence, it is a manager operation.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

import { REPO_ROOT, extractBackendResolverFields, listFiles } from './helpers/farm-graphql-surface';
import type { BackendResolverField } from './helpers/farm-graphql-surface';

const HR_SOURCE_ROOT = 'apps/hr-service/src';

/**
 * Why an operation may be called by every staff member.
 *  - self:    about the caller; the identity comes from the JWT, never from an argument.
 *  - catalog: tenant-wide reference or configuration data; nothing about an individual.
 *  - team:    what colleagues need to see of one another (a roster, a directory, headcounts); a
 *             nested employee is redacted by the type, and nothing about pay, performance or health.
 *             (HR-MEDIUM-065 tracks the drafts, overtime and pending leave two of them still show.)
 */
type StaffReason = 'self' | 'catalog' | 'team';

const ANY_STAFF: Readonly<Record<string, { readonly kind: StaffReason; readonly why: string }>> = {
  // ── employees and departments ──────────────────────────────────────────────────────────────
  employee: {
    kind: 'team',
    why: 'directory entry; contact details redacted by Employee.contactInfo/address',
  },
  employees: {
    kind: 'team',
    why: 'team list; contact details redacted by Employee.contactInfo/address',
  },
  hrDepartments: { kind: 'catalog', why: 'department names, codes and head counts' },
  hrDepartment: {
    kind: 'catalog',
    why: 'one department: name, code, cost codes, head count, manager name',
  },
  hrDashboardStats: { kind: 'team', why: 'aggregate counts only' },
  // ── attendance and shifts ──────────────────────────────────────────────────────────────────
  shifts: { kind: 'catalog', why: 'shift definitions' },
  shift: { kind: 'catalog', why: 'one shift definition' },
  myAttendanceRecords: { kind: 'self', why: 'employee resolved from the JWT user' },
  myAttendanceSummary: { kind: 'self', why: 'employee resolved from the JWT user' },
  myTodaysAttendance: { kind: 'self', why: 'employee resolved from the JWT user' },
  todaysAttendance: {
    kind: 'self',
    why: 'a non-manager is narrowed to their own record inside the resolver',
  },
  dailyAttendanceOverview: { kind: 'team', why: 'aggregate counts only' },
  clockIn: { kind: 'self', why: 'the resolver refuses another employee id' },
  clockOut: { kind: 'self', why: 'the resolver refuses another employee id' },
  // ── leave ──────────────────────────────────────────────────────────────────────────────────
  leaveTypes: { kind: 'catalog', why: 'leave type definitions' },
  calculateLeaveDays: {
    kind: 'catalog',
    why: 'pure calculation from the leave type and the holiday calendar',
  },
  myLeaveBalances: { kind: 'self', why: 'employee resolved from the JWT user' },
  myLeaveRequests: { kind: 'self', why: 'employee resolved from the JWT user' },
  teamLeaveCalendar: { kind: 'team', why: 'who is away when, for colleagues to plan around' },
  createLeaveRequest: {
    kind: 'self',
    why: 'the resolver refuses an employee id that is not the caller',
  },
  submitLeaveRequest: { kind: 'self', why: 'the handler checks the request is the caller' },
  cancelLeaveRequest: { kind: 'self', why: 'the handler checks the request is the caller' },
  updateLeaveRequest: { kind: 'self', why: 'the handler checks the request is the caller' },
  withdrawLeaveRequest: { kind: 'self', why: 'the handler checks the request is the caller' },
  // ── scheduling ─────────────────────────────────────────────────────────────────────────────
  mySchedule: { kind: 'self', why: 'employee resolved from the JWT user, published plans only' },
  teamWeeklyOverview: { kind: 'team', why: 'the roster colleagues work from' },
  schedulingSettings: { kind: 'catalog', why: 'tenant scheduling configuration' },
  // ── training and certification ─────────────────────────────────────────────────────────────
  certificationTypes: { kind: 'catalog', why: 'certification type definitions' },
  certificationType: { kind: 'catalog', why: 'one certification type definition' },
  trainingCourses: { kind: 'catalog', why: 'course catalogue' },
  trainingCourse: { kind: 'catalog', why: 'one course' },
  certificationsForWorkArea: {
    kind: 'catalog',
    why: 'which certification types a work area requires',
  },
  trainingCalendar: { kind: 'catalog', why: 'scheduled course sessions' },
  myCertifications: { kind: 'self', why: 'employee resolved from the JWT user' },
  myTrainingEnrollments: { kind: 'self', why: 'employee resolved from the JWT user' },
  startTraining: { kind: 'self', why: 'the handler checks the enrolment is the caller' },
  withdrawFromTraining: { kind: 'self', why: 'the handler checks the enrolment is the caller' },
  // ── performance ────────────────────────────────────────────────────────────────────────────
  myPerformanceReviews: { kind: 'self', why: 'employee resolved from the JWT user' },
  myGoals: { kind: 'self', why: 'employee resolved from the JWT user' },
  submitSelfAssessment: {
    kind: 'self',
    why: 'the handler refuses anyone but the reviewed employee',
  },
  acknowledgeReview: { kind: 'self', why: 'the handler refuses anyone but the reviewed employee' },
  // ── work areas and rotations ───────────────────────────────────────────────────────────────
  workAreas: { kind: 'catalog', why: 'work area definitions' },
  offshoreWorkAreas: { kind: 'catalog', why: 'offshore work area definitions' },
  workArea: { kind: 'team', why: 'one work area and the names of who is assigned there now' },
  myWorkRotations: { kind: 'self', why: 'employee resolved from the JWT user' },
};

type Gate = 'manager' | 'any-staff' | 'none' | 'public';

/** What the decorators written on an operation say about who may call it. */
function gateOf(operation: BackendResolverField): Gate {
  const written = operation.decorators.join(' ');
  if (/@Public\s*\(/.test(written)) return 'public';
  if (/@ModuleUserOrHigher\s*\(/.test(written)) return 'any-staff';
  const roles = written.match(/@Roles\s*\(([^)]*)\)/);
  if (roles) {
    // A @Roles that names no `Role.X` (empty, or a spread constant) is not a gate this scan can
    // read, and RolesGuard treats an empty list as "any authenticated user": refuse it.
    const named: string[] = roles[1]?.match(/\bRole\.[A-Z_]+/g) ?? [];
    if (named.length === 0) return 'none';
    return named.includes('Role.MODULE_USER') ? 'any-staff' : 'manager';
  }
  if (/@(TenantAdminOrHigher|ModuleManagerOrHigher|SuperAdminOnly)\s*\(/.test(written))
    return 'manager';
  return 'none';
}

describe('hr-service operation role gates (HR-HIGH-056)', () => {
  const operations = extractBackendResolverFields(HR_SOURCE_ROOT).filter(
    (field) => field.kind !== 'ResolveField',
  );
  const where = (operation: BackendResolverField): string =>
    `${operation.kind} ${operation.field} (${operation.file}:${operation.line})`;

  it('finds a plausible operation surface (guards against silent extractor rot)', () => {
    expect(operations.length).toBeGreaterThan(150);
    for (const canary of [
      'employees',
      'weeklyPlans',
      'performanceReview',
      'clockIn',
      'hrLabourCost',
    ]) {
      expect(operations.map((operation) => operation.field)).toContain(canary);
    }
  });

  it('the scan sees every operation the resolvers declare', () => {
    // An operation the decorator scan cannot parse would escape every check below.
    const declared = listFiles(HR_SOURCE_ROOT, ['**/*.ts'])
      .filter((file) => !file.includes('.spec.') && !file.includes('__tests__'))
      .reduce(
        (count, file) =>
          count +
          (readFileSync(join(REPO_ROOT, file), 'utf8').match(
            /^\s*@(Query|Mutation|Subscription)\s*\(/gm,
          )?.length ?? 0),
        0,
      );

    expect(operations.length).toBe(declared);
  });

  it('every operation declares its gate on the operation itself', () => {
    const ungated = operations.filter((operation) => gateOf(operation) === 'none').map(where);

    expect(
      ungated.length === 0
        ? ''
        : `\n${ungated.length} hr-service operation(s) declare no gate, so every authenticated user may call them:\n` +
            `  ${ungated.join('\n  ')}\n` +
            'Add @UseGuards(RolesGuard) @Roles(Role.TENANT_ADMIN, Role.MODULE_MANAGER), or @ModuleUserOrHigher() for a call about the caller or reference data.\n',
    ).toBe('');
  });

  it('no operation is public, and no resolver declares a gate on the class', () => {
    expect(operations.filter((operation) => gateOf(operation) === 'public').map(where)).toEqual([]);

    // A class-level decorator reaches every method through RolesGuard's handler-then-class lookup,
    // where the operation scan cannot see it.
    const classLevel = [...new Set(operations.map((operation) => operation.file))].filter((file) =>
      /^(@Public|@Roles)\s*\(/m.test(readFileSync(join(REPO_ROOT, file), 'utf8')),
    );
    expect(classLevel).toEqual([]);
  });

  it('an operation open to every staff member is a listed decision, with its reason', () => {
    const unlisted = operations
      .filter((operation) => gateOf(operation) === 'any-staff' && !(operation.field in ANY_STAFF))
      .map(where);

    expect(
      unlisted.length === 0
        ? ''
        : `\n${unlisted.length} operation(s) are open to all staff but not listed in ANY_STAFF:\n` +
            `  ${unlisted.join('\n  ')}\n` +
            "If it returns or changes another person's data, gate it to managers; otherwise list it with the reason.\n",
    ).toBe('');
  });

  it('ANY_STAFF holds no stale entry', () => {
    const openToAll = new Set(
      operations.filter((operation) => gateOf(operation) === 'any-staff').map((o) => o.field),
    );
    const stale = Object.keys(ANY_STAFF).filter((name) => !openToAll.has(name));

    expect(stale).toEqual([]);
  });

  it('a name is one operation: two resolvers serving one field would make the gate ambiguous', () => {
    const seen = new Map<string, number>();
    for (const operation of operations) {
      seen.set(operation.field, (seen.get(operation.field) ?? 0) + 1);
    }

    expect([...seen].filter(([, count]) => count > 1).map(([name]) => name)).toEqual([]);
  });

  it('contact details are redacted on the Employee type, not left to each operation', () => {
    const typeFields = extractBackendResolverFields(HR_SOURCE_ROOT).filter(
      (field) =>
        field.kind === 'ResolveField' && field.file.endsWith('hr/employee-fields.resolver.ts'),
    );

    expect(typeFields.map((field) => field.field).sort()).toEqual(
      expect.arrayContaining(['address', 'contactInfo']),
    );
  });
});
