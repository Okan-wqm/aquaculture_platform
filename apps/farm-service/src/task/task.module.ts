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
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
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
    TypeOrmModule.forFeature([Task, RecurringTemplate, AutoRule]),
  ],
  providers: [
    // Services
    TaskService,
    RecurringTaskService,
    AutoRuleService,
    AutoRuleTriggerService,

    // Resolvers
    TaskResolver,
    RecurringTemplateResolver,
    AutoRuleResolver,
  ],
  exports: [TaskService, AutoRuleService, AutoRuleTriggerService],
})
export class TaskModule {}
