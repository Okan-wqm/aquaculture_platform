import type { HrModuleCode } from '../../common/enums';
import { AttendanceStatus, ApprovalStatus } from '../entities/attendance-record.entity';

export class GetAttendanceRecordsQuery {
  constructor(
    public readonly tenantId: string,
    public readonly employeeId?: string,
    public readonly departmentId?: string,
    public readonly status?: AttendanceStatus,
    public readonly approvalStatus?: ApprovalStatus,
    public readonly startDate?: string,
    public readonly endDate?: string,
    public readonly limit?: number,
    public readonly page?: number,
    /** Only records of employees whose live department is in this module; absent = every module. */
    public readonly moduleCode?: HrModuleCode,
  ) {}
}
