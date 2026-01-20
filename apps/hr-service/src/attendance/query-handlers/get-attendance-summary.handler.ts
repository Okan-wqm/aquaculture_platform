import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import { GetAttendanceSummaryQuery } from '../queries/get-attendance-summary.query';
import { AttendanceRecord, AttendanceStatus } from '../entities/attendance-record.entity';
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

    const records = await this.attendanceRepository.find({
      where: {
        tenantId,
        employeeId,
        date: Between(startDate, endDate),
        isDeleted: false,
      },
    });

    // Calculate summary
    const summary: AttendanceSummary = {
      employeeId,
      month,
      year,
      totalWorkDays: records.length,
      presentDays: 0,
      absentDays: 0,
      lateDays: 0,
      earlyLeaveDays: 0,
      leaveDays: 0,
      holidayDays: 0,
      offshoreDays: 0,
      totalWorkedMinutes: 0,
      totalOvertimeMinutes: 0,
      totalLateMinutes: 0,
      attendanceRate: 0,
    };

    for (const record of records) {
      summary.totalWorkedMinutes += record.workedMinutes || 0;
      summary.totalOvertimeMinutes += record.overtimeMinutes || 0;
      summary.totalLateMinutes += record.lateMinutes || 0;

      switch (record.status) {
        case AttendanceStatus.PRESENT:
          summary.presentDays++;
          break;
        case AttendanceStatus.ABSENT:
          summary.absentDays++;
          break;
        case AttendanceStatus.LATE:
          summary.lateDays++;
          summary.presentDays++; // Late is still present
          break;
        case AttendanceStatus.EARLY_LEAVE:
          summary.earlyLeaveDays++;
          summary.presentDays++;
          break;
        case AttendanceStatus.ON_LEAVE:
          summary.leaveDays++;
          break;
        case AttendanceStatus.HOLIDAY:
          summary.holidayDays++;
          break;
        case AttendanceStatus.OFFSHORE:
          summary.offshoreDays++;
          summary.presentDays++;
          break;
        case AttendanceStatus.WORK_FROM_HOME:
          summary.presentDays++;
          break;
      }
    }

    // Calculate attendance rate (excluding holidays and leave)
    const accountableDays = summary.totalWorkDays - summary.holidayDays - summary.leaveDays;
    if (accountableDays > 0) {
      summary.attendanceRate = (summary.presentDays / accountableDays) * 100;
    }

    return summary;
  }
}
