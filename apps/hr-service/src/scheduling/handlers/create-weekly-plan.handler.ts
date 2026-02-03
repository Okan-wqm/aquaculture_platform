import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { CreateWeeklyPlanCommand } from '../commands/create-weekly-plan.command';
import { WeeklyPlan, WeeklyPlanStatus } from '../entities/weekly-plan.entity';
import { WeeklyPlanEntry, WeeklyPlanEntryType } from '../entities/weekly-plan-entry.entity';
import { SchedulingSettings } from '../entities/scheduling-settings.entity';
import { Employee } from '../../hr/entities/employee.entity';
import { Shift, WeekDay } from '../../attendance/entities/shift.entity';
import { LeaveRequest, LeaveRequestStatus } from '../../leave/entities/leave-request.entity';

const WEEKDAY_ORDER: WeekDay[] = [
  WeekDay.MONDAY,
  WeekDay.TUESDAY,
  WeekDay.WEDNESDAY,
  WeekDay.THURSDAY,
  WeekDay.FRIDAY,
  WeekDay.SATURDAY,
  WeekDay.SUNDAY,
];

@CommandHandler(CreateWeeklyPlanCommand)
export class CreateWeeklyPlanHandler implements ICommandHandler<CreateWeeklyPlanCommand> {
  private readonly logger = new Logger(CreateWeeklyPlanHandler.name);

  constructor(
    @InjectRepository(WeeklyPlan)
    private readonly weeklyPlanRepository: Repository<WeeklyPlan>,
    @InjectRepository(WeeklyPlanEntry)
    private readonly entryRepository: Repository<WeeklyPlanEntry>,
    @InjectRepository(SchedulingSettings)
    private readonly settingsRepository: Repository<SchedulingSettings>,
    @InjectRepository(Employee)
    private readonly employeeRepository: Repository<Employee>,
    @InjectRepository(Shift)
    private readonly shiftRepository: Repository<Shift>,
    @InjectRepository(LeaveRequest)
    private readonly leaveRequestRepository: Repository<LeaveRequest>,
    private readonly dataSource: DataSource,
  ) {}

  async execute(command: CreateWeeklyPlanCommand): Promise<WeeklyPlan> {
    const { tenantId, userId, employeeId, weekStartDate, defaultShiftId, defaultOffDays, notes } = command;

    // Parse and validate week start date
    const startDate = new Date(weekStartDate);
    if (isNaN(startDate.getTime())) {
      throw new BadRequestException('Invalid week start date');
    }

    // Ensure it's a Monday
    const dayOfWeek = startDate.getDay();
    if (dayOfWeek !== 1) {
      throw new BadRequestException('Week start date must be a Monday');
    }

    // Calculate week end date (Sunday)
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 6);

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      // Validate employee
      const employee = await queryRunner.manager.findOne(Employee, {
        where: { id: employeeId, tenantId, isDeleted: false },
      });

      if (!employee) {
        throw new NotFoundException(`Employee with ID ${employeeId} not found`);
      }

      // Check for existing plan
      const existingPlan = await queryRunner.manager.findOne(WeeklyPlan, {
        where: { tenantId, employeeId, weekStartDate: startDate, isDeleted: false },
      });

      if (existingPlan) {
        throw new BadRequestException('A weekly plan already exists for this employee and week');
      }

      // Get scheduling settings
      let settings = await queryRunner.manager.findOne(SchedulingSettings, {
        where: { tenantId },
      });

      if (!settings) {
        // Create default settings
        settings = queryRunner.manager.create(SchedulingSettings, {
          tenantId,
          standardWeeklyMinutes: 2700, // 45 hours
        });
        await queryRunner.manager.save(SchedulingSettings, settings);
      }

      // Get default shift if specified
      let shift: Shift | null = null;
      if (defaultShiftId) {
        shift = await queryRunner.manager.findOne(Shift, {
          where: { id: defaultShiftId, tenantId, isActive: true, isDeleted: false },
        });
        if (!shift) {
          throw new NotFoundException(`Shift with ID ${defaultShiftId} not found`);
        }
      } else if (settings.defaultShiftId) {
        shift = await queryRunner.manager.findOne(Shift, {
          where: { id: settings.defaultShiftId, tenantId, isActive: true, isDeleted: false },
        });
      }

      // Get approved leave requests for this week
      const leaveRequests = await queryRunner.manager
        .createQueryBuilder(LeaveRequest, 'lr')
        .where('lr.tenantId = :tenantId', { tenantId })
        .andWhere('lr.employeeId = :employeeId', { employeeId })
        .andWhere('lr.status = :status', { status: LeaveRequestStatus.APPROVED })
        .andWhere('lr.startDate <= :endDate AND lr.endDate >= :startDate', {
          startDate,
          endDate,
        })
        .getMany();

      // Create leave date map
      const leaveDates = new Map<string, LeaveRequest>();
      for (const lr of leaveRequests) {
        const leaveStart = new Date(lr.startDate);
        const leaveEnd = new Date(lr.endDate);
        for (let d = new Date(leaveStart); d <= leaveEnd; d.setDate(d.getDate() + 1)) {
          if (d >= startDate && d <= endDate) {
            leaveDates.set(d.toISOString().split('T')[0]!, lr);
          }
        }
      }

      // Default off days
      const offDays = new Set(defaultOffDays || [WeekDay.SATURDAY, WeekDay.SUNDAY]);

      // Create the weekly plan
      const weeklyPlan = queryRunner.manager.create(WeeklyPlan, {
        tenantId,
        employeeId,
        weekStartDate: startDate,
        weekEndDate: endDate,
        status: WeeklyPlanStatus.DRAFT,
        standardWeeklyMinutes: settings.standardWeeklyMinutes,
        notes,
        createdBy: userId,
        updatedBy: userId,
      });

      const savedPlan = await queryRunner.manager.save(WeeklyPlan, weeklyPlan);

      // Create entries for each day of the week
      const entries: WeeklyPlanEntry[] = [];
      let plannedWorkDays = 0;
      let plannedOffDays = 0;
      let plannedTotalMinutes = 0;

      for (let i = 0; i < 7; i++) {
        const entryDate = new Date(startDate);
        entryDate.setDate(entryDate.getDate() + i);
        const dateStr = entryDate.toISOString().split('T')[0]!;
        const weekDay = WEEKDAY_ORDER[i]!;

        const leaveRequest = leaveDates.get(dateStr);
        const isOff = offDays.has(weekDay);
        const isLeave = !!leaveRequest;

        let entryType: WeeklyPlanEntryType;
        let entryShiftId: string | undefined;
        let plannedMinutes = 0;

        if (isLeave) {
          entryType = WeeklyPlanEntryType.LEAVE;
          plannedOffDays++;
        } else if (isOff) {
          entryType = WeeklyPlanEntryType.OFF;
          plannedOffDays++;
        } else {
          entryType = WeeklyPlanEntryType.WORK;
          entryShiftId = shift?.id;
          plannedMinutes = shift?.totalMinutes || 0;
          plannedWorkDays++;
          plannedTotalMinutes += plannedMinutes;
        }

        const entry = queryRunner.manager.create(WeeklyPlanEntry, {
          tenantId,
          weeklyPlanId: savedPlan.id,
          employeeId,
          date: entryDate,
          dayOfWeek: weekDay,
          shiftId: entryShiftId,
          isOffDay: isOff && !isLeave,
          isLeaveDay: isLeave,
          leaveRequestId: leaveRequest?.id,
          plannedMinutes,
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
      savedPlan.plannedOvertimeMinutes = Math.max(0, plannedTotalMinutes - settings.standardWeeklyMinutes);

      await queryRunner.manager.save(WeeklyPlan, savedPlan);

      await queryRunner.commitTransaction();

      // Reload with entries
      // SECURITY: Include tenantId to ensure tenant isolation
      const result = await this.weeklyPlanRepository.findOne({
        where: { id: savedPlan.id, tenantId },
        relations: ['entries', 'entries.shift', 'employee'],
      });

      return result!;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }
}
