import { CommandHandler, ICommandHandler } from '@nestjs/cqrs';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PublishWeeklyPlanCommand } from '../commands/publish-weekly-plan.command';
import { WeeklyPlan, WeeklyPlanStatus } from '../entities/weekly-plan.entity';
import { WeeklyPlanEntry, WeeklyPlanEntryType } from '../entities/weekly-plan-entry.entity';
import { ScheduleNotificationService } from '../services/schedule-notification.service';

@CommandHandler(PublishWeeklyPlanCommand)
export class PublishWeeklyPlanHandler implements ICommandHandler<PublishWeeklyPlanCommand> {
  private readonly logger = new Logger(PublishWeeklyPlanHandler.name);

  constructor(
    @InjectRepository(WeeklyPlan)
    private readonly planRepository: Repository<WeeklyPlan>,
    @InjectRepository(WeeklyPlanEntry)
    private readonly entryRepository: Repository<WeeklyPlanEntry>,
    private readonly notificationService: ScheduleNotificationService,
  ) {}

  async execute(command: PublishWeeklyPlanCommand): Promise<WeeklyPlan> {
    const { tenantId, userId, weeklyPlanId } = command;

    const plan = await this.planRepository.findOne({
      where: { id: weeklyPlanId, tenantId, isDeleted: false },
      relations: ['entries'],
    });

    if (!plan) {
      throw new NotFoundException(`Weekly plan with ID ${weeklyPlanId} not found`);
    }

    if (plan.status === WeeklyPlanStatus.PUBLISHED) {
      throw new BadRequestException('Plan is already published');
    }

    // Validate that plan has at least some work days
    const workEntries = plan.entries?.filter(
      e => e.entryType === WeeklyPlanEntryType.WORK || e.entryType === WeeklyPlanEntryType.TRAINING
    );

    if (!workEntries || workEntries.length === 0) {
      this.logger.warn(`Publishing plan ${weeklyPlanId} with no work days assigned`);
    }

    // Update plan status
    plan.status = WeeklyPlanStatus.PUBLISHED;
    plan.publishedAt = new Date();
    plan.updatedBy = userId;

    const savedPlan = await this.planRepository.save(plan);

    this.logger.log(`Weekly plan ${weeklyPlanId} published successfully`);

    // Trigger auto-notification if enabled in tenant settings
    // This is fire-and-forget - notification failure should not affect publish
    this.notificationService
      .autoNotifyOnPublish(tenantId, savedPlan.id)
      .then((notified) => {
        if (notified) {
          this.logger.log(`Auto-notification sent for plan ${weeklyPlanId}`);
        }
      })
      .catch((error) => {
        this.logger.warn(`Auto-notification failed for plan ${weeklyPlanId}: ${error.message}`);
      });

    // Reload with relations - SECURITY: Include tenantId for defense in depth
    return this.planRepository.findOne({
      where: { id: savedPlan.id, tenantId },
      relations: ['entries', 'entries.shift', 'employee'],
    }) as Promise<WeeklyPlan>;
  }
}
