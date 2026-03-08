import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { ObjectType, Field, Int, Float } from '@nestjs/graphql';
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

@Injectable()
@QueryHandler(GetDailyAttendanceOverviewQuery)
export class GetDailyAttendanceOverviewHandler implements IQueryHandler<GetDailyAttendanceOverviewQuery, DailyAttendanceOverview> {
  constructor(
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetDailyAttendanceOverviewQuery): Promise<DailyAttendanceOverview> {
    const { tenantId, date } = query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    // Total active employees
    const empResult = await this.dataSource.query(`
      SELECT COUNT(*) AS "totalCount"
      FROM employees
      WHERE "tenantId" = $1 AND status = 'active' AND "isDeleted" = false
    `, [tenantId]);

    const totalEmployees = parseInt(empResult[0]?.totalCount, 10) || 0;

    // Attendance breakdown for the day
    const attResult = await this.dataSource.query(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('present', 'work_from_home')) AS "presentCount",
        COUNT(*) FILTER (WHERE status = 'late') AS "lateCount",
        COUNT(*) FILTER (WHERE status = 'on_leave') AS "onLeaveCount",
        COUNT(*) FILTER (WHERE "isOffshore" = true) AS "offshoreCount",
        COUNT(DISTINCT "employeeId") AS "recordedCount"
      FROM attendance_records
      WHERE "tenantId" = $1 AND date = $2 AND "isDeleted" = false
    `, [tenantId, targetDate]);

    const stats = attResult[0];
    const present = parseInt(stats?.presentCount, 10) || 0;
    const late = parseInt(stats?.lateCount, 10) || 0;
    const onLeave = parseInt(stats?.onLeaveCount, 10) || 0;
    const offshore = parseInt(stats?.offshoreCount, 10) || 0;
    const recordedCount = parseInt(stats?.recordedCount, 10) || 0;
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
