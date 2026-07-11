/**
 * Task Service
 *
 * Görev yönetimi ve iş kuralları.
 * CRUD operasyonları, durum yönetimi, istatistik ve event yayınlama.
 *
 * @module Task/Services
 */
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource, EntityManager } from 'typeorm';
import { listTenantSchemas } from '@aquaculture/backend-common/database';
import { Cron } from '@nestjs/schedule';
import {
  MobileCommandReceiptService,
  type MobileCommandEnvelope,
} from '@aquaculture/backend-common/mobile-command';
import { assertSelfOrManager, type SelfScopeCaller } from '@aquaculture/backend-common/security';
import { createBaseEvent } from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import { randomUUID } from 'crypto';
import { Task, TaskChecklistItem, TaskStatus, TaskPriority } from '../entities/task.entity';
import { RecurringTemplate } from '../entities/recurring-template.entity';
import { CreateTaskInput } from '../dto/create-task.dto';
import { UpdateTaskInput } from '../dto/update-task.dto';
import { EventNames } from '../../events/event-types';

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  /**
   * Normalise a single `checklistItems` entry so every stored item
   * carries (a) a server-assigned UUID `id` and (b) the canonical
   * `isCompleted` boolean flag.
   *
   * Two historical shapes are accepted on input:
   *   - UI/DTO shape: `{ text, isCompleted? }` — the `TaskChecklistItemInput`
   *     DTO's field set.
   *   - Legacy toggle shape: `{ completed, completedAt }` — produced
   *     by older `toggleChecklistItem` writes before the canonical
   *     field was unified.
   *
   * The return is always `{ id, text, isCompleted, completedAt?, completedBy? }`:
   * the `completed` field is dropped from future writes so there's a
   * single source of truth for UI reads. Existing rows with the
   * legacy field stay readable (TypeORM doesn't delete JSONB keys on
   * save — whatever we emit REPLACES the array entry, so the stale
   * `completed` is gone after the first normalise-and-save).
   */
  static normaliseChecklistItem(raw: Partial<TaskChecklistItem>): TaskChecklistItem {
    const canonicalCompleted = raw.isCompleted ?? raw.completed ?? false;
    const normalised: TaskChecklistItem = {
      id: raw.id ?? randomUUID(),
      text: raw.text ?? '',
      isCompleted: canonicalCompleted,
    };
    if (raw.completedAt !== undefined) normalised.completedAt = raw.completedAt;
    if (raw.completedBy !== undefined) normalised.completedBy = raw.completedBy;
    return normalised;
  }

  private static normaliseChecklistItems(
    raw: Partial<TaskChecklistItem>[] | undefined,
  ): TaskChecklistItem[] {
    if (!raw || !Array.isArray(raw)) return [];
    return raw.map((item) => TaskService.normaliseChecklistItem(item));
  }

  /**
   * Clone a template's checklist items into a fresh list suitable
   * for a new Task. Each propagated item gets a fresh UUID so
   * toggles on the spawned task don't collide with the template's
   * ids (or with sibling tasks spawned from the same template),
   * and the `isCompleted`/`completedAt`/`completedBy` audit fields
   * are reset — a brand-new task starts with everything unchecked.
   */
  static propagateChecklistItemsFromTemplate(
    templateItems: Partial<TaskChecklistItem>[] | undefined,
  ): TaskChecklistItem[] {
    if (!templateItems || !Array.isArray(templateItems)) return [];
    return templateItems.map((t) => ({
      id: randomUUID(),
      text: t.text ?? '',
      isCompleted: false,
    }));
  }

  private static readonly VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
    [TaskStatus.PENDING]: [TaskStatus.IN_PROGRESS, TaskStatus.CANCELLED],
    [TaskStatus.IN_PROGRESS]: [TaskStatus.COMPLETED, TaskStatus.PENDING, TaskStatus.CANCELLED],
    [TaskStatus.OVERDUE]: [TaskStatus.IN_PROGRESS, TaskStatus.COMPLETED, TaskStatus.CANCELLED],
    [TaskStatus.COMPLETED]: [TaskStatus.PENDING],
    [TaskStatus.CANCELLED]: [TaskStatus.PENDING],
  };

  constructor(
    @InjectRepository(Task)
    private readonly taskRepository: Repository<Task>,
    @InjectRepository(RecurringTemplate)
    private readonly recurringTemplateRepository: Repository<RecurringTemplate>,
    private readonly dataSource: DataSource,
    private readonly outboxPublisher: OutboxPublisher,
    private readonly mobileCommandReceipts: MobileCommandReceiptService,
  ) {}

  // -------------------------------------------------------------------------
  // CRUD OPERATIONS
  // -------------------------------------------------------------------------

  /**
   * Yeni görev oluşturur
   */
  async create(
    tenantId: string,
    input: CreateTaskInput,
    createdBy: string,
  ): Promise<Task> {
    this.logger.log(`Creating task "${input.title}" for tenant ${tenantId}`);

    // Atomic: save + TaskCreated outbox enqueue in one transaction. The
    // event is durably persisted with the row (at-least-once), never
    // fire-and-forget — a crash or NATS gap can no longer drop it.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const saved = await this.createWithManager(
        queryRunner.manager,
        tenantId,
        input,
        createdBy,
      );
      await queryRunner.commitTransaction();
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * SSoT for the task row + TaskCreated outbox write, keyed to a caller-supplied
   * EntityManager so it composes with either an owned transaction (the request
   * path above) OR an ambient tenant-scoped transaction (the NATS
   * request.farm.createTask responder, which sets the tenant search_path via
   * runInTenantTransaction before delegating here). Keeping it manager-driven is
   * why both entry points share ONE create-and-emit path rather than duplicating
   * the entity shape + event contract.
   */
  async createWithManager(
    manager: EntityManager,
    tenantId: string,
    input: CreateTaskInput,
    createdBy: string,
  ): Promise<Task> {
    const task = this.taskRepository.create({
      tenantId,
      title: input.title,
      description: input.description,
      category: input.category,
      priority: input.priority,
      status: TaskStatus.PENDING,
      assignedTo: input.assignedTo,
      assignedToName: input.assignedToName,
      createdBy,
      dueDate: new Date(input.dueDate),
      dueTime: input.dueTime,
      siteId: input.siteId,
      location: input.location,
      estimatedMinutes: input.estimatedMinutes,
      checklistItems: TaskService.normaliseChecklistItems(input.checklistItems),
      notes: [],
      tags: input.tags,
      isRecurring: input.isRecurring || false,
      recurringTemplateId: input.recurringTemplateId,
    });

    const saved = await manager.save(task);

    await this.outboxPublisher.enqueue(
      {
        ...createBaseEvent('TaskCreated', tenantId, { userId: createdBy }),
        taskId: saved.id,
        title: saved.title,
        category: saved.category,
        priority: saved.priority,
        assignedTo: saved.assignedTo,
        assignedToName: saved.assignedToName,
        dueDate: input.dueDate,
        createdBy,
      },
      manager,
    );

    this.logger.log(`Task created: ${saved.id}`);
    return saved;
  }

  /**
   * Görevi günceller
   *
   * SEC-HIGH-050: a non-owner edit (peer reassignment / status change) is
   * blocked unless the caller is MODULE_MANAGER+ (the object-level layer beneath
   * the coarse @Roles gate). FARM-HIGH-056: a status reopen (out of COMPLETED)
   * clears the completion fields in the SAME write, and the whole body runs in a
   * transaction whose domain write + TaskAssigned/TaskStatusChanged events are
   * enqueued through the transactional outbox (atomic — no fire-and-forget).
   */
  async update(
    tenantId: string,
    input: UpdateTaskInput,
    caller: SelfScopeCaller,
  ): Promise<Task> {
    const userId = caller.sub;
    const task = await this.findById(tenantId, input.id);

    // SEC-HIGH-050: only the assignee or a MODULE_MANAGER+ may mutate the task.
    assertSelfOrManager({ ownerId: task.assignedTo, caller });

    const previousAssignedTo = task.assignedTo;
    const previousStatus = task.status;

    if (input.title !== undefined) task.title = input.title;
    if (input.description !== undefined) task.description = input.description;
    if (input.category !== undefined) task.category = input.category;
    if (input.priority !== undefined) task.priority = input.priority;
    if (input.status !== undefined && input.status !== task.status) {
      const validNext = TaskService.VALID_TRANSITIONS[task.status];
      if (!validNext?.includes(input.status)) {
        throw new BadRequestException(
          `Geçersiz durum geçişi: ${task.status} → ${input.status}`,
        );
      }
    }
    if (input.status !== undefined) task.status = input.status;
    if (input.assignedTo !== undefined) task.assignedTo = input.assignedTo;
    if (input.assignedToName !== undefined) task.assignedToName = input.assignedToName;
    if (input.dueDate !== undefined) task.dueDate = new Date(input.dueDate);
    if (input.dueTime !== undefined) task.dueTime = input.dueTime;
    if (input.siteId !== undefined) task.siteId = input.siteId;
    if (input.location !== undefined) task.location = input.location;
    if (input.estimatedMinutes !== undefined) task.estimatedMinutes = input.estimatedMinutes;
    if (input.checklistItems !== undefined) {
      task.checklistItems = TaskService.normaliseChecklistItems(input.checklistItems);
    }
    if (input.notes !== undefined) task.notes = input.notes;
    if (input.tags !== undefined) task.tags = input.tags;
    if (input.isRecurring !== undefined) task.isRecurring = input.isRecurring;
    if (input.recurringTemplateId !== undefined) task.recurringTemplateId = input.recurringTemplateId;

    // FARM-HIGH-056: a reopen (transition OUT of COMPLETED) nulls the completion
    // fields so a reopened PENDING task never lies about being done and the stats
    // SQL (which keys off completedAt) is not corrupted.
    const isReopen =
      previousStatus === TaskStatus.COMPLETED &&
      task.status !== TaskStatus.COMPLETED;
    if (isReopen) {
      task.clearCompletion();
    }

    const statusChanged = task.status !== previousStatus;
    const assigneeChanged =
      input.assignedTo !== undefined && input.assignedTo !== previousAssignedTo;

    // Atomic: save + outbox enqueue(s) in one transaction.
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const saved = await queryRunner.manager.save(task);

      if (assigneeChanged) {
        await this.outboxPublisher.enqueue(
          {
            ...createBaseEvent('TaskAssigned', tenantId, { userId }),
            taskId: saved.id,
            title: saved.title,
            assignedTo: saved.assignedTo,
            assignedBy: userId,
            dueDate: saved.dueDate.toISOString(),
            priority: saved.priority,
          },
          queryRunner.manager,
        );
      }

      if (statusChanged) {
        await this.outboxPublisher.enqueue(
          {
            ...createBaseEvent('TaskStatusChanged', tenantId, { userId }),
            taskId: saved.id,
            previousStatus,
            newStatus: saved.status,
            changedBy: userId,
          },
          queryRunner.manager,
        );
      }

      await queryRunner.commitTransaction();
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * ID ile görev bulur
   */
  // NOTE: findById is now called ONLY by internal write methods (the GraphQL
  // `task(id)` read goes through GetTaskHandler). It stays a raw repo read here;
  // it is migrated onto the fail-closed boundary together with the task WRITE
  // path (runInTenantTransaction) in the follow-up write-migration PR.
  async findById(tenantId: string, id: string): Promise<Task> {
    const task = await this.taskRepository.findOne({
      where: { id, tenantId },
    });

    if (!task) {
      throw new NotFoundException(`Görev bulunamadı: ${id}`);
    }

    return task;
  }

  /**
   * Gecikmiş görevleri getirir
   */
  async findOverdue(tenantId: string): Promise<Task[]> {
    return this.taskRepository.find({
      where: {
        tenantId,
        status: TaskStatus.OVERDUE,
      },
      order: { dueDate: 'ASC' },
    });
  }

  /**
   * Görevi tamamlar
   *
   * SEC-HIGH-050: only the assignee or a MODULE_MANAGER+ may complete the task.
   * FARM-HIGH-057: the offline-queued completion is idempotent via the
   * at-most-once receipt — a replay returns the stored COMPLETED task WITHOUT a
   * second transition (no "already completed" error), and the legacy (no-envelope)
   * path is rejected so a retry can never double-apply.
   */
  async completeTask(
    tenantId: string,
    taskId: string,
    caller: SelfScopeCaller,
    envelope?: MobileCommandEnvelope | null,
  ): Promise<Task> {
    const completedBy = caller.sub;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const receipt = await this.mobileCommandReceipts.begin(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        tenantId,
        envelope,
        operationType: 'completeTask',
        responseType: 'Task',
      });

      if (receipt.mode === 'replay') {
        const replayed = receipt.responseId
          ? await queryRunner.manager.findOne(Task, {
              where: { id: receipt.responseId, tenantId },
            })
          : null;
        if (!replayed) {
          throw new ConflictException('Mobile command receipt response is no longer available');
        }
        await queryRunner.commitTransaction();
        return replayed;
      }

      // FARM-HIGH-057: offline-queued task mutations REQUIRE an idempotency
      // envelope. 'legacy' (no clientCommandId) is the no-key path where a retry
      // would double-apply; reject it (same backstop as record-mortality).
      if (receipt.mode === 'legacy') {
        throw new BadRequestException(
          'completeTask requires an idempotency envelope (clientCommandId + payloadHash)',
        );
      }

      const task = await queryRunner.manager.findOne(Task, {
        where: { id: taskId, tenantId },
      });
      if (!task) {
        throw new NotFoundException(`Görev bulunamadı: ${taskId}`);
      }

      // SEC-HIGH-050: object-level authorization beneath the @Roles gate.
      assertSelfOrManager({ ownerId: task.assignedTo, caller });

      if (task.status === TaskStatus.COMPLETED) {
        throw new BadRequestException('Görev zaten tamamlanmış');
      }
      if (task.status === TaskStatus.CANCELLED) {
        throw new BadRequestException('İptal edilmiş görev tamamlanamaz');
      }

      const previousStatus = task.status;
      task.status = TaskStatus.COMPLETED;
      task.completedAt = new Date();
      task.completedBy = completedBy;

      const saved = await queryRunner.manager.save(task);

      await this.outboxPublisher.enqueue(
        {
          ...createBaseEvent('TaskCompleted', tenantId, { userId: completedBy }),
          taskId: saved.id,
          title: saved.title,
          previousStatus,
          completedBy,
          completedAt: saved.completedAt,
          assignedTo: saved.assignedTo,
        },
        queryRunner.manager,
      );

      await this.mobileCommandReceipts.complete(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        receipt,
        responseType: 'Task',
        responseId: saved.id,
        responsePayload: { id: saved.id },
      });

      await queryRunner.commitTransaction();
      this.logger.debug(`Published TaskCompleted event for task ${saved.id}`);
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Görevi başlatır (IN_PROGRESS)
   *
   * SEC-HIGH-050: only the assignee or a MODULE_MANAGER+ may start the task.
   * FARM-HIGH-057: idempotent via the at-most-once receipt — a replay returns the
   * stored IN_PROGRESS task without a second transition; the legacy path is rejected.
   */
  async startTask(
    tenantId: string,
    taskId: string,
    caller: SelfScopeCaller,
    envelope?: MobileCommandEnvelope | null,
  ): Promise<Task> {
    const userId = caller.sub;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const receipt = await this.mobileCommandReceipts.begin(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        tenantId,
        envelope,
        operationType: 'startTask',
        responseType: 'Task',
      });

      if (receipt.mode === 'replay') {
        const replayed = receipt.responseId
          ? await queryRunner.manager.findOne(Task, {
              where: { id: receipt.responseId, tenantId },
            })
          : null;
        if (!replayed) {
          throw new ConflictException('Mobile command receipt response is no longer available');
        }
        await queryRunner.commitTransaction();
        return replayed;
      }

      if (receipt.mode === 'legacy') {
        throw new BadRequestException(
          'startTask requires an idempotency envelope (clientCommandId + payloadHash)',
        );
      }

      const task = await queryRunner.manager.findOne(Task, {
        where: { id: taskId, tenantId },
      });
      if (!task) {
        throw new NotFoundException(`Görev bulunamadı: ${taskId}`);
      }

      // SEC-HIGH-050: object-level authorization beneath the @Roles gate.
      assertSelfOrManager({ ownerId: task.assignedTo, caller });

      if (task.status !== TaskStatus.PENDING && task.status !== TaskStatus.OVERDUE) {
        throw new BadRequestException(
          'Sadece bekleyen veya gecikmiş görevler başlatılabilir',
        );
      }

      const previousStatus = task.status;
      task.status = TaskStatus.IN_PROGRESS;

      const saved = await queryRunner.manager.save(task);

      await this.outboxPublisher.enqueue(
        {
          ...createBaseEvent('TaskStatusChanged', tenantId, { userId }),
          taskId: saved.id,
          previousStatus,
          newStatus: TaskStatus.IN_PROGRESS,
          changedBy: userId,
        },
        queryRunner.manager,
      );

      await this.mobileCommandReceipts.complete(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        receipt,
        responseType: 'Task',
        responseId: saved.id,
        responsePayload: { id: saved.id },
      });

      await queryRunner.commitTransaction();
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Checklist öğesini verilen ABSOLUTE değere ayarlar (idempotent).
   *
   * FARM-HIGH-057: the old `toggleChecklistItem` FLIPPED the item, so a replayed
   * offline toggle REVERTED it (lost update). This SETS `isCompleted` to the
   * supplied absolute value, so any number of replays converge to the same state
   * (idempotent by construction). The at-most-once receipt also short-circuits a
   * replay to the stored task, and `completedAt` is derived from the target state.
   *
   * SEC-HIGH-050: only the assignee or a MODULE_MANAGER+ may set checklist items.
   */
  async setChecklistItem(
    tenantId: string,
    taskId: string,
    itemId: string,
    isCompleted: boolean,
    caller: SelfScopeCaller,
    envelope?: MobileCommandEnvelope | null,
  ): Promise<Task> {
    const userId = caller.sub;

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();
    try {
      const receipt = await this.mobileCommandReceipts.begin(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        tenantId,
        envelope,
        operationType: 'setChecklistItem',
        responseType: 'Task',
      });

      if (receipt.mode === 'replay') {
        const replayed = receipt.responseId
          ? await queryRunner.manager.findOne(Task, {
              where: { id: receipt.responseId, tenantId },
            })
          : null;
        if (!replayed) {
          throw new ConflictException('Mobile command receipt response is no longer available');
        }
        await queryRunner.commitTransaction();
        return replayed;
      }

      if (receipt.mode === 'legacy') {
        throw new BadRequestException(
          'setChecklistItem requires an idempotency envelope (clientCommandId + payloadHash)',
        );
      }

      const task = await queryRunner.manager.findOne(Task, {
        where: { id: taskId, tenantId },
      });
      if (!task) {
        throw new NotFoundException(`Görev bulunamadı: ${taskId}`);
      }

      // SEC-HIGH-050: object-level authorization beneath the @Roles gate.
      assertSelfOrManager({ ownerId: task.assignedTo, caller });

      if (!Array.isArray(task.checklistItems)) {
        throw new BadRequestException('Görevde checklist bulunamadı');
      }

      // Normalise the whole list so any legacy rows (missing id, or `completed`
      // instead of `isCompleted`) are repaired on the same save.
      task.checklistItems = task.checklistItems.map((i) =>
        TaskService.normaliseChecklistItem(i),
      );

      const item = task.checklistItems.find((i) => i.id === itemId);
      if (!item) {
        throw new NotFoundException(`Checklist öğesi bulunamadı: ${itemId}`);
      }

      // Idempotent SET to the absolute target value (not a flip).
      item.isCompleted = isCompleted;
      item.completedAt = isCompleted ? new Date().toISOString() : null;
      item.completedBy = isCompleted ? userId : undefined;

      const saved = await queryRunner.manager.save(task);

      await this.mobileCommandReceipts.complete(queryRunner.manager, {
        tableName: 'farm_mobile_command_receipts',
        receipt,
        responseType: 'Task',
        responseId: saved.id,
        responsePayload: { id: saved.id },
      });

      await queryRunner.commitTransaction();
      return saved;
    } catch (error) {
      await queryRunner.rollbackTransaction();
      throw error;
    } finally {
      await queryRunner.release();
    }
  }

  /**
   * Göreve not ekler
   *
   * SEC-HIGH-050: only the assignee or a MODULE_MANAGER+ may add a note.
   */
  async addNote(
    tenantId: string,
    taskId: string,
    text: string,
    caller: SelfScopeCaller,
  ): Promise<Task> {
    const userId = caller.sub;

    if (!text || text.trim().length === 0) {
      throw new BadRequestException('Not metni boş olamaz');
    }
    if (text.length > 2000) {
      throw new BadRequestException('Not metni en fazla 2000 karakter olabilir');
    }

    const task = await this.findById(tenantId, taskId);

    // SEC-HIGH-050: object-level authorization beneath the @Roles gate.
    assertSelfOrManager({ ownerId: task.assignedTo, caller });

    if (!Array.isArray(task.notes)) {
      task.notes = [];
    }

    task.notes.push({
      id: crypto.randomUUID(),
      text,
      createdBy: userId,
      createdAt: new Date().toISOString(),
    });

    return this.taskRepository.save(task);
  }

  /**
   * Görevi siler
   */
  async delete(tenantId: string, taskId: string): Promise<boolean> {
    const task = await this.findById(tenantId, taskId);

    if (task.status === TaskStatus.IN_PROGRESS) {
      throw new BadRequestException('Devam eden görevler silinemez');
    }

    await this.taskRepository.softRemove(task);
    return true;
  }

  // -------------------------------------------------------------------------
  // TENANT SCHEMA HELPERS
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // OVERDUE DETECTION (CRON)
  // -------------------------------------------------------------------------

  /**
   * Gecikmiş görevleri her 30 dakikada bir tespit eder.
   * Iterates ALL tenant schemas to ensure no tenant is missed.
   */
  @Cron('0 */30 * * * *')
  async detectOverdueTasks(): Promise<void> {
    this.logger.log('Running overdue task detection across all tenant schemas...');
    const now = new Date();

    const tenantSchemas = await listTenantSchemas(this.dataSource);
    if (tenantSchemas.length === 0) {
      this.logger.debug('No tenant schemas found, skipping overdue detection');
      return;
    }

    this.logger.log(`Processing overdue detection for ${tenantSchemas.length} tenant schemas`);

    for (const schema of tenantSchemas) {
      const queryRunner = this.dataSource.createQueryRunner();
      await queryRunner.connect();

      try {
        await queryRunner.query(`SET search_path TO "${schema}", farm, public`);

        // Atomic: the SELECT FOR UPDATE lock, the OVERDUE write and every
        // TaskOverdue outbox enqueue all live in ONE transaction. Without it
        // the FOR UPDATE lock would release under autocommit and the events
        // would be fire-and-forget; now the row flip and its events commit or
        // roll back together (at-least-once delivery).
        await queryRunner.startTransaction();
        try {
          const overdueTasks: Task[] = await queryRunner.query(
            `SELECT * FROM tasks
             WHERE status IN ($1, $2)
             AND "dueDate" < $3
             AND "deletedAt" IS NULL
             FOR UPDATE SKIP LOCKED`,
            [TaskStatus.PENDING, TaskStatus.IN_PROGRESS, now],
          );

          if (overdueTasks.length === 0) {
            await queryRunner.commitTransaction();
            continue;
          }

          const ids = overdueTasks.map((t) => t.id);
          await queryRunner.query(
            `UPDATE tasks SET status = $1, "updatedAt" = NOW() WHERE id = ANY($2::uuid[])`,
            [TaskStatus.OVERDUE, ids],
          );

          // Group by tenant for event publishing
          const tasksByTenant = new Map<string, Task[]>();
          for (const task of overdueTasks) {
            const tenantTasks = tasksByTenant.get(task.tenantId) || [];
            tenantTasks.push(task);
            tasksByTenant.set(task.tenantId, tenantTasks);
          }

          for (const [tenantId, tasks] of tasksByTenant) {
            for (const task of tasks) {
              const hoursOverdue = Math.round(
                (now.getTime() - new Date(task.dueDate).getTime()) / 3600000,
              );
              await this.outboxPublisher.enqueue(
                {
                  ...createBaseEvent('TaskOverdue', tenantId),
                  taskId: task.id,
                  title: task.title,
                  assignedTo: task.assignedTo,
                  dueDate: new Date(task.dueDate).toISOString(),
                  priority: task.priority,
                  hoursOverdue,
                },
                queryRunner.manager,
              );
            }
            this.logger.log(
              `Marked ${tasks.length} tasks as overdue for tenant ${tenantId} (schema: ${schema})`,
            );
          }

          await queryRunner.commitTransaction();
        } catch (txErr) {
          await queryRunner.rollbackTransaction();
          throw txErr;
        }
      } catch (err) {
        this.logger.error(
          `Overdue detection failed for schema ${schema}: ${(err as Error).message}`,
        );
      } finally {
        await queryRunner.query('RESET search_path').catch(() => {});
        await queryRunner.release();
      }
    }
  }
}
