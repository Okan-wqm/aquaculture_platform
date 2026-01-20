import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import {
  Announcement,
  AnnouncementType,
  AnnouncementStatus,
  AnnouncementScope,
} from '../entities/announcement.entity';
import { AnnouncementAcknowledgment } from '../entities/announcement-acknowledgment.entity';
import { User } from '../../authentication/entities/user.entity';
import { Tenant } from '../../tenant/entities/tenant.entity';
import { Role } from '@platform/backend-common';
import {
  CreatePlatformAnnouncementInput,
  CreateTenantAnnouncementInput,
  AnnouncementListItem,
  AnnouncementStats,
} from '../dto/announcement.dto';

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
        publishAt: a.publishAt,
        expiresAt: a.expiresAt,
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
      createdByName: `${user.firstName} ${user.lastName}`,
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
      createdByName: `${user.firstName} ${user.lastName}`,
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
   */
  async publishAnnouncement(
    userId: string,
    announcementId: string,
  ): Promise<Announcement> {
    const announcement = await this.getAnnouncement(userId, announcementId);

    if (
      announcement.status !== AnnouncementStatus.DRAFT &&
      announcement.status !== AnnouncementStatus.SCHEDULED
    ) {
      throw new BadRequestException('Cannot publish this announcement');
    }

    announcement.status = AnnouncementStatus.PUBLISHED;
    announcement.publishAt = new Date();

    const saved = await this.announcementRepository.save(announcement);
    this.logger.log(`Announcement published: ${saved.id}`);
    return saved;
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
    let ack = await this.acknowledgmentRepository.findOne({
      where: { announcementId, userId },
    });

    if (ack) {
      return ack; // Already viewed
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
    ack = this.acknowledgmentRepository.create({
      announcementId,
      userId,
      userName: `${user.firstName} ${user.lastName}`,
      tenantId: user.tenantId,
      tenantName,
    });

    const saved = await this.acknowledgmentRepository.save(ack);

    // Update view count
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
    let ack = await this.viewAnnouncement(userId, announcementId);

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

    let query = this.announcementRepository.createQueryBuilder('announcement');

    if (user.role === Role.SUPER_ADMIN) {
      query = query.where('announcement.scope = :scope', {
        scope: AnnouncementScope.PLATFORM,
      });
    } else if (user.role === Role.TENANT_ADMIN && user.tenantId) {
      query = query.where('announcement.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    }

    const announcements = await query.getMany();

    const total = announcements.length;
    const published = announcements.filter(
      (a) => a.status === AnnouncementStatus.PUBLISHED,
    ).length;
    const scheduled = announcements.filter(
      (a) => a.status === AnnouncementStatus.SCHEDULED,
    ).length;
    const draft = announcements.filter(
      (a) => a.status === AnnouncementStatus.DRAFT,
    ).length;
    const expired = announcements.filter(
      (a) => a.status === AnnouncementStatus.EXPIRED,
    ).length;
    const totalViews = announcements.reduce((sum, a) => sum + a.viewCount, 0);
    const totalAcknowledgments = announcements.reduce(
      (sum, a) => sum + a.acknowledgmentCount,
      0,
    );

    return {
      total,
      published,
      scheduled,
      draft,
      expired,
      totalViews,
      totalAcknowledgments,
    };
  }
}
