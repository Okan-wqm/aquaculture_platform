import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { CopyWeeklyPlanCommand } from '../commands/copy-weekly-plan.command';
import { WeeklyPlan, WeeklyPlanStatus } from '../entities/weekly-plan.entity';
import { WeeklyPlanEntry, WeeklyPlanEntryType } from '../entities/weekly-plan-entry.entity';
import { SchedulingSettings } from '../entities/scheduling-settings.entity';
import { LeaveRequest, LeaveRequestStatus } from '../../leave/entities/leave-request.entity';
import { WeekDay } from '../../attendance/entities/shift.entity';

const WEEKDAY_ORDER: WeekDay[] = [
  WeekDay.MONDAY,
  WeekDay.TUESDAY,
  WeekDay.WEDNESDAY,
  WeekDay.THURSDAY,
  WeekDay.FRIDAY,
  WeekDay.SATURDAY,
  WeekDay.SUNDAY,
];

@CommandHandler(CopyWeeklyPlanCommand)
export class CopyWeeklyPlanHandler implements ICommandHandler<CopyWeeklyPlanCommand> {
  private readonly logger = new Logger(CopyWeeklyPlanHandler.name);

  constructor(
    @InjectRepository(WeeklyPlan)
    private readonly planRepository: Repository<WeeklyPlan>,
    @InjectRepository(WeeklyPlanEntry)
    private readonly entryRepository: Repository<WeeklyPlanEntry>,
    @InjectRepository(SchedulingSettings)
    private readonly settingsRepository: Repository<SchedulingSettings>,
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: CopyWeeklyPlanCommand): Promise<WeeklyPlan> {
    const { tenantId, userId, sourceWeeklyPlanId, targetWeekStartDate } = command;

    // Validate target date
    const targetStart = new Date(targetWeekStartDate);
    if (isNaN(targetStart.getTime())) {
      throw new BadRequestException('Invalid target week start date');
    }

    if (targetStart.getDay() !== 1) {
      throw new BadRequestException('Target week start date must be a Monday');
    }

    const targetEnd = new Date(targetStart);
    targetEnd.setDate(targetEnd.getDate() + 6);

    // Find source plan
    const sourcePlan = await this.planRepository.findOne({
      where: { id: sourceWeeklyPlanId, tenantId, isDeleted: false },
      relations: ['entries'],
    });

    if (!sourcePlan) {
      throw new NotFoundException(`Source weekly plan with ID ${sourceWeeklyPlanId} not found`);
    }

    // Check for existing target plan
    const existingPlan = await this.planRepository.findOne({
      where: {
        tenantId,
        employeeId: sourcePlan.employeeId,
        weekStartDate: targetStart,
        isDeleted: false,
      },
    });

    if (existingPlan) {
      throw new BadRequestException('A weekly plan already exists for this employee and target week');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Get settings
      const settings = await queryRunner.manager.findOne(SchedulingSettings, {
        where: { tenantId },
      });

      // Get leave requests for target week
      const leaveRequests = await queryRunner.manager
        .createQueryBuilder(LeaveRequest, 'lr')
        .where('lr.tenantId = :tenantId', { tenantId })
        .andWhere('lr.employeeId = :employeeId', { employeeId: sourcePlan.employeeId })
        .andWhere('lr.status = :status', { status: LeaveRequestStatus.APPROVED })
        .andWhere('lr.startDate <= :endDate AND lr.endDate >= :startDate', {
          startDate: targetStart,
          endDate: targetEnd,
        })
        .getMany();

      // Create leave date map
      const leaveDates = new Map<string, LeaveRequest>();
      for (const lr of leaveRequests) {
        const leaveStart = new Date(lr.startDate);
        const leaveEnd = new Date(lr.endDate);
        for (let d = new Date(leaveStart); d <= leaveEnd; d.setDate(d.getDate() + 1)) {
          if (d >= targetStart && d <= targetEnd) {
            leaveDates.set(d.toISOString().split('T')[0]!, lr);
          }
        }
      }

      // Create new plan
      const newPlan = queryRunner.manager.create(WeeklyPlan, {
        tenantId,
        employeeId: sourcePlan.employeeId,
        weekStartDate: targetStart,
        weekEndDate: targetEnd,
        status: WeeklyPlanStatus.DRAFT,
        standardWeeklyMinutes: settings?.standardWeeklyMinutes ?? 2700,
        notes: `Copied from week ${sourcePlan.weekStartDate.toISOString().split('T')[0]}`,
        createdBy: userId,
        updatedBy: userId,
      });

      const savedPlan = await queryRunner.manager.save(WeeklyPlan, newPlan);

      // Create entries based on source
      const entries: WeeklyPlanEntry[] = [];
      let plannedWorkDays = 0;
      let plannedOffDays = 0;
      let plannedTotalMinutes = 0;

      const sourceEntries = sourcePlan.entries?.sort((a, b) => a.displayOrder - b.displayOrder) || [];

      for (let i = 0; i < 7; i++) {
        const entryDate = new Date(targetStart);
        entryDate.setDate(entryDate.getDate() + i);
        const dateStr = entryDate.toISOString().split('T')[0]!;
        const weekDay = WEEKDAY_ORDER[i]!;

        const sourceEntry = sourceEntries.find(e => e.dayOfWeek === weekDay);
        const leaveRequest = leaveDates.get(dateStr);

        let entryType: WeeklyPlanEntryType;
        let shiftId: string | undefined;
        let isOffDay = false;
        let plannedMinutes = 0;
        let plannedStartTime: string | undefined;
        let plannedEndTime: string | undefined;

        if (leaveRequest) {
          // Override with leave
          entryType = WeeklyPlanEntryType.LEAVE;
          plannedOffDays++;
        } else if (sourceEntry) {
          // Copy from source
          entryType = sourceEntry.entryType;
          shiftId = sourceEntry.shiftId;
          isOffDay = sourceEntry.isOffDay;
          plannedMinutes = sourceEntry.plannedMinutes;
          plannedStartTime = sourceEntry.plannedStartTime?.toISOString();
          plannedEndTime = sourceEntry.plannedEndTime?.toISOString();

          if (entryType === WeeklyPlanEntryType.WORK || entryType === WeeklyPlanEntryType.TRAINING) {
            plannedWorkDays++;
            plannedTotalMinutes += plannedMinutes;
          } else {
            plannedOffDays++;
          }
        } else {
          // Default to off
          entryType = WeeklyPlanEntryType.OFF;
          isOffDay = true;
          plannedOffDays++;
        }

        const entry = queryRunner.manager.create(WeeklyPlanEntry, {
          tenantId,
          weeklyPlanId: savedPlan.id,
          employeeId: sourcePlan.employeeId,
          date: entryDate,
          dayOfWeek: weekDay,
          shiftId,
          isOffDay,
          isLeaveDay: !!leaveRequest,
          leaveRequestId: leaveRequest?.id,
          plannedMinutes,
          plannedStartTime,
          plannedEndTime,
          entryType,
          displayOrder: i,
        });

        entries.push(entry);
      }

      await queryRunner.manager.save(WeeklyPlanEntry, entries);

      // Update plan totals
      savedPlan.plannedWorkDays = plannedWorkDays;
      savedPlan.plannedOffDays = plannedOffDays;
      savedPlan.plannedTotalMinutes = plannedTotalMinutes;
      savedPlan.plannedOvertimeMinutes = Math.max(0, plannedTotalMinutes - (settings?.standardWeeklyMinutes ?? 2700));

      await queryRunner.manager.save(WeeklyPlan, savedPlan);

      await queryRunner.commitTransaction();

      // Reload with relations - SECURITY: Include tenantId for defense in depth
      return this.planRepository.findOne({
        where: { id: savedPlan.id, tenantId },
        relations: ['entries', 'entries.shift', 'employee'],
      }) as Promise<WeeklyPlan>;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
