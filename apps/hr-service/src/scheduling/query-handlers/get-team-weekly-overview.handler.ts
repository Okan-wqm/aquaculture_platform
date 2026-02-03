import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetTeamWeeklyOverviewQuery } from '../queries/get-team-weekly-overview.query';
import { WeeklyPlan } from '../entities/weekly-plan.entity';
import { WeeklyPlanEntry, WeeklyPlanEntryType } from '../entities/weekly-plan-entry.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { ObjectType, Field, Int, ID } from '@nestjs/graphql';
import { WeekDay } from '../../attendance/entities/shift.entity';

@ObjectType()
export class DayEntry {
  @Field(() => WeekDay)
  dayOfWeek!: WeekDay;

  @Field()
  date!: string;

  @Field(() => WeeklyPlanEntryType)
  entryType!: WeeklyPlanEntryType;

  @Field({ nullable: true })
  shiftCode?: string;

  @Field({ nullable: true })
  shiftName?: string;

  @Field({ nullable: true })
  startTime?: string;

  @Field({ nullable: true })
  endTime?: string;

  @Field(() => Int)
  plannedMinutes!: number;
}

@ObjectType()
export class EmployeeWeekSummary {
  @Field(() => ID)
  employeeId!: string;

  @Field()
  employeeName!: string;

  @Field({ nullable: true })
  position?: string;

  @Field(() => ID, { nullable: true })
  weeklyPlanId?: string;

  @Field({ nullable: true })
  planStatus?: string;

  @Field(() => [DayEntry])
  days!: DayEntry[];

  @Field(() => Int)
  totalWorkDays!: number;

  @Field(() => Int)
  totalMinutes!: number;

  @Field(() => Int)
  overtimeMinutes!: number;
}

@ObjectType()
export class DaySummary {
  @Field(() => WeekDay)
  dayOfWeek!: WeekDay;

  @Field()
  date!: string;

  @Field(() => Int)
  workingCount!: number;

  @Field(() => Int)
  offCount!: number;

  @Field(() => Int)
  leaveCount!: number;
}

@ObjectType()
export class TeamWeeklyOverview {
  @Field()
  weekStartDate!: string;

  @Field()
  weekEndDate!: string;

  @Field(() => Int)
  totalEmployees!: number;

  @Field(() => [EmployeeWeekSummary])
  employeePlans!: EmployeeWeekSummary[];

  @Field(() => [DaySummary])
  daysSummary!: DaySummary[];
}

const WEEKDAY_ORDER: WeekDay[] = [
  WeekDay.MONDAY,
  WeekDay.TUESDAY,
  WeekDay.WEDNESDAY,
  WeekDay.THURSDAY,
  WeekDay.FRIDAY,
  WeekDay.SATURDAY,
  WeekDay.SUNDAY,
];

// Maximum employees to return to prevent performance issues
const MAX_EMPLOYEES = 200;

@QueryHandler(GetTeamWeeklyOverviewQuery)
export class GetTeamWeeklyOverviewHandler implements IQueryHandler<GetTeamWeeklyOverviewQuery> {
  constructor(
    @InjectRepository(WeeklyPlan)
    private readonly planRepository: Repository<WeeklyPlan>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
  ) {}

  async execute(query: GetTeamWeeklyOverviewQuery): Promise<TeamWeeklyOverview> {
    const { tenantId, weekStartDate, departmentId, siteId } = query;

    const startDate = new Date(weekStartDate);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 6);

    // Get employees
    const employeeQb = this.employeeRepository
      .createQueryBuilder('e')
      .where('e.tenantId = :tenantId', { tenantId })
      .andWhere('e.isDeleted = false')
      .andWhere("e.status = 'active'");

    if (departmentId) {
      employeeQb.andWhere('e.departmentHrId = :departmentId', { departmentId });
    }

    if (siteId) {
      employeeQb.andWhere('e.farmId = :siteId', { siteId });
    }

    employeeQb
      .orderBy('e.firstName', 'ASC')
      .addOrderBy('e.lastName', 'ASC')
      .take(MAX_EMPLOYEES); // Limit employees to prevent performance issues

    const employees = await employeeQb.getMany();

    // Get weekly plans for these employees
    const employeeIds = employees.map(e => e.id);

    const plans = employeeIds.length > 0
      ? await this.planRepository
          .createQueryBuilder('wp')
          .leftJoinAndSelect('wp.entries', 'entries')
          .leftJoinAndSelect('entries.shift', 'shift')
          .where('wp.tenantId = :tenantId', { tenantId })
          .andWhere('wp.employeeId IN (:...employeeIds)', { employeeIds })
          .andWhere('wp.weekStartDate = :weekStartDate', { weekStartDate: startDate })
          .andWhere('wp.isDeleted = false')
          .getMany()
      : [];

    const plansByEmployee = new Map<string, WeeklyPlan>();
    for (const plan of plans) {
      plansByEmployee.set(plan.employeeId, plan);
    }

    // Build day summaries
    const daySummaries: DaySummary[] = [];
    const dayCounters: Map<WeekDay, { working: number; off: number; leave: number }> = new Map();

    for (const day of WEEKDAY_ORDER) {
      dayCounters.set(day, { working: 0, off: 0, leave: 0 });
    }

    // Build employee summaries
    const employeePlans: EmployeeWeekSummary[] = [];

    for (const employee of employees) {
      const plan = plansByEmployee.get(employee.id);
      const days: DayEntry[] = [];
      let totalWorkDays = 0;
      let totalMinutes = 0;

      for (let i = 0; i < 7; i++) {
        const entryDate = new Date(startDate);
        entryDate.setDate(entryDate.getDate() + i);
        const dateStr = entryDate.toISOString().split('T')[0]!;
        const weekDay = WEEKDAY_ORDER[i]!;

        const entry = plan?.entries?.find(e => e.dayOfWeek === weekDay);
        const counters = dayCounters.get(weekDay)!;

        let dayEntry: DayEntry;

        if (entry) {
          dayEntry = {
            dayOfWeek: weekDay,
            date: dateStr,
            entryType: entry.entryType,
            shiftCode: entry.shift?.code,
            shiftName: entry.shift?.name,
            startTime: entry.plannedStartTime || entry.shift?.startTime,
            endTime: entry.plannedEndTime || entry.shift?.endTime,
            plannedMinutes: entry.plannedMinutes,
          };

          if (entry.entryType === WeeklyPlanEntryType.WORK || entry.entryType === WeeklyPlanEntryType.TRAINING) {
            totalWorkDays++;
            totalMinutes += entry.plannedMinutes;
            counters.working++;
          } else if (entry.entryType === WeeklyPlanEntryType.LEAVE) {
            counters.leave++;
          } else {
            counters.off++;
          }
        } else {
          // No plan entry - treat as unassigned
          dayEntry = {
            dayOfWeek: weekDay,
            date: dateStr,
            entryType: WeeklyPlanEntryType.OFF,
            plannedMinutes: 0,
          };
          counters.off++;
        }

        days.push(dayEntry);
      }

      employeePlans.push({
        employeeId: employee.id,
        employeeName: `${employee.firstName} ${employee.lastName}`,
        position: employee.position,
        weeklyPlanId: plan?.id,
        planStatus: plan?.status,
        days,
        totalWorkDays,
        totalMinutes,
        overtimeMinutes: plan?.plannedOvertimeMinutes || 0,
      });
    }

    // Build day summary array
    for (let i = 0; i < 7; i++) {
      const entryDate = new Date(startDate);
      entryDate.setDate(entryDate.getDate() + i);
      const dateStr = entryDate.toISOString().split('T')[0]!;
      const weekDay = WEEKDAY_ORDER[i]!;
      const counters = dayCounters.get(weekDay)!;

      daySummaries.push({
        dayOfWeek: weekDay,
        date: dateStr,
        workingCount: counters.working,
        offCount: counters.off,
        leaveCount: counters.leave,
      });
    }

    return {
      weekStartDate: startDate.toISOString().split('T')[0]!,
      weekEndDate: endDate.toISOString().split('T')[0]!,
      totalEmployees: employees.length,
      employeePlans,
      daysSummary: daySummaries,
    };
  }
}
