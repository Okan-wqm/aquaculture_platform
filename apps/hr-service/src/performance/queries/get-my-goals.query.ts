/**
 * The goals of one employee, for that employee's own "my goals" view.
 *
 * `employeeId` is an HR EMPLOYEE id (`goal.employeeId`), not the auth user id (JWT `sub`): the two
 * are different uuids linked only by `Employee.userId`, so the caller bridges the viewer to their
 * employee record first.
 */
export class GetMyGoalsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId: string,
    public readonly status?: string,
  ) {}
}
