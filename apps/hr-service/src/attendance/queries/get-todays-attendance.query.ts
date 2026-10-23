import type { HrModuleCode } from '../../common/enums';

export class GetTodaysAttendanceQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId?: string,
    /** Only records of employees whose live department is in this module; absent = every module. */
    public readonly moduleCode?: HrModuleCode,
  ) {}
}
