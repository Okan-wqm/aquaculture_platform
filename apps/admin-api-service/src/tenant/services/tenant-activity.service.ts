import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  createStandardPaginatedResult,
  type IStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';
import { Repository, Between } from 'typeorm';

import {
  TenantActivity,
  ActivityType,
  TenantNote,
  TenantBillingInfo,
} from '../entities/tenant-activity.entity';

const DEFAULT_ACTIVITY_PAGE_SIZE = 20;

export interface CreateActivityDto {
  tenantId: string;
  activityType: ActivityType;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  previousValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
  performedBy?: string;
  performedByEmail?: string;
}

export interface CreateNoteDto {
  tenantId: string;
  content: string;
  category?: string;
  isPinned?: boolean;
  createdBy: string;
  createdByEmail?: string;
}

@Injectable()
export class TenantActivityService {
  private readonly logger = new Logger(TenantActivityService.name);

  constructor(
    @InjectRepository(TenantActivity)
    private readonly activityRepository: Repository<TenantActivity>,
    @InjectRepository(TenantNote)
    private readonly noteRepository: Repository<TenantNote>,
    @InjectRepository(TenantBillingInfo)
    private readonly billingRepository: Repository<TenantBillingInfo>,
  ) {}

  // ============================================================================
  // Activity Methods
  // ============================================================================

  async logActivity(dto: CreateActivityDto): Promise<TenantActivity> {
    const activity = this.activityRepository.create(dto);
    const saved = await this.activityRepository.save(activity);
    this.logger.log(`Activity logged: ${dto.activityType} for tenant ${dto.tenantId}`);
    return saved;
  }

  async getActivities(
    tenantId: string,
    options?: {
      page?: number;
      limit?: number;
      activityTypes?: ActivityType[];
      startDate?: Date;
      endDate?: Date;
    },
  ): Promise<IStandardPaginatedResult<TenantActivity>> {
    const query = this.activityRepository
      .createQueryBuilder('activity')
      .where('activity.tenantId = :tenantId', { tenantId })
      .orderBy('activity.createdAt', 'DESC');

    if (options?.activityTypes?.length) {
      query.andWhere('activity.activityType IN (:...types)', {
        types: options.activityTypes,
      });
    }

    if (options?.startDate && options?.endDate) {
      query.andWhere('activity.createdAt BETWEEN :start AND :end', {
        start: options.startDate,
        end: options.endDate,
      });
    }

    const page = Math.max(1, options?.page ?? 1);
    const limit = Math.max(1, options?.limit ?? DEFAULT_ACTIVITY_PAGE_SIZE);

    // TypeORM's count sub-query ignores skip/take, so total always describes
    // the complete filtered set while the data window is derived once here.
    query.skip((page - 1) * limit).take(limit);

    const [items, total] = await query.getManyAndCount();
    return createStandardPaginatedResult(items, total, page, limit);
  }

  async getRecentActivities(tenantId: string, limit = 20): Promise<TenantActivity[]> {
    return this.activityRepository.find({
      where: { tenantId },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  // ============================================================================
  // Note Methods
  // ============================================================================

  async createNote(dto: CreateNoteDto): Promise<TenantNote> {
    const note = this.noteRepository.create({
      ...dto,
      category: dto.category || 'general',
      isPinned: dto.isPinned || false,
    });
    return this.noteRepository.save(note);
  }

  async getNotes(
    tenantId: string,
    options?: { category?: string; limit?: number },
  ): Promise<TenantNote[]> {
    const query = this.noteRepository
      .createQueryBuilder('note')
      .where('note.tenantId = :tenantId', { tenantId })
      .orderBy('note.isPinned', 'DESC')
      .addOrderBy('note.createdAt', 'DESC');

    if (options?.category) {
      query.andWhere('note.category = :category', {
        category: options.category,
      });
    }

    if (options?.limit) {
      query.take(options.limit);
    }

    return query.getMany();
  }

  async updateNote(
    noteId: string,
    updates: { content?: string; isPinned?: boolean; category?: string },
    tenantId?: string,
  ): Promise<TenantNote> {
    // HIGH-004 fix: verify tenant ownership if tenantId is provided
    if (tenantId) {
      const existing = await this.noteRepository.findOne({ where: { id: noteId } });
      if (!existing) {
        throw new Error(`Note not found: ${noteId}`);
      }
      if (existing.tenantId !== tenantId) {
        throw new Error('Note does not belong to the specified tenant');
      }
    }
    await this.noteRepository.update(noteId, updates);
    const note = await this.noteRepository.findOneOrFail({
      where: { id: noteId },
    });
    return note;
  }

  async deleteNote(noteId: string, tenantId?: string): Promise<void> {
    // HIGH-004 fix: verify tenant ownership if tenantId is provided
    if (tenantId) {
      const existing = await this.noteRepository.findOne({ where: { id: noteId } });
      if (!existing) {
        throw new Error(`Note not found: ${noteId}`);
      }
      if (existing.tenantId !== tenantId) {
        throw new Error('Note does not belong to the specified tenant');
      }
    }
    await this.noteRepository.delete(noteId);
  }

  // ============================================================================
  // Billing Methods
  // ============================================================================

  async getBillingInfo(tenantId: string): Promise<TenantBillingInfo | null> {
    return this.billingRepository.findOne({ where: { tenantId } });
  }

  async createOrUpdateBillingInfo(
    tenantId: string,
    data: Partial<TenantBillingInfo>,
  ): Promise<TenantBillingInfo> {
    let billing = await this.billingRepository.findOne({ where: { tenantId } });

    if (billing) {
      Object.assign(billing, data);
    } else {
      billing = this.billingRepository.create({ tenantId, ...data });
    }

    return this.billingRepository.save(billing);
  }

  // ============================================================================
  // Helper Methods for Common Activities
  // ============================================================================

  // BUG-032 fix: use English for activity log titles (audit/compliance data)
  async logTenantCreated(tenantId: string, tenantName: string, performedBy: string): Promise<void> {
    await this.logActivity({
      tenantId,
      activityType: ActivityType.CREATED,
      title: 'Tenant created',
      description: `Tenant "${tenantName}" was created`,
      performedBy,
    });
  }

  async logPlanChanged(
    tenantId: string,
    previousPlan: string,
    newPlan: string,
    performedBy: string,
  ): Promise<void> {
    await this.logActivity({
      tenantId,
      activityType: ActivityType.PLAN_CHANGED,
      title: 'Plan changed',
      description: `Plan changed from ${previousPlan} to ${newPlan}`,
      previousValue: { plan: previousPlan },
      newValue: { plan: newPlan },
      performedBy,
    });
  }

  async logModuleAssigned(
    tenantId: string,
    moduleName: string,
    performedBy: string,
  ): Promise<void> {
    await this.logActivity({
      tenantId,
      activityType: ActivityType.MODULE_ASSIGNED,
      title: 'Module assigned',
      description: `Module "${moduleName}" was assigned`,
      metadata: { moduleName },
      performedBy,
    });
  }

  async logModuleRemoved(tenantId: string, moduleName: string, performedBy: string): Promise<void> {
    await this.logActivity({
      tenantId,
      activityType: ActivityType.MODULE_REMOVED,
      title: 'Module removed',
      description: `Module "${moduleName}" was removed`,
      metadata: { moduleName },
      performedBy,
    });
  }

  async logStatusChange(
    tenantId: string,
    previousStatus: string,
    newStatus: string,
    reason: string | undefined,
    performedBy: string,
  ): Promise<void> {
    const activityTypeMap: Record<string, ActivityType> = {
      active: ActivityType.ACTIVATED,
      suspended: ActivityType.SUSPENDED,
      deactivated: ActivityType.DEACTIVATED,
    };

    await this.logActivity({
      tenantId,
      activityType: activityTypeMap[newStatus] || ActivityType.SETTINGS_UPDATED,
      title: `Status changed: ${newStatus}`,
      description: reason || `Status changed from ${previousStatus} to ${newStatus}`,
      previousValue: { status: previousStatus },
      newValue: { status: newStatus },
      performedBy,
    });
  }
}
