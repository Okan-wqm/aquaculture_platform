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
 * - Event yayınlama (NATS)
 *
 * @module Task
 */
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

// Entities
import { Task } from './entities/task.entity';
import { RecurringTemplate } from './entities/recurring-template.entity';

// Services
import { TaskService } from './services/task.service';
import { RecurringTaskService } from './services/recurring-task.service';

// Resolvers
import { TaskResolver } from './resolvers/task.resolver';
import { RecurringTemplateResolver } from './resolvers/recurring-template.resolver';

@Module({
  imports: [
    TypeOrmModule.forFeature([Task, RecurringTemplate]),
  ],
  providers: [
    // Services
    TaskService,
    RecurringTaskService,

    // Resolvers
    TaskResolver,
    RecurringTemplateResolver,
  ],
  exports: [TaskService],
})
export class TaskModule {}
