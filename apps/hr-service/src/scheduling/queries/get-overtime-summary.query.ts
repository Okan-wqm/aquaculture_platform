import type { HrModuleCode } from '../../common/enums';

export class GetOvertimeSummaryQuery {
  constructor(
    public readonly tenantId: string,
    public readonly month: number,
    public readonly year: number,
    public readonly employeeId?: string,
    public readonly departmentId?: string,
    /** Only plans of employees whose live department is in this module; absent = every module. */
    public readonly moduleCode?: HrModuleCode,
  ) {}
}
