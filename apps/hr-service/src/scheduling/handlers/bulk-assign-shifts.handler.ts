import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { BulkAssignShiftsCommand } from '../commands/bulk-assign-shifts.command';
import { WeeklyPlanEntry, WeeklyPlanEntryType } from '../entities/weekly-plan-entry.entity';
import { WeeklyPlan, WeeklyPlanStatus } from '../entities/weekly-plan.entity';
import { Shift } from '../../attendance/entities/shift.entity';
import { SchedulingSettings } from '../entities/scheduling-settings.entity';

export interface BulkAssignResult {
  success: boolean;
  updatedCount: number;
  errors: string[];
}

@CommandHandler(BulkAssignShiftsCommand)
export class BulkAssignShiftsHandler implements ICommandHandler<BulkAssignShiftsCommand> {
  private readonly logger = new Logger(BulkAssignShiftsHandler.name);

  constructor(
    @InjectRepository(WeeklyPlanEntry)
    private readonly entryRepository: Repository<WeeklyPlanEntry>,
    @InjectRepository(WeeklyPlan)
    private readonly planRepository: Repository<WeeklyPlan>,
    @InjectRepository(Shift)
    private readonly shiftRepository: Repository<Shift>,
    @InjectRepository(SchedulingSettings)
    private readonly settingsRepository: Repository<SchedulingSettings>,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: BulkAssignShiftsCommand): Promise<BulkAssignResult> {
    const { tenantId, userId, weeklyPlanId, assignments } = command;

    // Find the plan
    const plan = await this.planRepository.findOne({
      where: { id: weeklyPlanId, tenantId, isDeleted: false },
    });

    if (!plan) {
      throw new NotFoundException(`Weekly plan with ID ${weeklyPlanId} not found`);
    }

    if (plan.status === WeeklyPlanStatus.PUBLISHED) {
      throw new BadRequestException('Cannot modify entries of a published plan');
    }

    const errors: string[] = [];
    let updatedCount = 0;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Pre-load all shifts needed
      const shiftIds = [...new Set(assignments.filter(a => a.shiftId).map(a => a.shiftId!))];
      const shifts = new Map<string, Shift>();

      if (shiftIds.length > 0) {
        const loadedShifts = await queryRunner.manager.find(Shift, {
          where: shiftIds.map(id => ({ id, tenantId, isActive: true, isDeleted: false })),
        });
        for (const shift of loadedShifts) {
          shifts.set(shift.id, shift);
        }
      }

      // Process each assignment
      for (const assignment of assignments) {
        const entryDate = new Date(assignment.date);

        const entry = await queryRunner.manager.findOne(WeeklyPlanEntry, {
          where: {
            weeklyPlanId,
            tenantId,
            date: entryDate,
          },
        });

        if (!entry) {
          errors.push(`Entry not found for date ${assignment.date}`);
          continue;
        }

        // Skip leave days
        if (entry.isLeaveDay) {
          errors.push(`Cannot modify leave day: ${assignment.date}`);
          continue;
        }

        if (assignment.isOffDay) {
          entry.shiftId = undefined;
          entry.isOffDay = true;
          entry.plannedMinutes = 0;
          entry.entryType = WeeklyPlanEntryType.OFF;
          entry.plannedStartTime = undefined;
          entry.plannedEndTime = undefined;
        } else if (assignment.shiftId) {
          const shift = shifts.get(assignment.shiftId);
          if (!shift) {
            errors.push(`Shift ${assignment.shiftId} not found for date ${assignment.date}`);
            continue;
          }

          entry.shiftId = assignment.shiftId;
          entry.isOffDay = false;
          entry.plannedMinutes = shift.totalMinutes;
          entry.entryType = WeeklyPlanEntryType.WORK;
          entry.plannedStartTime = undefined;
          entry.plannedEndTime = undefined;
        }

        await queryRunner.manager.save(WeeklyPlanEntry, entry);
        updatedCount++;
      }

      // Recalculate plan totals
      const allEntries = await queryRunner.manager.find(WeeklyPlanEntry, {
        where: { weeklyPlanId, tenantId },
      });

      let plannedWorkDays = 0;
      let plannedOffDays = 0;
      let plannedTotalMinutes = 0;

      for (const entry of allEntries) {
        if (entry.entryType === WeeklyPlanEntryType.WORK || entry.entryType === WeeklyPlanEntryType.TRAINING) {
          plannedWorkDays++;
          plannedTotalMinutes += entry.plannedMinutes;
        } else {
          plannedOffDays++;
        }
      }

      const settings = await queryRunner.manager.findOne(SchedulingSettings, { where: { tenantId } });
      const standardMinutes = settings?.standardWeeklyMinutes ?? 2700;

      // SECURITY: Include tenantId in WHERE clause for defense in depth
      await queryRunner.manager.update(
        WeeklyPlan,
        { id: weeklyPlanId, tenantId },
        {
          plannedWorkDays,
          plannedOffDays,
          plannedTotalMinutes,
          plannedOvertimeMinutes: Math.max(0, plannedTotalMinutes - standardMinutes),
          updatedBy: userId,
        },
      );

      await queryRunner.commitTransaction();

      return {
        success: errors.length === 0,
        updatedCount,
        errors,
      };
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
