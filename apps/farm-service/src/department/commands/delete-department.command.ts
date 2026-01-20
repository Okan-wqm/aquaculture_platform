/**
 * Delete Department Command
 */
export class DeleteDepartmentCommand {
  constructor(
    public readonly departmentId: string,
    public readonly tenantId: string,
    public readonly userId: string,
    public readonly cascade: boolean = false,
  ) {}
}
