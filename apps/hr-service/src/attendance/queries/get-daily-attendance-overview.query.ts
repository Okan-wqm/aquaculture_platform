import type { HrModuleCode } from '../../common/enums';

export class GetDailyAttendanceOverviewQuery {
  constructor(
    public readonly tenantId: string,
    public readonly date?: string,
    /** Count only employees whose live department is in this module; absent = every module. */
    public readonly moduleCode?: HrModuleCode,
  ) {}
}
