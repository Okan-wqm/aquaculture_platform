import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, IsNull } from 'typeorm';
import { GetCurrentlyOffshoreQuery } from '../queries/get-currently-offshore.query';
import { WorkRotation, RotationStatus, RotationType } from '../entities/work-rotation.entity';
import { AttendanceRecord } from '../../attendance/entities/attendance-record.entity';
import { Employee } from '../../hr/entities/employee.entity';

@QueryHandler(GetCurrentlyOffshoreQuery)
export class GetCurrentlyOffshoreHandler implements IQueryHandler<GetCurrentlyOffshoreQuery> {
  constructor(
    @InjectRepository(WorkRotation)
    private readonly rotationRepository: Repository<WorkRotation>,
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRepository: Repository<AttendanceRecord>,
  ) {}

  async execute(query: GetCurrentlyOffshoreQuery): Promise<Employee[]> {
    const { tenantId, workAreaId } = query;

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const queryBuilder = this.rotationRepository
      .createQueryBuilder('wr')
      .leftJoinAndSelect('wr.employee', 'employee')
      .where('wr.tenantId = :tenantId', { tenantId })
      .andWhere('wr.status = :status', { status: RotationStatus.IN_PROGRESS })
      .andWhere('wr.rotationType = :rotationType', { rotationType: RotationType.OFFSHORE })
      .andWhere('wr.startDate <= :today', { today })
      .andWhere('wr.endDate >= :today', { today })
      .andWhere('wr.isDeleted = false')
      .andWhere('employee.isDeleted = false');

    if (workAreaId) {
      queryBuilder.andWhere('wr.workAreaId = :workAreaId', { workAreaId });
    }

    const rotations = await queryBuilder.getMany();

    const scheduledEmployees = rotations
      .filter((r) => r.employee)
      .map((r) => r.employee as Employee);

    if (scheduledEmployees.length === 0) return [];

    // LOW: Cross-reference with actual attendance — only include employees
    // who have an active clock-in today (i.e., are physically present offshore)
    const employeeIds = scheduledEmployees.map((e) => e.id);

    const activeAttendance = await this.attendanceRepository
      .createQueryBuilder('ar')
      .select('ar.employeeId')
      .where('ar.tenantId = :tenantId', { tenantId })
      .andWhere('ar.date = :today', { today })
      .andWhere('ar.clockIn IS NOT NULL')
      .andWhere('ar.clockOut IS NULL')
      .andWhere('ar.isDeleted = false')
      .andWhere('ar.isOffshore = true')
      .andWhere('ar.employeeId IN (:...employeeIds)', { employeeIds })
      .getRawMany();

    const activeEmployeeIds = new Set(activeAttendance.map((a: any) => a.ar_employeeId));

    // Return all scheduled employees but annotate which are confirmed present.
    // For backwards compatibility, return all scheduled offshore employees,
    // but prioritize those with active clock-in by placing them first.
    return [
      ...scheduledEmployees.filter((e) => activeEmployeeIds.has(e.id)),
      ...scheduledEmployees.filter((e) => !activeEmployeeIds.has(e.id)),
    ];
  }
}
