import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between } from 'typeorm';
import {
  TenantActivity,
  ActivityType,
  TenantNote,
  TenantBillingInfo,
} from '../entities/tenant-activity.entity';

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
    this.logger.log(
      `Activity logged: ${dto.activityType} for tenant ${dto.tenantId}`,
    );
    return saved;
  }

  async getActivities(
    tenantId: string,
    options?: {
      limit?: number;
      offset?: number;
      activityTypes?: ActivityType[];
      startDate?: Date;
      endDate?: Date;
    },
  ): Promise<{ data: TenantActivity[]; total: number }> {
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

    const total = await query.getCount();

    if (options?.offset) {
      query.skip(options.offset);
    }
    if (options?.limit) {
      query.take(options.limit);
    }

    const data = await query.getMany();
    return { data, total };
  }

  async getRecentActivities(
    tenantId: string,
    limit: number = 20,
  ): Promise<TenantActivity[]> {
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
  ): Promise<TenantNote> {
    await this.noteRepository.update(noteId, updates);
    const note = await this.noteRepository.findOneOrFail({
      where: { id: noteId },
    });
    return note;
  }

  async deleteNote(noteId: string): Promise<void> {
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

  async logTenantCreated(
    tenantId: string,
    tenantName: string,
    performedBy: string,
  ): Promise<void> {
    await this.logActivity({
      tenantId,
      activityType: ActivityType.CREATED,
      title: 'Tenant olusturuldu',
      description: `${tenantName} tenant'i olusturuldu`,
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
      title: 'Plan degistirildi',
      description: `Plan ${previousPlan} -> ${newPlan} olarak guncellendi`,
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
      title: 'Modul atandi',
      description: `${moduleName} modulu atandi`,
      metadata: { moduleName },
      performedBy,
    });
  }

  async logModuleRemoved(
    tenantId: string,
    moduleName: string,
    performedBy: string,
  ): Promise<void> {
    await this.logActivity({
      tenantId,
      activityType: ActivityType.MODULE_REMOVED,
      title: 'Modul kaldirildi',
      description: `${moduleName} modulu kaldirildi`,
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
      title: `Durum degistirildi: ${newStatus}`,
      description: reason || `Durum ${previousStatus} -> ${newStatus}`,
      previousValue: { status: previousStatus },
      newValue: { status: newStatus },
      performedBy,
    });
  }
}
