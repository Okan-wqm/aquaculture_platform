import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Role } from '@aquaculture/backend-common/decorators';
import {
  createBaseEvent,
  type AnnouncementPublishedEvent,
} from '@platform/event-contracts';
import { OutboxPublisher } from '@platform/outbox';
import {
  Repository,
  In,
  DataSource,
  EntityManager,
  LessThanOrEqual,
} from 'typeorm';

import { User } from '../../authentication/entities/user.entity';
import { Tenant, TenantStatus } from '../../tenant/entities/tenant.entity';
import {
  CreatePlatformAnnouncementInput,
  CreateTenantAnnouncementInput,
  UpdateAnnouncementInput,
  AnnouncementListItem,
  AnnouncementStats,
} from '../dto/announcement.dto';
import { AnnouncementAcknowledgment } from '../entities/announcement-acknowledgment.entity';
import {
  Announcement,
  AnnouncementType,
  AnnouncementStatus,
  AnnouncementScope,
} from '../entities/announcement.entity';

/**
 * AnnouncementService
 *
 * Handles announcement operations for both SuperAdmin and TenantAdmin.
 * SuperAdmin: Platform-wide announcements (global or targeted)
 * TenantAdmin: Tenant-level announcements (for their users)
 */
@Injectable()
export class AnnouncementService {
  private readonly logger = new Logger(AnnouncementService.name);

  constructor(
    @InjectRepository(Announcement)
    private readonly announcementRepository: Repository<Announcement>,
    @InjectRepository(AnnouncementAcknowledgment)
    private readonly acknowledgmentRepository: Repository<AnnouncementAcknowledgment>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    // APA-201: the AnnouncementPublished delivery event is enqueued to
    // auth_outbox inside the SAME transaction as the DRAFT/SCHEDULED -> PUBLISHED
    // status flip, so notification-service's MessagingEventHandler (which
    // subscribes to AnnouncementPublished) can only ever see an event whose
    // status write has committed. OutboxPublisher is provided globally by
    // AuthOutboxModule.
    private readonly outboxPublisher: OutboxPublisher,
  ) {}

  // =========================================================
  // Get Announcements
  // =========================================================

  /**
   * Get announcements for a user
   * SuperAdmin: All platform announcements
   * TenantAdmin: Platform announcements targeting their tenant + tenant-level announcements
   */
  async getAnnouncements(
    userId: string,
    filters?: { status?: AnnouncementStatus; type?: AnnouncementType },
  ): Promise<AnnouncementListItem[]> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    let query = this.announcementRepository
      .createQueryBuilder('announcement')
      .orderBy('announcement.createdAt', 'DESC');

    if (user.role === Role.SUPER_ADMIN) {
      // SuperAdmin sees all platform announcements
      query = query.where('announcement.scope = :scope', {
        scope: AnnouncementScope.PLATFORM,
      });
    } else if (user.role === Role.TENANT_ADMIN && user.tenantId) {
      // TenantAdmin sees:
      // 1. Active platform announcements targeting their tenant
      // 2. Tenant-level announcements for their tenant
      query = query.where(
        '(announcement.scope = :platform AND announcement.status = :published) OR (announcement.scope = :tenant AND announcement.tenantId = :tenantId)',
        {
          platform: AnnouncementScope.PLATFORM,
          published: AnnouncementStatus.PUBLISHED,
          tenant: AnnouncementScope.TENANT,
          tenantId: user.tenantId,
        },
      );
    } else {
      return [];
    }

    // Apply filters
    if (filters?.status) {
      query = query.andWhere('announcement.status = :status', {
        status: filters.status,
      });
    }

    if (filters?.type) {
      query = query.andWhere('announcement.type = :type', {
        type: filters.type,
      });
    }

    const announcements = await query.getMany();

    // Get acknowledgment status for tenant admin
    let acknowledgments: Map<string, AnnouncementAcknowledgment> = new Map();
    if (user.role === Role.TENANT_ADMIN) {
      const acks = await this.acknowledgmentRepository.find({
        where: {
          userId: user.id,
          announcementId: In(announcements.map((a) => a.id)),
        },
      });
      acknowledgments = new Map(acks.map((a) => [a.announcementId, a]));
    }

    return announcements.map((a) => {
      const ack = acknowledgments.get(a.id);
      return {
        id: a.id,
        title: a.title,
        content: a.content,
        type: a.type,
        status: a.status,
        scope: a.scope,
        isGlobal: a.isGlobal,
        publishAt: a.publishAt ?? null,
        expiresAt: a.expiresAt ?? null,
        requiresAcknowledgment: a.requiresAcknowledgment,
        viewCount: a.viewCount,
        acknowledgmentCount: a.acknowledgmentCount,
        createdByName: a.createdByName,
        createdAt: a.createdAt,
        isActive: a.isActive(),
        hasViewed: ack ? true : false,
        hasAcknowledged: ack?.hasAcknowledged() || false,
      };
    });
  }

  /**
   * Get a single announcement
   */
  async getAnnouncement(
    userId: string,
    announcementId: string,
  ): Promise<Announcement> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const announcement = await this.announcementRepository.findOne({
      where: { id: announcementId },
    });

    if (!announcement) throw new NotFoundException('Announcement not found');

    // Access control
    if (user.role === Role.SUPER_ADMIN) {
      // SuperAdmin can access all platform announcements
      if (announcement.scope !== AnnouncementScope.PLATFORM) {
        throw new ForbiddenException('Access denied');
      }
    } else if (user.role === Role.TENANT_ADMIN) {
      // TenantAdmin can access:
      // - Platform announcements targeting their tenant
      // - Their tenant's announcements
      if (
        announcement.scope === AnnouncementScope.TENANT &&
        announcement.tenantId !== user.tenantId
      ) {
        throw new ForbiddenException('Access denied');
      }
    }

    return announcement;
  }

  // =========================================================
  // Create Announcements
  // =========================================================

  /**
   * Create a platform-wide announcement (SuperAdmin only)
   */
  async createPlatformAnnouncement(
    userId: string,
    input: CreatePlatformAnnouncementInput,
  ): Promise<Announcement> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user || user.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Only SuperAdmin can create platform announcements');
    }

    const status = input.publishAt
      ? AnnouncementStatus.SCHEDULED
      : AnnouncementStatus.DRAFT;

    const announcement = this.announcementRepository.create({
      title: input.title,
      content: input.content,
      type: input.type,
      status,
      scope: AnnouncementScope.PLATFORM,
      tenantId: null,
      isGlobal: input.isGlobal,
      targetCriteria: input.targetCriteria || null,
      publishAt: input.publishAt ? new Date(input.publishAt) : null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      requiresAcknowledgment: input.requiresAcknowledgment,
      createdBy: userId,
      createdByName: user.getDisplayName(),
    });

    const saved = await this.announcementRepository.save(announcement);
    this.logger.log(`Platform announcement created: ${saved.id}`);
    return saved;
  }

  /**
   * Create a tenant-level announcement (TenantAdmin)
   */
  async createTenantAnnouncement(
    userId: string,
    input: CreateTenantAnnouncementInput,
  ): Promise<Announcement> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (!user.tenantId) {
      throw new BadRequestException('User has no tenant');
    }

    const status = input.publishAt
      ? AnnouncementStatus.SCHEDULED
      : AnnouncementStatus.DRAFT;

    const announcement = this.announcementRepository.create({
      title: input.title,
      content: input.content,
      type: input.type,
      status,
      scope: AnnouncementScope.TENANT,
      tenantId: user.tenantId,
      isGlobal: true, // Always global within tenant
      targetCriteria: null,
      publishAt: input.publishAt ? new Date(input.publishAt) : null,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      requiresAcknowledgment: input.requiresAcknowledgment,
      createdBy: userId,
      createdByName: user.getDisplayName(),
    });

    const saved = await this.announcementRepository.save(announcement);
    this.logger.log(`Tenant announcement created: ${saved.id}`);
    return saved;
  }

  // =========================================================
  // Manage Announcements
  // =========================================================

  /**
   * Publish an announcement
   * SECURITY: PLATFORM announcements can only be published by SUPER_ADMIN (M-09)
   */
  async publishAnnouncement(
    userId: string,
    announcementId: string,
  ): Promise<Announcement> {
    const announcement = await this.getAnnouncement(userId, announcementId);

    // M-09: Verify caller has permission to publish this announcement's scope
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (announcement.scope === AnnouncementScope.PLATFORM && user.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Only SuperAdmin can publish platform announcements');
    }

    if (announcement.scope === AnnouncementScope.TENANT) {
      if (user.role !== Role.SUPER_ADMIN && announcement.tenantId !== user.tenantId) {
        throw new ForbiddenException('Access denied');
      }
    }

    if (
      announcement.status !== AnnouncementStatus.DRAFT &&
      announcement.status !== AnnouncementStatus.SCHEDULED
    ) {
      throw new BadRequestException('Cannot publish this announcement');
    }

    const saved = await this.publishAndEmit(announcement);
    this.logger.log(`Announcement published: ${saved.id}`);
    return saved;
  }

  /**
   * Update a draft/scheduled announcement (SuperAdmin, platform scope).
   *
   * APA-201: closes the FE placeholder useUpdateAnnouncement hook with a real
   * operation. Only DRAFT/SCHEDULED announcements are editable — once PUBLISHED
   * an announcement is immutable (edit it by cancelling + recreating), matching
   * the delivery guarantee (a published broadcast has already fanned out).
   */
  async updateAnnouncement(
    userId: string,
    announcementId: string,
    input: UpdateAnnouncementInput,
  ): Promise<Announcement> {
    // getAnnouncement enforces existence + scope access control.
    const announcement = await this.getAnnouncement(userId, announcementId);

    if (
      announcement.status !== AnnouncementStatus.DRAFT &&
      announcement.status !== AnnouncementStatus.SCHEDULED
    ) {
      throw new BadRequestException(
        'Only draft or scheduled announcements can be updated',
      );
    }

    if (input.title !== undefined) announcement.title = input.title;
    if (input.content !== undefined) announcement.content = input.content;
    if (input.type !== undefined) announcement.type = input.type;
    if (input.isGlobal !== undefined) announcement.isGlobal = input.isGlobal;
    if (input.targetCriteria !== undefined) {
      announcement.targetCriteria = input.targetCriteria ?? null;
    }
    if (input.expiresAt !== undefined) {
      announcement.expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
    }
    if (input.requiresAcknowledgment !== undefined) {
      announcement.requiresAcknowledgment = input.requiresAcknowledgment;
    }
    if (input.publishAt !== undefined) {
      announcement.publishAt = input.publishAt ? new Date(input.publishAt) : null;
      announcement.status = announcement.publishAt
        ? AnnouncementStatus.SCHEDULED
        : AnnouncementStatus.DRAFT;
    }

    const saved = await this.announcementRepository.save(announcement);
    this.logger.log(`Announcement updated: ${saved.id}`);
    return saved;
  }

  /**
   * Flip an announcement to PUBLISHED and emit AnnouncementPublished in ONE
   * transaction. Shared by the interactive publishAnnouncement path and the
   * scheduled-publish cron so both go through the identical atomic status-flip +
   * outbox-enqueue sequence.
   */
  private async publishAndEmit(announcement: Announcement): Promise<Announcement> {
    return this.dataSource.transaction(async (manager) => {
      announcement.status = AnnouncementStatus.PUBLISHED;
      announcement.publishAt = new Date();
      const saved = await manager.save(Announcement, announcement);
      await this.emitAnnouncementPublished(manager, saved);
      return saved;
    });
  }

  /**
   * Enqueue AnnouncementPublished for every target tenant via the transactional
   * outbox. One event is emitted PER target tenant: the top-level event.tenantId
   * is that tenant's UUID (so it routes to `events.<tenantId>.AnnouncementPublished`
   * and passes both OutboxPublisher's UUID guard and notification-service's v4
   * UUID isolation guard), and targetTenantIds carries the single routed tenant.
   * A per-tenant idempotencyKey makes a concurrent manual-publish/scheduled-cron
   * race deliver at most once per (announcement, tenant).
   */
  private async emitAnnouncementPublished(
    manager: EntityManager,
    announcement: Announcement,
  ): Promise<void> {
    const targetTenantIds = await this.resolveTargetTenantIds(manager, announcement);

    for (const tenantId of targetTenantIds) {
      await this.outboxPublisher.enqueue<AnnouncementPublishedEvent>(
        {
          ...createBaseEvent<AnnouncementPublishedEvent>(
            'AnnouncementPublished',
            tenantId,
            {
              aggregateId: announcement.id,
              aggregateType: 'Announcement',
              userId: announcement.createdBy,
            },
          ),
          announcementId: announcement.id,
          title: announcement.title,
          announcementType: announcement.type,
          scope: announcement.scope,
          isGlobal: announcement.isGlobal,
          targetTenantIds: [tenantId],
          requiresAcknowledgment: announcement.requiresAcknowledgment,
        },
        manager,
        {
          aggregateId: announcement.id,
          idempotencyKey: `${announcement.id}:AnnouncementPublished:${tenantId}`,
        },
      );
    }

    this.logger.log(
      `AnnouncementPublished emitted for ${announcement.id} to ${targetTenantIds.length} tenant(s)`,
    );
  }

  /**
   * Resolve the set of tenants that must receive a published announcement.
   * TENANT scope targets only the owning tenant; PLATFORM scope targets every
   * ACTIVE tenant that matches the announcement's targeting rules (global => all
   * active tenants; targeted => matchesTenant against targetCriteria).
   */
  private async resolveTargetTenantIds(
    manager: EntityManager,
    announcement: Announcement,
  ): Promise<string[]> {
    if (announcement.scope === AnnouncementScope.TENANT) {
      return announcement.tenantId ? [announcement.tenantId] : [];
    }

    const activeTenants =
      (await manager.find(Tenant, { where: { status: TenantStatus.ACTIVE } })) ?? [];

    return activeTenants
      .filter((tenant) => announcement.matchesTenant(tenant.id, tenant.plan))
      .map((tenant) => tenant.id);
  }

  /**
   * List acknowledgment/view records for an announcement (SuperAdmin surface).
   *
   * APA-201/APA-202: replaces the FE useAnnouncementAcks placeholder. Reuses
   * getAnnouncement for existence + scope access control.
   */
  async getAcknowledgments(
    userId: string,
    announcementId: string,
  ): Promise<AnnouncementAcknowledgment[]> {
    await this.getAnnouncement(userId, announcementId);
    return this.acknowledgmentRepository.find({
      where: { announcementId },
      order: { viewedAt: 'DESC' },
    });
  }

  /**
   * Cancel an announcement
   */
  async cancelAnnouncement(
    userId: string,
    announcementId: string,
  ): Promise<Announcement> {
    const announcement = await this.getAnnouncement(userId, announcementId);

    announcement.status = AnnouncementStatus.CANCELLED;

    const saved = await this.announcementRepository.save(announcement);
    this.logger.log(`Announcement cancelled: ${saved.id}`);
    return saved;
  }

  /**
   * Delete an announcement (draft only)
   */
  async deleteAnnouncement(
    userId: string,
    announcementId: string,
  ): Promise<boolean> {
    const announcement = await this.getAnnouncement(userId, announcementId);

    if (announcement.status !== AnnouncementStatus.DRAFT) {
      throw new BadRequestException('Can only delete draft announcements');
    }

    await this.announcementRepository.remove(announcement);
    this.logger.log(`Announcement deleted: ${announcementId}`);
    return true;
  }

  // =========================================================
  // View & Acknowledge
  // =========================================================

  /**
   * Mark announcement as viewed
   */
  async viewAnnouncement(
    userId: string,
    announcementId: string,
  ): Promise<AnnouncementAcknowledgment> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const announcement = await this.announcementRepository.findOne({
      where: { id: announcementId },
    });
    if (!announcement) throw new NotFoundException('Announcement not found');

    // Check if already viewed
    const existing = await this.acknowledgmentRepository.findOne({
      where: { announcementId, userId },
    });

    if (existing) {
      return existing; // Already viewed
    }

    // Get tenant info
    let tenantName: string | null = null;
    if (user.tenantId) {
      const tenant = await this.tenantRepository.findOne({
        where: { id: user.tenantId },
      });
      tenantName = tenant?.name || null;
    }

    // Create acknowledgment record
    const ack = this.acknowledgmentRepository.create({
      announcementId,
      userId,
      userName: user.getDisplayName(),
      tenantId: user.tenantId,
      tenantName,
    });

    const saved = await this.acknowledgmentRepository.save(ack);

    // SECURITY: Use atomic increment to prevent race conditions on concurrent views
    await this.announcementRepository.increment(
      { id: announcementId },
      'viewCount',
      1,
    );

    return saved;
  }

  /**
   * Acknowledge an announcement
   */
  async acknowledgeAnnouncement(
    userId: string,
    announcementId: string,
  ): Promise<AnnouncementAcknowledgment> {
    const announcement = await this.announcementRepository.findOne({
      where: { id: announcementId },
    });
    if (!announcement) throw new NotFoundException('Announcement not found');

    if (!announcement.requiresAcknowledgment) {
      throw new BadRequestException('This announcement does not require acknowledgment');
    }

    // First view (creates record if not exists)
    const ack = await this.viewAnnouncement(userId, announcementId);

    if (ack.acknowledgedAt) {
      return ack; // Already acknowledged
    }

    // Update acknowledgment
    ack.acknowledgedAt = new Date();
    const saved = await this.acknowledgmentRepository.save(ack);

    // Update acknowledgment count
    await this.announcementRepository.increment(
      { id: announcementId },
      'acknowledgmentCount',
      1,
    );

    this.logger.log(`Announcement ${announcementId} acknowledged by ${userId}`);
    return saved;
  }

  // =========================================================
  // Statistics
  // =========================================================

  /**
   * Get announcement statistics
   */
  async getStats(userId: string): Promise<AnnouncementStats> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    // PERF: Use SQL aggregation instead of loading all announcements into memory (HIGH-09)
    let query = this.announcementRepository
      .createQueryBuilder('announcement')
      .select('COUNT(*)', 'total')
      .addSelect(`COUNT(*) FILTER (WHERE announcement.status = :published)`, 'published')
      .addSelect(`COUNT(*) FILTER (WHERE announcement.status = :scheduled)`, 'scheduled')
      .addSelect(`COUNT(*) FILTER (WHERE announcement.status = :draft)`, 'draft')
      .addSelect(`COUNT(*) FILTER (WHERE announcement.status = :expired)`, 'expired')
      .addSelect('COALESCE(SUM(announcement.viewCount), 0)', 'totalViews')
      .addSelect('COALESCE(SUM(announcement.acknowledgmentCount), 0)', 'totalAcknowledgments')
      .setParameters({
        published: AnnouncementStatus.PUBLISHED,
        scheduled: AnnouncementStatus.SCHEDULED,
        draft: AnnouncementStatus.DRAFT,
        expired: AnnouncementStatus.EXPIRED,
      });

    if (user.role === Role.SUPER_ADMIN) {
      query = query.where('announcement.scope = :scope', {
        scope: AnnouncementScope.PLATFORM,
      });
    } else if (user.role === Role.TENANT_ADMIN && user.tenantId) {
      query = query.where('announcement.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    }

    const result = await query.getRawOne();

    return {
      total: parseInt(result?.total ?? '0') || 0,
      published: parseInt(result?.published ?? '0') || 0,
      scheduled: parseInt(result?.scheduled ?? '0') || 0,
      draft: parseInt(result?.draft ?? '0') || 0,
      expired: parseInt(result?.expired ?? '0') || 0,
      totalViews: parseInt(result?.totalViews ?? '0') || 0,
      totalAcknowledgments: parseInt(result?.totalAcknowledgments ?? '0') || 0,
    };
  }

  // =========================================================
  // Scheduled Jobs
  // =========================================================

  /**
   * Auto-publish SCHEDULED announcements whose publishAt has arrived.
   *
   * APA-201: this transition is the SSoT replacement for the deleted admin-api
   * publish cron. It routes each transition through publishAndEmit, so a
   * scheduled announcement fires AnnouncementPublished exactly like an
   * interactive publish (delivery is identical on both paths).
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async publishScheduledAnnouncements(): Promise<void> {
    const now = new Date();
    const due = await this.announcementRepository.find({
      where: {
        status: AnnouncementStatus.SCHEDULED,
        publishAt: LessThanOrEqual(now),
      },
    });

    for (const announcement of due) {
      try {
        await this.publishAndEmit(announcement);
        this.logger.log(`Published scheduled announcement: ${announcement.id}`);
      } catch (error) {
        this.logger.error(
          `Failed to publish scheduled announcement ${announcement.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * Transition PUBLISHED announcements past their expiresAt to EXPIRED.
   *
   * APA-201: SSoT replacement for the deleted admin-api expire cron. Without it
   * an expired platform announcement keeps status PUBLISHED and would keep
   * surfacing to tenants via getAnnouncements (which filters status = published).
   */
  @Cron(CronExpression.EVERY_HOUR)
  async expireAnnouncements(): Promise<void> {
    const now = new Date();
    const due = await this.announcementRepository.find({
      where: {
        status: AnnouncementStatus.PUBLISHED,
        expiresAt: LessThanOrEqual(now),
      },
    });

    for (const announcement of due) {
      announcement.status = AnnouncementStatus.EXPIRED;
      await this.announcementRepository.save(announcement);
      this.logger.log(`Expired announcement: ${announcement.id}`);
    }
  }
}
