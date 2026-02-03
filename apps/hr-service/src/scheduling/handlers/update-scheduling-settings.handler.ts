import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Logger } from '@nestjs/common';
import { UpdateSchedulingSettingsCommand } from '../commands/update-scheduling-settings.command';
import { SchedulingSettings } from '../entities/scheduling-settings.entity';

@CommandHandler(UpdateSchedulingSettingsCommand)
export class UpdateSchedulingSettingsHandler implements ICommandHandler<UpdateSchedulingSettingsCommand> {
  private readonly logger = new Logger(UpdateSchedulingSettingsHandler.name);

  constructor(
    @InjectRepository(SchedulingSettings)
    private readonly settingsRepository: Repository<SchedulingSettings>,
  ) {}

  async execute(command: UpdateSchedulingSettingsCommand): Promise<SchedulingSettings> {
    const {
      tenantId,
      userId,
      standardWeeklyMinutes,
      maxOvertimeMinutesPerWeek,
      maxOvertimeMinutesPerMonth,
      defaultShiftId,
      workWeekStartDay,
      autoNotifyEmployees,
      notifyDaysBefore,
      maxConsecutiveWorkDays,
      minRestMinutesBetweenShifts,
      allowOvertimeWithoutApproval,
    } = command;

    let settings = await this.settingsRepository.findOne({
      where: { tenantId },
    });

    if (!settings) {
      // Create new settings
      settings = this.settingsRepository.create({
        tenantId,
      });
    }

    // Update only provided fields
    if (standardWeeklyMinutes !== undefined) {
      settings.standardWeeklyMinutes = standardWeeklyMinutes;
    }
    if (maxOvertimeMinutesPerWeek !== undefined) {
      settings.maxOvertimeMinutesPerWeek = maxOvertimeMinutesPerWeek;
    }
    if (maxOvertimeMinutesPerMonth !== undefined) {
      settings.maxOvertimeMinutesPerMonth = maxOvertimeMinutesPerMonth;
    }
    if (defaultShiftId !== undefined) {
      settings.defaultShiftId = defaultShiftId;
    }
    if (workWeekStartDay !== undefined) {
      settings.workWeekStartDay = workWeekStartDay;
    }
    if (autoNotifyEmployees !== undefined) {
      settings.autoNotifyEmployees = autoNotifyEmployees;
    }
    if (notifyDaysBefore !== undefined) {
      settings.notifyDaysBefore = notifyDaysBefore;
    }
    if (maxConsecutiveWorkDays !== undefined) {
      settings.maxConsecutiveWorkDays = maxConsecutiveWorkDays;
    }
    if (minRestMinutesBetweenShifts !== undefined) {
      settings.minRestMinutesBetweenShifts = minRestMinutesBetweenShifts;
    }
    if (allowOvertimeWithoutApproval !== undefined) {
      settings.allowOvertimeWithoutApproval = allowOvertimeWithoutApproval;
    }

    settings.updatedBy = userId;

    return this.settingsRepository.save(settings);
  }
}
