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
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThan } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { NatsEventBus } from '@platform/event-bus';
import { createBaseEvent } from '@platform/event-contracts';
import { Task, TaskStatus, TaskPriority } from '../entities/task.entity';
import { RecurringTemplate } from '../entities/recurring-template.entity';
import { CreateTaskInput } from '../dto/create-task.dto';
import { UpdateTaskInput } from '../dto/update-task.dto';
import { TaskFilterInput } from '../dto/task-filter.dto';
import { EventNames } from '../../events/event-types';

@Injectable()
export class TaskService {
  private readonly logger = new Logger(TaskService.name);

  constructor(
    @InjectRepository(Task)
    private readonly taskRepository: Repository<Task>,
    @InjectRepository(RecurringTemplate)
    private readonly recurringTemplateRepository: Repository<RecurringTemplate>,
    @Optional() @Inject('EVENT_BUS')
    private readonly eventBus?: NatsEventBus,
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
      checklistItems: input.checklistItems || [],
      notes: [],
      tags: input.tags,
      isRecurring: input.isRecurring || false,
      recurringTemplateId: input.recurringTemplateId,
    });

    const saved = await this.taskRepository.save(task);
    this.logger.log(`Task created: ${saved.id}`);

    // Publish TaskCreated event
    if (this.eventBus) {
      try {
        await this.eventBus.publish({
          ...createBaseEvent('TaskCreated', tenantId, { userId: createdBy }),
          taskId: saved.id,
          title: saved.title,
          category: saved.category,
          priority: saved.priority,
          assignedTo: saved.assignedTo,
          assignedToName: saved.assignedToName,
          dueDate: input.dueDate,
          createdBy,
        });
        this.logger.debug(`Published TaskCreated event for task ${saved.id}`);
      } catch (eventError) {
        this.logger.warn(`Failed to publish TaskCreated event: ${(eventError as Error).message}`);
      }
    }

    return saved;
  }

  /**
   * Görevi günceller
   */
  async update(
    tenantId: string,
    input: UpdateTaskInput,
    userId: string,
  ): Promise<Task> {
    const task = await this.findById(tenantId, input.id);
    const previousAssignedTo = task.assignedTo;

    if (input.title !== undefined) task.title = input.title;
    if (input.description !== undefined) task.description = input.description;
    if (input.category !== undefined) task.category = input.category;
    if (input.priority !== undefined) task.priority = input.priority;
    if (input.status !== undefined) task.status = input.status;
    if (input.assignedTo !== undefined) task.assignedTo = input.assignedTo;
    if (input.assignedToName !== undefined) task.assignedToName = input.assignedToName;
    if (input.dueDate !== undefined) task.dueDate = new Date(input.dueDate);
    if (input.dueTime !== undefined) task.dueTime = input.dueTime;
    if (input.siteId !== undefined) task.siteId = input.siteId;
    if (input.location !== undefined) task.location = input.location;
    if (input.estimatedMinutes !== undefined) task.estimatedMinutes = input.estimatedMinutes;
    if (input.checklistItems !== undefined) task.checklistItems = input.checklistItems;
    if (input.notes !== undefined) task.notes = input.notes;
    if (input.tags !== undefined) task.tags = input.tags;
    if (input.isRecurring !== undefined) task.isRecurring = input.isRecurring;
    if (input.recurringTemplateId !== undefined) task.recurringTemplateId = input.recurringTemplateId;

    const saved = await this.taskRepository.save(task);

    // Publish TaskAssigned event if assignee changed
    if (input.assignedTo && input.assignedTo !== previousAssignedTo && this.eventBus) {
      try {
        await this.eventBus.publish({
          ...createBaseEvent('TaskAssigned', tenantId, { userId }),
          taskId: saved.id,
          title: saved.title,
          assignedTo: saved.assignedTo,
          assignedBy: userId,
          dueDate: saved.dueDate.toISOString(),
          priority: saved.priority,
        });
        this.logger.debug(`Published TaskAssigned event for task ${saved.id}`);
      } catch (eventError) {
        this.logger.warn(`Failed to publish TaskAssigned event: ${(eventError as Error).message}`);
      }
    }

    return saved;
  }

  /**
   * ID ile görev bulur
   */
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
   * Filtrelenmiş görevleri listeler (sayfalama destekli)
   */
  async findAll(
    tenantId: string,
    filter?: TaskFilterInput,
  ): Promise<{ items: Task[]; total: number; hasMore: boolean }> {
    const limit = filter?.limit || 50;
    const offset = filter?.offset || 0;

    const query = this.taskRepository
      .createQueryBuilder('task')
      .where('task.tenantId = :tenantId', { tenantId });

    // Apply filters
    if (filter?.status?.length) {
      query.andWhere('task.status IN (:...statuses)', { statuses: filter.status });
    }
    if (filter?.category?.length) {
      query.andWhere('task.category IN (:...categories)', { categories: filter.category });
    }
    if (filter?.priority?.length) {
      query.andWhere('task.priority IN (:...priorities)', { priorities: filter.priority });
    }
    if (filter?.assignedTo) {
      query.andWhere('task.assignedTo = :assignedTo', { assignedTo: filter.assignedTo });
    }
    if (filter?.dateFrom) {
      query.andWhere('task.dueDate >= :dateFrom', { dateFrom: new Date(filter.dateFrom) });
    }
    if (filter?.dateTo) {
      query.andWhere('task.dueDate <= :dateTo', { dateTo: new Date(filter.dateTo) });
    }
    if (filter?.search) {
      query.andWhere(
        '(task.title ILIKE :search OR task.description ILIKE :search)',
        { search: `%${filter.search}%` },
      );
    }

    const total = await query.getCount();

    query
      .orderBy('task.dueDate', 'ASC')
      .addOrderBy('task.priority', 'ASC')
      .skip(offset)
      .take(limit);

    const items = await query.getMany();

    return {
      items,
      total,
      hasMore: offset + items.length < total,
    };
  }

  /**
   * Kullanıcıya atanmış görevleri getirir
   */
  async findByAssignee(
    tenantId: string,
    userId: string,
    statuses?: TaskStatus[],
  ): Promise<Task[]> {
    const whereClause: Record<string, unknown> = {
      tenantId,
      assignedTo: userId,
    };

    if (statuses?.length) {
      whereClause.status = In(statuses);
    }

    return this.taskRepository.find({
      where: whereClause,
      order: { dueDate: 'ASC', priority: 'ASC' },
    });
  }

  /**
   * Bugünün görevlerini getirir
   */
  async findTodaysTasks(tenantId: string): Promise<Task[]> {
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    return this.taskRepository
      .createQueryBuilder('task')
      .where('task.tenantId = :tenantId', { tenantId })
      .andWhere('task.dueDate >= :startOfDay', { startOfDay })
      .andWhere('task.dueDate < :endOfDay', { endOfDay })
      .andWhere('task.status != :cancelled', { cancelled: TaskStatus.CANCELLED })
      .orderBy('task.priority', 'ASC')
      .addOrderBy('task.dueTime', 'ASC')
      .getMany();
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
   */
  async completeTask(
    tenantId: string,
    taskId: string,
    completedBy: string,
  ): Promise<Task> {
    const task = await this.findById(tenantId, taskId);

    if (task.status === TaskStatus.COMPLETED) {
      throw new BadRequestException('Görev zaten tamamlanmış');
    }
    if (task.status === TaskStatus.CANCELLED) {
      throw new BadRequestException('İptal edilmiş görev tamamlanamaz');
    }

    task.status = TaskStatus.COMPLETED;
    task.completedAt = new Date();
    task.completedBy = completedBy;

    const saved = await this.taskRepository.save(task);

    // Publish TaskCompleted event
    if (this.eventBus) {
      try {
        await this.eventBus.publish({
          ...createBaseEvent('TaskCompleted', tenantId, { userId: completedBy }),
          taskId: saved.id,
          title: saved.title,
          completedBy,
          completedAt: saved.completedAt,
          assignedTo: saved.assignedTo,
        });
        this.logger.debug(`Published TaskCompleted event for task ${saved.id}`);
      } catch (eventError) {
        this.logger.warn(`Failed to publish TaskCompleted event: ${(eventError as Error).message}`);
      }
    }

    return saved;
  }

  /**
   * Görevi başlatır (IN_PROGRESS)
   */
  async startTask(
    tenantId: string,
    taskId: string,
    userId: string,
  ): Promise<Task> {
    const task = await this.findById(tenantId, taskId);

    if (task.status !== TaskStatus.PENDING && task.status !== TaskStatus.OVERDUE) {
      throw new BadRequestException(
        'Sadece bekleyen veya gecikmiş görevler başlatılabilir',
      );
    }

    task.status = TaskStatus.IN_PROGRESS;
    const saved = await this.taskRepository.save(task);

    // Publish status change event
    if (this.eventBus) {
      try {
        await this.eventBus.publish({
          ...createBaseEvent('TaskStatusChanged', tenantId, { userId }),
          taskId: saved.id,
          title: saved.title,
          previousStatus: TaskStatus.PENDING,
          newStatus: TaskStatus.IN_PROGRESS,
        });
      } catch (eventError) {
        this.logger.warn(`Failed to publish TaskStatusChanged event: ${(eventError as Error).message}`);
      }
    }

    return saved;
  }

  /**
   * Checklist öğesini toggle eder
   */
  async toggleChecklistItem(
    tenantId: string,
    taskId: string,
    itemId: string,
  ): Promise<Task> {
    const task = await this.findById(tenantId, taskId);

    if (!Array.isArray(task.checklistItems)) {
      throw new BadRequestException('Görevde checklist bulunamadı');
    }

    const item = task.checklistItems.find((i: any) => i.id === itemId);
    if (!item) {
      throw new NotFoundException(`Checklist öğesi bulunamadı: ${itemId}`);
    }

    item.completed = !item.completed;
    item.completedAt = item.completed ? new Date().toISOString() : null;

    return this.taskRepository.save(task);
  }

  /**
   * Göreve not ekler
   */
  async addNote(
    tenantId: string,
    taskId: string,
    text: string,
    userId: string,
  ): Promise<Task> {
    const task = await this.findById(tenantId, taskId);

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

    await this.taskRepository.remove(task);
    return true;
  }

  /**
   * Görev istatistiklerini hesaplar
   */
  async getStats(tenantId: string): Promise<{
    totalToday: number;
    completedToday: number;
    overdueCount: number;
    upcomingCount: number;
    completionRate: number;
    avgCompletionMinutes: number;
  }> {
    const today = new Date();
    const startOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const endOfDay = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const endOfWeek = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7);

    // Today's tasks
    const todayTasks = await this.taskRepository
      .createQueryBuilder('task')
      .where('task.tenantId = :tenantId', { tenantId })
      .andWhere('task.dueDate >= :startOfDay', { startOfDay })
      .andWhere('task.dueDate < :endOfDay', { endOfDay })
      .andWhere('task.status != :cancelled', { cancelled: TaskStatus.CANCELLED })
      .getMany();

    const totalToday = todayTasks.length;
    const completedToday = todayTasks.filter(
      (t) => t.status === TaskStatus.COMPLETED,
    ).length;

    // Overdue count
    const overdueCount = await this.taskRepository.count({
      where: {
        tenantId,
        status: TaskStatus.OVERDUE,
      },
    });

    // Upcoming tasks (next 7 days, excluding today)
    const upcomingCount = await this.taskRepository
      .createQueryBuilder('task')
      .where('task.tenantId = :tenantId', { tenantId })
      .andWhere('task.dueDate >= :endOfDay', { endOfDay })
      .andWhere('task.dueDate < :endOfWeek', { endOfWeek })
      .andWhere('task.status IN (:...activeStatuses)', {
        activeStatuses: [TaskStatus.PENDING, TaskStatus.IN_PROGRESS],
      })
      .getCount();

    // Completion rate (last 30 days)
    const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const recentTasks = await this.taskRepository
      .createQueryBuilder('task')
      .where('task.tenantId = :tenantId', { tenantId })
      .andWhere('task.createdAt >= :thirtyDaysAgo', { thirtyDaysAgo })
      .andWhere('task.status != :cancelled', { cancelled: TaskStatus.CANCELLED })
      .getMany();

    const totalRecent = recentTasks.length;
    const completedRecent = recentTasks.filter(
      (t) => t.status === TaskStatus.COMPLETED,
    ).length;
    const completionRate = totalRecent > 0
      ? Math.round((completedRecent / totalRecent) * 100)
      : 0;

    // Average completion time
    const completedWithTime = recentTasks.filter(
      (t) => t.status === TaskStatus.COMPLETED && t.completedAt && t.createdAt,
    );
    let avgCompletionMinutes = 0;
    if (completedWithTime.length > 0) {
      const totalMinutes = completedWithTime.reduce((sum, t) => {
        const diff = new Date(t.completedAt!).getTime() - new Date(t.createdAt).getTime();
        return sum + diff / 60000;
      }, 0);
      avgCompletionMinutes = Math.round(totalMinutes / completedWithTime.length);
    }

    return {
      totalToday,
      completedToday,
      overdueCount,
      upcomingCount,
      completionRate,
      avgCompletionMinutes,
    };
  }

  // -------------------------------------------------------------------------
  // OVERDUE DETECTION (CRON)
  // -------------------------------------------------------------------------

  /**
   * Gecikmiş görevleri her 30 dakikada bir tespit eder
   */
  @Cron('0 */30 * * * *')
  async detectOverdueTasks(): Promise<void> {
    this.logger.log('Running overdue task detection...');

    const now = new Date();

    const overdueTasks = await this.taskRepository.find({
      where: {
        status: In([TaskStatus.PENDING, TaskStatus.IN_PROGRESS]),
        dueDate: LessThan(now),
      },
    });

    if (overdueTasks.length === 0) {
      this.logger.debug('No overdue tasks found');
      return;
    }

    // Group by tenant for event publishing
    const tasksByTenant = new Map<string, Task[]>();
    for (const task of overdueTasks) {
      const tenantTasks = tasksByTenant.get(task.tenantId) || [];
      tenantTasks.push(task);
      tasksByTenant.set(task.tenantId, tenantTasks);
    }

    // Update status and publish events
    for (const [tenantId, tasks] of tasksByTenant) {
      for (const task of tasks) {
        task.status = TaskStatus.OVERDUE;
      }
      await this.taskRepository.save(tasks);

      // Publish overdue events
      if (this.eventBus) {
        for (const task of tasks) {
          try {
            const hoursOverdue = Math.round(
              (now.getTime() - new Date(task.dueDate).getTime()) / 3600000,
            );
            await this.eventBus.publish({
              ...createBaseEvent('TaskOverdue', tenantId),
              taskId: task.id,
              title: task.title,
              assignedTo: task.assignedTo,
              dueDate: task.dueDate.toISOString(),
              priority: task.priority,
              hoursOverdue,
            });
          } catch (eventError) {
            this.logger.warn(
              `Failed to publish TaskOverdue event for task ${task.id}: ${(eventError as Error).message}`,
            );
          }
        }
      }

      this.logger.log(`Marked ${tasks.length} tasks as overdue for tenant ${tenantId}`);
    }
  }
}
