import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { QueryHandler, IQueryHandler } from '@nestjs/cqrs';
import { ObjectType, Field, Int, Float } from '@nestjs/graphql';
import { GetHRDashboardStatsQuery } from '../queries/get-hr-dashboard-stats.query';

@ObjectType()
export class HRDashboardStats {
  @Field(() => Int)
  totalEmployees!: number;

  @Field(() => Int)
  activeEmployees!: number;

  @Field(() => Int)
  onLeaveEmployees!: number;

  @Field(() => Int)
  terminatedEmployees!: number;

  @Field(() => Int)
  newHiresThisMonth!: number;

  @Field(() => Int)
  offshoreEmployees!: number;

  @Field(() => Int)
  onshoreEmployees!: number;

  @Field(() => Float)
  attendanceRate!: number;

  @Field(() => Int)
  pendingLeaveRequests!: number;

  @Field(() => Int)
  totalDepartments!: number;
}

@Injectable()
@QueryHandler(GetHRDashboardStatsQuery)
export class GetHRDashboardStatsHandler implements IQueryHandler<GetHRDashboardStatsQuery, HRDashboardStats> {
  constructor(
    private readonly dataSource: DataSource,
  ) {}

  async execute(query: GetHRDashboardStatsQuery): Promise<HRDashboardStats> {
    const { tenantId } = query;

    const now = new Date();
    const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const today = now.toISOString().split('T')[0];

    // Single aggregation query for employee stats
    const employeeStats = await this.dataSource.query(`
      SELECT
        COUNT(*) FILTER (WHERE "isDeleted" = false) AS "totalEmployees",
        COUNT(*) FILTER (WHERE status = 'active' AND "isDeleted" = false) AS "activeEmployees",
        COUNT(*) FILTER (WHERE status = 'on_leave' AND "isDeleted" = false) AS "onLeaveEmployees",
        COUNT(*) FILTER (WHERE status = 'terminated' AND "isDeleted" = false) AS "terminatedEmployees",
        COUNT(*) FILTER (WHERE "hireDate" >= $2 AND "isDeleted" = false) AS "newHiresThisMonth",
        COUNT(*) FILTER (WHERE "personnelCategory" = 'offshore' AND status = 'active' AND "isDeleted" = false) AS "offshoreEmployees",
        COUNT(*) FILTER (WHERE ("personnelCategory" = 'onshore' OR "personnelCategory" IS NULL) AND status = 'active' AND "isDeleted" = false) AS "onshoreEmployees"
      FROM employees
      WHERE "tenantId" = $1
    `, [tenantId, firstDayOfMonth]);

    // Attendance rate for today
    const attendanceResult = await this.dataSource.query(`
      SELECT
        COUNT(*) AS "presentCount"
      FROM attendance_records
      WHERE "tenantId" = $1 AND date = $2
    `, [tenantId, today]);

    // Pending leave requests
    const leaveResult = await this.dataSource.query(`
      SELECT COUNT(*) AS "pendingCount"
      FROM leave_requests
      WHERE "tenantId" = $1 AND status = 'pending'
    `, [tenantId]);

    // Total departments
    const deptResult = await this.dataSource.query(`
      SELECT COUNT(*) AS "deptCount"
      FROM departments_hr
      WHERE "tenantId" = $1 AND "isDeleted" = false
    `, [tenantId]);

    const stats = employeeStats[0];
    const activeCount = parseInt(stats.activeEmployees, 10) || 0;
    const presentCount = parseInt(attendanceResult[0]?.presentCount, 10) || 0;
    const attendanceRate = activeCount > 0 ? Math.round((presentCount / activeCount) * 100) : 0;

    return {
      totalEmployees: parseInt(stats.totalEmployees, 10) || 0,
      activeEmployees: activeCount,
      onLeaveEmployees: parseInt(stats.onLeaveEmployees, 10) || 0,
      terminatedEmployees: parseInt(stats.terminatedEmployees, 10) || 0,
      newHiresThisMonth: parseInt(stats.newHiresThisMonth, 10) || 0,
      offshoreEmployees: parseInt(stats.offshoreEmployees, 10) || 0,
      onshoreEmployees: parseInt(stats.onshoreEmployees, 10) || 0,
      attendanceRate,
      pendingLeaveRequests: parseInt(leaveResult[0]?.pendingCount, 10) || 0,
      totalDepartments: parseInt(deptResult[0]?.deptCount, 10) || 0,
    };
  }
}
