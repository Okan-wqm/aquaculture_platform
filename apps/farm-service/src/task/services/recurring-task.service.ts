/**
 * Recurring Task Service
 *
 * Tekrarlayan görev şablon yönetimi ve otomatik görev oluşturma.
 *
 * @module Task/Services
 */
import {
  Injectable,
  Inject,
  Optional,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { listTenantSchemas } from '@aquaculture/backend-common';
import { NatsEventBus } from '@platform/event-bus';
import { createBaseEvent } from '@platform/event-contracts';
import { RecurringTemplate, RecurrenceFrequency } from '../entities/recurring-template.entity';
import { Task, TaskStatus } from '../entities/task.entity';

@Injectable()
export class RecurringTaskService {
  private readonly logger = new Logger(RecurringTaskService.name);

  constructor(
    @InjectRepository(RecurringTemplate)
    private readonly templateRepository: Repository<RecurringTemplate>,
    @InjectRepository(Task)
    private readonly taskRepository: Repository<Task>,
    private readonly dataSource: DataSource,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
  ) {}

  // -------------------------------------------------------------------------
  // CRUD OPERATIONS
  // -------------------------------------------------------------------------

  /**
   * Tüm tekrarlayan şablonları listeler
   */
  async findAll(tenantId: string): Promise<RecurringTemplate[]> {
    return this.templateRepository.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * ID ile şablon bulur
   */
  async findById(tenantId: string, id: string): Promise<RecurringTemplate> {
    const template = await this.templateRepository.findOne({
      where: { id, tenantId },
    });

    if (!template) {
      throw new NotFoundException(`Tekrarlayan şablon bulunamadı: ${id}`);
    }

    return template;
  }

  /**
   * Yeni tekrarlayan şablon oluşturur
   */
  async create(
    tenantId: string,
    input: Partial<RecurringTemplate>,
  ): Promise<RecurringTemplate> {
    this.logger.log(`Creating recurring template "${input.title}" for tenant ${tenantId}`);

    const template = this.templateRepository.create({
      ...input,
      tenantId,
      isActive: true,
      nextGeneration: this.calculateNextGeneration(
        input.frequency!,
        input.frequencyDetail,
      ),
    });

    return this.templateRepository.save(template);
  }

  /**
   * Şablonu günceller
   */
  async update(
    tenantId: string,
    id: string,
    input: Partial<RecurringTemplate>,
  ): Promise<RecurringTemplate> {
    const template = await this.findById(tenantId, id);

    Object.assign(template, input);

    // Recalculate next generation if frequency changed
    if (input.frequency) {
      template.nextGeneration = this.calculateNextGeneration(
        input.frequency,
        input.frequencyDetail || template.frequencyDetail,
      );
    }

    return this.templateRepository.save(template);
  }

  /**
   * Şablonu aktif/pasif yapar
   */
  async toggleActive(tenantId: string, id: string): Promise<RecurringTemplate> {
    const template = await this.findById(tenantId, id);
    template.isActive = !template.isActive;

    if (template.isActive && !template.nextGeneration) {
      template.nextGeneration = this.calculateNextGeneration(
        template.frequency,
        template.frequencyDetail,
      );
    }

    return this.templateRepository.save(template);
  }

  /**
   * Şablonu siler
   */
  async delete(tenantId: string, id: string): Promise<boolean> {
    const template = await this.findById(tenantId, id);
    await this.templateRepository.softRemove(template);
    return true;
  }

  // -------------------------------------------------------------------------
  // TENANT SCHEMA HELPERS
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // TASK GENERATION
  // -------------------------------------------------------------------------

  /**
   * Zamanı gelen şablonlardan görev oluşturur.
   * Iterates ALL tenant schemas to ensure no tenant is missed.
   */
  @Cron('0 */15 * * * *')
  async generateDueTasks(): Promise<Task[]> {
    this.logger.log('Running recurring task generation across all tenant schemas...');
    const now = new Date();
    const generatedTasks: Task[] = [];

    const tenantSchemas = await listTenantSchemas(this.dataSource);
    if (tenantSchemas.length === 0) {
      this.logger.debug('No tenant schemas found, skipping recurring task generation');
      return generatedTasks;
    }

    this.logger.log(`Processing recurring task generation for ${tenantSchemas.length} tenant schemas`);

    for (const schema of tenantSchemas) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();

      try {
        await queryRunner.query(`SET search_path TO "${schema}", farm, public`);

        await queryRunner.startTransaction();

        const dueTemplates: RecurringTemplate[] = await queryRunner.query(
          `SELECT * FROM recurring_templates
           WHERE "isActive" = true
           AND "nextGeneration" <= $1
           AND "deletedAt" IS NULL
           FOR UPDATE SKIP LOCKED`,
          [now],
        );

        if (dueTemplates.length === 0) {
          await queryRunner.commitTransaction();
          continue;
        }

        for (const template of dueTemplates) {
          try {
            const dueDate = this.calculateDueDate();

            const task = queryRunner.manager.create(Task, {
              tenantId: template.tenantId,
              title: template.title,
              description: template.description,
              category: template.category,
              priority: template.priority,
              status: TaskStatus.PENDING,
              assignedTo: template.assignedTo,
              assignedToName: template.assignedToName,
              createdBy: template.assignedTo,
              dueDate,
              location: template.location,
              estimatedMinutes: template.estimatedMinutes,
              checklistItems: template.checklistItems ? [...template.checklistItems] : [],
              notes: [],
              tags: template.tags,
              isRecurring: true,
              recurringTemplateId: template.id,
              isAutoGenerated: true,
            });

            const saved = await queryRunner.manager.save(Task, task);
            generatedTasks.push(saved);

            if (this.eventBus && saved.assignedTo) {
              try {
                await this.eventBus.publish({
                  ...createBaseEvent('TaskCreated', template.tenantId),
                  taskId: saved.id,
                  title: saved.title,
                  assignedTo: saved.assignedTo,
                  assignedToName: saved.assignedToName,
                  category: saved.category,
                  priority: saved.priority,
                  dueDate: saved.dueDate?.toISOString(),
                  createdBy: 'system',
                });
              } catch (eventError) {
                this.logger.warn(
                  `Failed to publish TaskCreated event for recurring task: ${(eventError as Error).message}`,
                );
              }
            }

            await queryRunner.query(
              `UPDATE recurring_templates
               SET "lastGenerated" = $1, "nextGeneration" = $2, "updatedAt" = NOW()
               WHERE id = $3`,
              [
                now,
                this.calculateNextGeneration(template.frequency, template.frequencyDetail),
                template.id,
              ],
            );

            this.logger.log(
              `Generated task "${saved.title}" from template ${template.id} (schema: ${schema})`,
            );
          } catch (error) {
            this.logger.error(
              `Failed to generate task from template ${template.id} in schema ${schema}: ${(error as Error).message}`,
            );
          }
        }

        await queryRunner.commitTransaction();
      } catch (err) {
        this.logger.error(
          `Recurring task generation failed for schema ${schema}: ${(err as Error).message}`,
        );
        await queryRunner.rollbackTransaction().catch(() => {});
      } finally {
        await queryRunner.query('RESET search_path').catch(() => {});
        await queryRunner.release();
      }
    }

    return generatedTasks;
  }

  // -------------------------------------------------------------------------
  // HELPER METHODS
  // -------------------------------------------------------------------------

  /**
   * Calculates the due date for a generated task.
   * Uses end of today to prevent tasks from being born overdue.
   */
  private calculateDueDate(): Date {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  }

  /**
   * Sonraki üretim zamanını hesaplar
   */
  private calculateNextGeneration(
    frequency: RecurrenceFrequency,
    frequencyDetail?: string | null,
  ): Date {
    const now = new Date();

    switch (frequency) {
      case RecurrenceFrequency.HOURLY:
        return new Date(now.getTime() + 60 * 60 * 1000);
      case RecurrenceFrequency.DAILY:
        return new Date(now.getTime() + 24 * 60 * 60 * 1000);
      case RecurrenceFrequency.WEEKLY:
        return new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
      case RecurrenceFrequency.BIWEEKLY:
        return new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
      case RecurrenceFrequency.MONTHLY: {
        const nextMonth = new Date(now);
        const targetMonth = now.getMonth() + 1;
        nextMonth.setMonth(targetMonth);
        if (nextMonth.getMonth() !== targetMonth % 12) {
          nextMonth.setDate(0);
        }
        return nextMonth;
      }
      case RecurrenceFrequency.CUSTOM: {
        const hours = parseInt(frequencyDetail || '24', 10);
        if (isNaN(hours) || hours <= 0) {
          this.logger.warn(`Invalid frequencyDetail: "${frequencyDetail}", defaulting to 24h`);
          return new Date(now.getTime() + 24 * 60 * 60 * 1000);
        }
        return new Date(now.getTime() + hours * 60 * 60 * 1000);
      }
      default:
        return new Date(now.getTime() + 24 * 60 * 60 * 1000);
    }
  }
}
