import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, QueryRunner } from 'typeorm';
import { NotFoundException, BadRequestException, Logger, InternalServerErrorException } from '@nestjs/common';
import { UpdatePlanEntryCommand } from '../commands/update-plan-entry.command';
import { WeeklyPlanEntry, WeeklyPlanEntryType } from '../entities/weekly-plan-entry.entity';
import { WeeklyPlan, WeeklyPlanStatus } from '../entities/weekly-plan.entity';
import { Shift } from '../../attendance/entities/shift.entity';
import { SchedulingSettings } from '../entities/scheduling-settings.entity';
import { resolvePlanEntryCustomTimeRange } from '../plan-entry-time';

@CommandHandler(UpdatePlanEntryCommand)
export class UpdatePlanEntryHandler implements ICommandHandler<UpdatePlanEntryCommand> {
  private readonly logger = new Logger(UpdatePlanEntryHandler.name);

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

  async execute(command: UpdatePlanEntryCommand): Promise<WeeklyPlanEntry> {
    const {
      tenantId,
      userId,
      entryId,
      shiftId,
      isOffDay,
      plannedStartTime,
      plannedEndTime,
      entryType,
      notes,
    } = command;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Find the entry
      const entry = await queryRunner.manager.findOne(WeeklyPlanEntry, {
        where: { id: entryId, tenantId },
        relations: ['weeklyPlan'],
      });

      if (!entry) {
        throw new NotFoundException(`Entry with ID ${entryId} not found`);
      }

      // SECURITY: Guard against editing CLOSED or PUBLISHED plans.
      // HR-HIGH-001: S1 regression — the handler only blocked PUBLISHED but not CLOSED.
      // Both terminal states must be structurally non-editable.
      const nonEditableStatuses: WeeklyPlanStatus[] = [
        WeeklyPlanStatus.PUBLISHED,
        WeeklyPlanStatus.CLOSED,
      ];
      if (nonEditableStatuses.includes(entry.weeklyPlan.status)) {
        throw new BadRequestException(
          `Cannot modify entries of a plan with status "${entry.weeklyPlan.status}". Only DRAFT plans are editable.`,
        );
      }

      // If leave day, cannot modify
      if (entry.isLeaveDay && !entryType) {
        throw new BadRequestException('Cannot modify leave day entry');
      }

      // Update entry based on provided values
      if (isOffDay !== undefined) {
        entry.isOffDay = isOffDay;
        if (isOffDay) {
          entry.shiftId = undefined;
          entry.plannedMinutes = 0;
          entry.entryType = WeeklyPlanEntryType.OFF;
        }
      }

      if (shiftId !== undefined) {
        if (shiftId === null || shiftId === '') {
          // Mark as off day
          entry.shiftId = undefined;
          entry.plannedMinutes = 0;
          entry.isOffDay = true;
          entry.entryType = entryType || WeeklyPlanEntryType.OFF;
        } else {
          // Assign shift
          const shift = await queryRunner.manager.findOne(Shift, {
            where: { id: shiftId, tenantId, isActive: true, isDeleted: false },
          });

          if (!shift) {
            throw new NotFoundException(`Shift with ID ${shiftId} not found`);
          }

          entry.shiftId = shiftId;
          entry.isOffDay = false;
          entry.entryType = entryType || WeeklyPlanEntryType.WORK;

          // Calculate planned minutes based on custom times or shift defaults
          if (plannedStartTime && plannedEndTime) {
            Object.assign(
              entry,
              resolvePlanEntryCustomTimeRange(entry.date, plannedStartTime, plannedEndTime),
            );
          } else {
            entry.plannedStartTime = undefined;
            entry.plannedEndTime = undefined;
            entry.plannedMinutes = shift.totalMinutes;
          }
        }
      } else if (plannedStartTime && plannedEndTime) {
        // Update custom times without changing shift
        Object.assign(
          entry,
          resolvePlanEntryCustomTimeRange(entry.date, plannedStartTime, plannedEndTime),
        );
      }

      if (entryType !== undefined) {
        entry.entryType = entryType;
      }

      if (notes !== undefined) {
        entry.notes = notes;
      }

      await queryRunner.manager.save(WeeklyPlanEntry, entry);

      // Recalculate plan totals within the same transaction
      await this.recalculatePlanTotalsInTransaction(queryRunner, entry.weeklyPlanId, tenantId, userId);

      await queryRunner.commitTransaction();

      // Reload with shift - SECURITY: Include tenantId for defense in depth
      return this.entryRepository.findOne({
        where: { id: entryId, tenantId },
        relations: ['shift'],
      }) as Promise<WeeklyPlanEntry>;
    } catch (error) {
      await queryRunner.rollbackTransaction();

      // Re-throw known exceptions as-is
      if (error instanceof NotFoundException || error instanceof BadRequestException) {
        throw error;
      }

      // Wrap unknown errors
      this.logger.error(`Failed to update plan entry: ${(error as Error).message}`, (error as Error).stack);
      throw new InternalServerErrorException('Failed to update plan entry');
    } finally {
      await queryRunner.release();
    }
  }

  private async recalculatePlanTotalsInTransaction(
    queryRunner: QueryRunner,
    planId: string,
    tenantId: string,
    userId: string,
  ): Promise<void> {
    const entries = await queryRunner.manager.find(WeeklyPlanEntry, {
      where: { weeklyPlanId: planId, tenantId },
    });

    let plannedWorkDays = 0;
    let plannedOffDays = 0;
    let plannedTotalMinutes = 0;

    for (const entry of entries) {
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
      { id: planId, tenantId },
      {
        plannedWorkDays,
        plannedOffDays,
        plannedTotalMinutes,
        plannedOvertimeMinutes: Math.max(0, plannedTotalMinutes - standardMinutes),
        updatedBy: userId,
      },
    );
  }
}
