import type { HrModuleCode } from '../../common/enums';

export class GetTeamLeaveCalendarQuery {
  constructor(
    public readonly tenantId: string,
    public readonly departmentId?: string,
    public readonly startDate: string = new Date().toISOString().split('T')[0] ?? '',
    public readonly endDate: string = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0] ?? '',
    /** Only requests of employees whose live department is in this module; absent = every module. */
    public readonly moduleCode?: HrModuleCode,
  ) {}
}
