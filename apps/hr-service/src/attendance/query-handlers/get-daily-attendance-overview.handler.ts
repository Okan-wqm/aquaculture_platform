import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { ObjectType, Field, Int, Float } from '@nestjs/graphql';
import { applyEmployeeModuleScope } from '../../common/module-scope';
import { Employee } from '../../hr/entities/employee.entity';
import { AttendanceRecord } from '../entities/attendance-record.entity';
import { GetDailyAttendanceOverviewQuery } from '../queries/get-daily-attendance-overview.query';

@ObjectType()
export class DailyAttendanceOverview {
  @Field(() => Int)
  totalEmployees!: number;

  @Field(() => Int)
  present!: number;

  @Field(() => Int)
  absent!: number;

  @Field(() => Int)
  late!: number;

  @Field(() => Int)
  onLeave!: number;

  @Field(() => Int)
  offshore!: number;

  @Field(() => Float)
  attendanceRate!: number;
}

/** The attendance aggregates as the database returns them: counts arrive as strings. */
interface AttendanceStatsRow {
  presentCount: string;
  lateCount: string;
  onLeaveCount: string;
  offshoreCount: string;
  recordedCount: string;
}

@Injectable()
@QueryHandler(GetDailyAttendanceOverviewQuery)
export class GetDailyAttendanceOverviewHandler implements IQueryHandler<GetDailyAttendanceOverviewQuery, DailyAttendanceOverview> {
  constructor(
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRepository: Repository<AttendanceRecord>,
  ) {}

  async execute(query: GetDailyAttendanceOverviewQuery): Promise<DailyAttendanceOverview> {
    const { tenantId, date, moduleCode } = query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    // Both counts go through query builders so the module scope is the one
    // shared predicate (common/module-scope.ts), not a second spelling in SQL.

    // Total active employees
    const totalEmployees = await applyEmployeeModuleScope(
      this.employeeRepository
        .createQueryBuilder('employee')
        .where('employee.tenantId = :tenantId', { tenantId })
        .andWhere("employee.status = 'active'")
        .andWhere('employee.isDeleted = false'),
      'employee',
      moduleCode,
    ).getCount();

    // Attendance breakdown for the day. `employee` is joined only to give the
    // module scope its alias: a many-to-one on the primary key, so it never
    // changes a count by itself.
    const stats = await applyEmployeeModuleScope(
      this.attendanceRepository
        .createQueryBuilder('ar')
        .leftJoin('ar.employee', 'employee')
        .select("COUNT(*) FILTER (WHERE ar.status IN ('present', 'work_from_home'))", 'presentCount')
        .addSelect("COUNT(*) FILTER (WHERE ar.status = 'late')", 'lateCount')
        .addSelect("COUNT(*) FILTER (WHERE ar.status = 'on_leave')", 'onLeaveCount')
        .addSelect('COUNT(*) FILTER (WHERE ar.isOffshore = true)', 'offshoreCount')
        .addSelect('COUNT(DISTINCT ar.employeeId)', 'recordedCount')
        .where('ar.tenantId = :tenantId', { tenantId })
        .andWhere('ar.date = :targetDate', { targetDate })
        .andWhere('ar.isDeleted = false'),
      'employee',
      moduleCode,
    ).getRawOne<AttendanceStatsRow>();

    // An aggregate without GROUP BY always yields exactly one row.
    if (stats === undefined) {
      throw new InternalServerErrorException('Daily attendance aggregate returned no row');
    }

    const present = parseInt(stats.presentCount, 10) || 0;
    const late = parseInt(stats.lateCount, 10) || 0;
    const onLeave = parseInt(stats.onLeaveCount, 10) || 0;
    const offshore = parseInt(stats.offshoreCount, 10) || 0;
    const recordedCount = parseInt(stats.recordedCount, 10) || 0;
    const absent = Math.max(0, totalEmployees - recordedCount);
    const attendanceRate = totalEmployees > 0
      ? Math.round(((present + late) / totalEmployees) * 100)
      : 0;

    return {
      totalEmployees,
      present,
      absent,
      late,
      onLeave,
      offshore,
      attendanceRate,
    };
  }
}
