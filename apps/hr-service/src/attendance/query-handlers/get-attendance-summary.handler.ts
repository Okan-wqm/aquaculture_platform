import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetAttendanceSummaryQuery } from '../queries/get-attendance-summary.query';
import { AttendanceRecord } from '../entities/attendance-record.entity';
import { ObjectType, Field, Int, Float } from '@nestjs/graphql';

@ObjectType()
export class AttendanceSummary {
  @Field()
  employeeId!: string;

  @Field(() => Int)
  month!: number;

  @Field(() => Int)
  year!: number;

  @Field(() => Int)
  totalWorkDays!: number;

  @Field(() => Int)
  presentDays!: number;

  @Field(() => Int)
  absentDays!: number;

  @Field(() => Int)
  lateDays!: number;

  @Field(() => Int)
  earlyLeaveDays!: number;

  @Field(() => Int)
  leaveDays!: number;

  @Field(() => Int)
  holidayDays!: number;

  @Field(() => Int)
  offshoreDays!: number;

  @Field(() => Int)
  totalWorkedMinutes!: number;

  @Field(() => Int)
  totalOvertimeMinutes!: number;

  @Field(() => Int)
  totalLateMinutes!: number;

  @Field(() => Float)
  attendanceRate!: number; // Percentage
}

@QueryHandler(GetAttendanceSummaryQuery)
export class GetAttendanceSummaryHandler implements IQueryHandler<GetAttendanceSummaryQuery> {
  constructor(
    @InjectRepository(AttendanceRecord)
    private readonly attendanceRepository: Repository<AttendanceRecord>,
  ) {}

  async execute(query: GetAttendanceSummaryQuery): Promise<AttendanceSummary> {
    const { tenantId, employeeId, month, year } = query;

    // Calculate date range for the month
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0); // Last day of month

    // Use a single aggregate SQL query instead of loading all rows into memory.
    // FILTER expressions are evaluated on the DB side; zero row data is transferred.
    // HALF_DAY counts as 0.5 present + 0.5 leave, so it is handled via separate
    // weighted sums rather than a simple FILTER count.
    const raw = await this.attendanceRepository
      .createQueryBuilder('ar')
      .select([
        'COUNT(*) AS "totalWorkDays"',
        'COALESCE(SUM(ar.workedMinutes), 0) AS "totalWorkedMinutes"',
        'COALESCE(SUM(ar.overtimeMinutes), 0) AS "totalOvertimeMinutes"',
        'COALESCE(SUM(ar.lateMinutes), 0) AS "totalLateMinutes"',
        // present: PRESENT + LATE + EARLY_LEAVE + OFFSHORE + WORK_FROM_HOME + 0.5 * HALF_DAY
        `COALESCE(COUNT(*) FILTER (WHERE ar.status IN ('present','late','early_leave','offshore','work_from_home')), 0) + COALESCE(COUNT(*) FILTER (WHERE ar.status = 'half_day'), 0) * 0.5 AS "presentDays"`,
        `COALESCE(COUNT(*) FILTER (WHERE ar.status = 'absent'), 0) AS "absentDays"`,
        `COALESCE(COUNT(*) FILTER (WHERE ar.status = 'late'), 0) AS "lateDays"`,
        `COALESCE(COUNT(*) FILTER (WHERE ar.status = 'early_leave'), 0) AS "earlyLeaveDays"`,
        // leaveDays: ON_LEAVE + 0.5 * HALF_DAY
        `COALESCE(COUNT(*) FILTER (WHERE ar.status = 'on_leave'), 0) + COALESCE(COUNT(*) FILTER (WHERE ar.status = 'half_day'), 0) * 0.5 AS "leaveDays"`,
        `COALESCE(COUNT(*) FILTER (WHERE ar.status = 'holiday'), 0) AS "holidayDays"`,
        `COALESCE(COUNT(*) FILTER (WHERE ar.status = 'offshore'), 0) AS "offshoreDays"`,
      ])
      .where('ar.tenantId = :tenantId', { tenantId })
      .andWhere('ar.employeeId = :employeeId', { employeeId })
      .andWhere('ar.date BETWEEN :startDate AND :endDate', { startDate, endDate })
      .andWhere('ar.isDeleted = false')
      .getRawOne<{
        totalWorkDays: string;
        totalWorkedMinutes: string;
        totalOvertimeMinutes: string;
        totalLateMinutes: string;
        presentDays: string;
        absentDays: string;
        lateDays: string;
        earlyLeaveDays: string;
        leaveDays: string;
        holidayDays: string;
        offshoreDays: string;
      }>();

    const totalWorkDays = Number(raw?.totalWorkDays ?? 0);
    const presentDays = Number(raw?.presentDays ?? 0);
    const holidayDays = Number(raw?.holidayDays ?? 0);
    const leaveDays = Number(raw?.leaveDays ?? 0);

    const accountableDays = totalWorkDays - holidayDays - leaveDays;
    const attendanceRate = accountableDays > 0 ? (presentDays / accountableDays) * 100 : 0;

    return {
      employeeId,
      month,
      year,
      totalWorkDays,
      presentDays,
      absentDays: Number(raw?.absentDays ?? 0),
      lateDays: Number(raw?.lateDays ?? 0),
      earlyLeaveDays: Number(raw?.earlyLeaveDays ?? 0),
      leaveDays,
      holidayDays,
      offshoreDays: Number(raw?.offshoreDays ?? 0),
      totalWorkedMinutes: Number(raw?.totalWorkedMinutes ?? 0),
      totalOvertimeMinutes: Number(raw?.totalOvertimeMinutes ?? 0),
      totalLateMinutes: Number(raw?.totalLateMinutes ?? 0),
      attendanceRate,
    };
  }
}
