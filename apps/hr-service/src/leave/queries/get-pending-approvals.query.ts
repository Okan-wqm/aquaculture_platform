import type { OwnerModuleCode } from '@aquaculture/shared-contracts';

export class GetPendingApprovalsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly approverId: string | null,
    public readonly departmentId?: string,
    public readonly limit: number = 20,
    public readonly page: number = 1,
    /** Only requests of employees whose live department is in this module; absent = every module. */
    public readonly moduleCode?: OwnerModuleCode,
    /**
     * With no explicit department and no module, narrow to the approver's own department.
     * False for a tenant admin, who approves across departments and is never narrowed implicitly.
     */
    public readonly narrowToOwnDepartment: boolean = true,
  ) {}
}
