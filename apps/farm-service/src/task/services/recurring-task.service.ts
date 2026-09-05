/**
 * Recurring Task Service
 *
 * Tekrarlayan görev şablon yönetimi ve otomatik görev oluşturma.
 *
 * @module Task/Services
 */
import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { listTenantSchemas } from '@aquaculture/backend-common/database';
import { DateTime } from 'luxon';
import { createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { RecurringTemplate, RecurrenceFrequency } from '../entities/recurring-template.entity';
import { Task, TaskStatus } from '../entities/task.entity';
import { TaskService } from './task.service';

/**
 * Default timezone when a template was created before phase 5.5 or
 * without an explicit timezone. UTC is neutral — tasks generate at
 * midnight UTC rather than drifting with the host server. Operators
 * can re-save a template to stamp the current site's timezone.
 */
const DEFAULT_TIMEZONE = 'UTC';

@Injectable()
export class RecurringTaskService {
  private readonly logger = new Logger(RecurringTaskService.name);

  constructor(
    @InjectRepository(RecurringTemplate)
    private readonly templateRepository: Repository<RecurringTemplate>,
    @InjectRepository(Task)
    private readonly taskRepository: Repository<Task>,
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  // -------------------------------------------------------------------------
  // CRUD OPERATIONS
  // -------------------------------------------------------------------------

  /**
   * ID ile şablon bulur (internal write-path helper; the GraphQL
   * recurringTemplate(id) read goes through GetRecurringTemplateHandler).
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
      // Stored canonical (stable ids) so the read-path normaliser is a no-op
      // for rows this service wrote (FARM-HIGH-301).
      checklistItems: TaskService.normaliseChecklistItems(input.checklistItems),
      tenantId,
      isActive: true,
      nextGeneration: this.calculateNextGeneration(
        input.frequency!,
        input.frequencyDetail,
        input.timezone,
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
    if (input.checklistItems !== undefined) {
      template.checklistItems = TaskService.normaliseChecklistItems(input.checklistItems);
    }

    // Recalculate next generation if frequency OR timezone changed —
    // a tenant that relocates a site from Istanbul to Oslo expects
    // existing templates to re-align on save.
    if (input.frequency || input.timezone) {
      template.nextGeneration = this.calculateNextGeneration(
        input.frequency ?? template.frequency,
        input.frequencyDetail ?? template.frequencyDetail,
        input.timezone ?? template.timezone,
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
        template.timezone,
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
            const dueDate = this.calculateDueDate(template.timezone);

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
              checklistItems: TaskService.propagateChecklistItemsFromTemplate(
                template.checklistItems,
              ),
              notes: [],
              tags: template.tags,
              isRecurring: true,
              recurringTemplateId: template.id,
              isAutoGenerated: true,
            });

            const saved = await queryRunner.manager.save(Task, task);
            generatedTasks.push(saved);

            // Atomic: the TaskCreated event is enqueued on the SAME
            // transaction manager that persisted the generated task and bumped
            // the template, so a crash between save and commit can no longer
            // drop the event (at-least-once via the outbox).
            if (saved.assignedTo) {
              await this.outboxPublisher.enqueue(
                {
                  ...createBaseEvent('TaskCreated', template.tenantId),
                  taskId: saved.id,
                  title: saved.title,
                  assignedTo: saved.assignedTo,
                  assignedToName: saved.assignedToName,
                  category: saved.category,
                  priority: saved.priority,
                  dueDate: saved.dueDate.toISOString(),
                  createdBy: 'system',
                },
                queryRunner.manager,
              );
            }

            await queryRunner.query(
              `UPDATE recurring_templates
               SET "lastGenerated" = $1, "nextGeneration" = $2, "updatedAt" = NOW()
               WHERE id = $3`,
              [
                now,
                this.calculateNextGeneration(
                  template.frequency,
                  template.frequencyDetail,
                  template.timezone,
                ),
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
   * Resolve and validate an IANA timezone identifier. Invalid zone
   * identifiers (typos, legacy abbreviations like "EST") fall back
   * to UTC with a warn — the cron still runs, it just generates at
   * UTC midnight instead of crashing the whole generation pass.
   */
  private resolveTimezone(timezone?: string | null): string {
    if (!timezone) {
      return DEFAULT_TIMEZONE;
    }
    const probe = DateTime.now().setZone(timezone);
    if (!probe.isValid) {
      this.logger.warn(
        `Invalid timezone "${timezone}" on recurring template — falling back to ${DEFAULT_TIMEZONE}. ` +
          `Reason: ${probe.invalidReason ?? 'unknown'}.`,
      );
      return DEFAULT_TIMEZONE;
    }
    return timezone;
  }

  /**
   * Calculates the due date for a generated task in the template's
   * local timezone. Uses end-of-day LOCAL so a task for an Istanbul
   * tenant due "today" resolves to 23:59 Europe/Istanbul regardless
   * of where the server runs. Returns a UTC Date — luxon converts
   * the local end-of-day to the correct UTC instant internally.
   *
   * Before phase 5.5 this used JS Date's host-local components which
   * meant a task for a Norwegian tenant generated on a Turkish server
   * picked up 23:59 Europe/Istanbul (22:59 Oslo in summer DST) — a
   * subtle one-hour drift that accumulated missed deadlines.
   */
  private calculateDueDate(timezone?: string | null): Date {
    const zone = this.resolveTimezone(timezone);
    return DateTime.now().setZone(zone).endOf('day').toJSDate();
  }

  /**
   * Compute the next generation tick for the given frequency in the
   * template's local timezone. Luxon handles DST transitions
   * automatically: "+1 day" across a DST shift lands on the same
   * local wall-clock hour even though the UTC delta was 23h or 25h.
   */
  private calculateNextGeneration(
    frequency: RecurrenceFrequency,
    frequencyDetail?: string | null,
    timezone?: string | null,
  ): Date {
    const zone = this.resolveTimezone(timezone);
    const now = DateTime.now().setZone(zone);

    switch (frequency) {
      case RecurrenceFrequency.HOURLY:
        return now.plus({ hours: 1 }).toJSDate();
      case RecurrenceFrequency.DAILY:
        return now.plus({ days: 1 }).toJSDate();
      case RecurrenceFrequency.WEEKLY:
        return now.plus({ weeks: 1 }).toJSDate();
      case RecurrenceFrequency.BIWEEKLY:
        return now.plus({ weeks: 2 }).toJSDate();
      case RecurrenceFrequency.MONTHLY:
        // Luxon's `plus({ months: 1 })` clamps the day when the
        // target month is shorter: Jan 31 → Feb 28/29. That matches
        // what operators expect for monthly maintenance schedules.
        return now.plus({ months: 1 }).toJSDate();
      case RecurrenceFrequency.CUSTOM: {
        const hours = parseInt(frequencyDetail || '24', 10);
        if (isNaN(hours) || hours <= 0) {
          this.logger.warn(
            `Invalid frequencyDetail: "${frequencyDetail}", defaulting to 24h`,
          );
          return now.plus({ hours: 24 }).toJSDate();
        }
        return now.plus({ hours }).toJSDate();
      }
      default:
        return now.plus({ days: 1 }).toJSDate();
    }
  }
}
