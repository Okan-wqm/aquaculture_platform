import type { HrModuleCode } from '../../common/enums';

/**
 * The attendance records waiting for an approver's review.
 *
 * `approverId` is the approver's HR EMPLOYEE id, never the auth user id (JWT sub): the handler
 * excludes that employee's own records and looks their department up by it. It is null when the
 * viewer has no employee record (a tenant owner often has none); the queue then has nothing of the
 * viewer's to exclude and no department of theirs to narrow by.
 *
 * Which department the queue narrows to — the explicit `departmentId`, else the `moduleCode`, else,
 * with `narrowToOwnDepartment`, the approver's own department — is common/approval-scope.ts, the
 * one rule shared with the leave approvals queue. With none of them it lists every department. The
 * module scope still applies beside an explicit department.
 */
export class GetPendingAttendanceApprovalsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly approverId: string | null,
    public readonly departmentId?: string,
    public readonly limit: number = 20,
    public readonly page: number = 1,
    /** Only records of employees whose live department is in this module; absent = every module. */
    public readonly moduleCode?: HrModuleCode,
    /**
     * With no explicit department and no module, narrow to the approver's own department.
     * False for a tenant admin, who approves across departments and is never narrowed implicitly.
     */
    public readonly narrowToOwnDepartment: boolean = true,
  ) {}
}
