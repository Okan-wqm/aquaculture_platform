import type { HrModuleCode } from '../../common/enums';

export class GetTeamWeeklyOverviewQuery {
  constructor(
    public readonly tenantId: string,
    public readonly weekStartDate: string,
    public readonly departmentId?: string,
    public readonly siteId?: string,
    /** Only employees whose live department is in this module; absent = every module. */
    public readonly moduleCode?: HrModuleCode,
  ) {}
}
