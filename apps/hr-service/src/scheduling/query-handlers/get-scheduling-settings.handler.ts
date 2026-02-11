import { IQueryHandler, QueryHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GetSchedulingSettingsQuery } from '../queries/get-scheduling-settings.query';
import { SchedulingSettings } from '../entities/scheduling-settings.entity';

@QueryHandler(GetSchedulingSettingsQuery)
export class GetSchedulingSettingsHandler implements IQueryHandler<GetSchedulingSettingsQuery> {
  constructor(
    @InjectRepository(SchedulingSettings)
    private readonly settingsRepository: Repository<SchedulingSettings>,
  ) {}

  async execute(query: GetSchedulingSettingsQuery): Promise<SchedulingSettings> {
    const { tenantId } = query;

    let settings = await this.settingsRepository.findOne({
      where: { tenantId },
    });

    if (!settings) {
      // Create and save default settings
      settings = this.settingsRepository.create({
        tenantId,
        standardWeeklyMinutes: 2700, // 45 hours
        maxOvertimeMinutesPerWeek: 720, // 12 hours
        maxOvertimeMinutesPerMonth: 2880, // 48 hours
        workWeekStartDay: 'monday' as any,
        autoNotifyEmployees: true,
        notifyDaysBefore: 2,
        maxConsecutiveWorkDays: 6,
        minRestMinutesBetweenShifts: 660, // 11 hours
        allowOvertimeWithoutApproval: true,
      });
      await this.settingsRepository.save(settings);
    }

    return settings;
  }
}
