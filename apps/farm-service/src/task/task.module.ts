/**
 * Task Module
 *
 * Görev yönetimi modülü.
 * Görev oluşturma, atama, takip ve tekrarlayan görev planlaması.
 *
 * Sağladığı özellikler:
 * - Görev oluşturma ve atama
 * - Öncelik ve tarih yönetimi
 * - Checklist ve not takibi
 * - Tekrarlayan görev şablonları
 * - Gecikmiş görev tespiti (cron)
 * - Otomatik kural motoru (event-driven)
 * - Event yayınlama (NATS)
 *
 * @module Task
 */
import { MobileFeatureGuard } from '@aquaculture/backend-common/guards';
import { MobileCommandReceiptService } from '@aquaculture/backend-common/mobile-command';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { FarmMobileCommandReceipt } from '../mobile-command/entities/farm-mobile-command-receipt.entity';
import { Task } from './entities/task.entity';
import { RecurringTemplate } from './entities/recurring-template.entity';
import { AutoRule } from './entities/auto-rule.entity';

// Services
import { TaskService } from './services/task.service';
import { RecurringTaskService } from './services/recurring-task.service';
import { AutoRuleService } from './services/auto-rule.service';
import { AutoRuleTriggerService } from './services/auto-rule-trigger.service';

// Resolvers
import { TaskResolver } from './resolvers/task.resolver';
import { RecurringTemplateResolver } from './resolvers/recurring-template.resolver';
import { AutoRuleResolver } from './resolvers/auto-rule.resolver';

@Module({
  imports: [
    // FarmMobileCommandReceipt registered so the at-most-once receipt table
    // (FARM-HIGH-057) is part of this module's schema metadata.
    TypeOrmModule.forFeature([Task, RecurringTemplate, AutoRule, FarmMobileCommandReceipt]),
  ],
  providers: [
    // Services
    TaskService,
    RecurringTaskService,
    AutoRuleService,
    AutoRuleTriggerService,
    MobileCommandReceiptService,
    // SEC-HIGH-052: mobile-feature guard ('tasks' entitlement).
    MobileFeatureGuard,

    // Resolvers
    TaskResolver,
    RecurringTemplateResolver,
    AutoRuleResolver,
  ],
  exports: [TaskService, AutoRuleService, AutoRuleTriggerService],
})
export class TaskModule {}
