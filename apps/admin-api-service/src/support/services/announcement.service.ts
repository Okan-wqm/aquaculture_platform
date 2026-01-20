/**
 * Announcement Service
 *
 * Platform duyuru sistemi - global ve hedefli duyurular.
 */

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual, In } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  Announcement,
  AnnouncementAcknowledgment,
  AnnouncementType,
  AnnouncementStatus,
  AnnouncementTarget,
} from '../entities/support.entity';

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class AnnouncementService {
  private readonly logger = new Logger(AnnouncementService.name);

  constructor(
    @InjectRepository(Announcement)
    private readonly announcementRepository: Repository<Announcement>,
    @InjectRepository(AnnouncementAcknowledgment)
    private readonly acknowledgmentRepository: Repository<AnnouncementAcknowledgment>,
  ) {}

  // ============================================================================
  // Announcement CRUD
  // ============================================================================

  /**
   * Create announcement
   */
  async createAnnouncement(data: {
    title: string;
    content: string;
    type: AnnouncementType;
    isGlobal: boolean;
    targetCriteria?: AnnouncementTarget;
    publishAt?: Date;
    expiresAt?: Date;
    requiresAcknowledgment?: boolean;
    createdBy: string;
    createdByName: string;
  }): Promise<Announcement> {
    this.logger.log(`Creating announcement: ${data.title}`);

    // Validate target criteria if not global
    if (!data.isGlobal && !data.targetCriteria) {
      throw new BadRequestException('Target criteria required for non-global announcements');
    }

    // Determine status based on publishAt
    let status: AnnouncementStatus = 'draft';
    if (data.publishAt) {
      if (data.publishAt <= new Date()) {
        status = 'published';
      } else {
        status = 'scheduled';
      }
    }

    const announcement = this.announcementRepository.create({
      title: data.title,
      content: data.content,
      type: data.type,
      status,
      isGlobal: data.isGlobal,
      targetCriteria: data.targetCriteria,
      publishAt: data.publishAt,
      expiresAt: data.expiresAt,
      requiresAcknowledgment: data.requiresAcknowledgment || false,
      createdBy: data.createdBy,
      createdByName: data.createdByName,
    });

    return this.announcementRepository.save(announcement);
  }

  /**
   * Get announcement by ID
   */
  async getAnnouncement(id: string): Promise<Announcement> {
    const announcement = await this.announcementRepository.findOne({
      where: { id },
      relations: ['acknowledgments'],
    });

    if (!announcement) {
      throw new NotFoundException(`Announcement not found: ${id}`);
    }

    return announcement;
  }

  /**
   * Update announcement
   */
  async updateAnnouncement(
    id: string,
    data: Partial<{
      title: string;
      content: string;
      type: AnnouncementType;
      isGlobal: boolean;
      targetCriteria: AnnouncementTarget;
      publishAt: Date;
      expiresAt: Date;
      requiresAcknowledgment: boolean;
    }>,
  ): Promise<Announcement> {
    const announcement = await this.getAnnouncement(id);

    // Cannot update published announcements except for expiry
    if (announcement.status === 'published') {
      if (Object.keys(data).some(key => key !== 'expiresAt')) {
        throw new BadRequestException('Cannot modify published announcement');
      }
    }

    Object.assign(announcement, data);

    // Update status if publishAt changed
    if (data.publishAt) {
      if (data.publishAt <= new Date()) {
        announcement.status = 'published';
      } else {
        announcement.status = 'scheduled';
      }
    }

    return this.announcementRepository.save(announcement);
  }

  /**
   * Delete announcement
   */
  async deleteAnnouncement(id: string): Promise<void> {
    const announcement = await this.getAnnouncement(id);

    if (announcement.status === 'published') {
      throw new BadRequestException('Cannot delete published announcement. Cancel it instead.');
    }

    await this.announcementRepository.delete({ id });
    this.logger.log(`Announcement deleted: ${id}`);
  }

  /**
   * Publish announcement immediately
   */
  async publishAnnouncement(id: string): Promise<Announcement> {
    const announcement = await this.getAnnouncement(id);

    if (announcement.status === 'published') {
      throw new BadRequestException('Announcement is already published');
    }

    announcement.status = 'published';
    announcement.publishAt = new Date();

    return this.announcementRepository.save(announcement);
  }

  /**
   * Cancel announcement
   */
  async cancelAnnouncement(id: string): Promise<Announcement> {
    const announcement = await this.getAnnouncement(id);

    if (announcement.status === 'cancelled') {
      throw new BadRequestException('Announcement is already cancelled');
    }

    announcement.status = 'cancelled';

    return this.announcementRepository.save(announcement);
  }

  // ============================================================================
  // Announcement Queries
  // ============================================================================

  /**
   * Get all announcements with pagination
   */
  async getAllAnnouncements(options: {
    page?: number;
    limit?: number;
    status?: AnnouncementStatus;
    type?: AnnouncementType;
  }): Promise<{
    data: Announcement[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page = 1, limit = 20, status, type } = options;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (type) where.type = type;

    const [data, total] = await this.announcementRepository.findAndCount({
      where,
      order: { createdAt: 'DESC' },
      skip: (page - 1) * limit,
      take: limit,
    });

    return { data, total, page, limit };
  }

  /**
   * Get active announcements for tenant
   */
  async getActiveAnnouncementsForTenant(tenantId: string): Promise<Announcement[]> {
    const now = new Date();

    // Get all published announcements that haven't expired
    const announcements = await this.announcementRepository.find({
      where: {
        status: 'published' as AnnouncementStatus,
        publishAt: LessThanOrEqual(now),
      },
      order: { publishAt: 'DESC' },
    });

    // Filter by expiry and target criteria
    return announcements.filter(a => {
      // Check expiry
      if (a.expiresAt && a.expiresAt < now) {
        return false;
      }

      // If global, include all
      if (a.isGlobal) {
        return true;
      }

      // Check target criteria
      return this.matchesTargetCriteria(tenantId, a.targetCriteria);
    });
  }

  /**
   * Check if tenant matches target criteria
   */
  private matchesTargetCriteria(
    tenantId: string,
    criteria: AnnouncementTarget | null,
  ): boolean {
    if (!criteria) return true;

    // Check explicit tenant inclusion
    if (criteria.tenantIds?.length && !criteria.tenantIds.includes(tenantId)) {
      return false;
    }

    // Check explicit tenant exclusion
    if (criteria.excludeTenantIds?.includes(tenantId)) {
      return false;
    }

    // In production, would check plans, modules, regions against tenant data
    return true;
  }

  // ============================================================================
  // Acknowledgment Management
  // ============================================================================

  /**
   * Record announcement view
   */
  async recordView(
    announcementId: string,
    tenantId: string,
    userId: string,
    userName: string,
  ): Promise<AnnouncementAcknowledgment> {
    const announcement = await this.getAnnouncement(announcementId);

    // Check if already recorded
    let ack = await this.acknowledgmentRepository.findOne({
      where: { announcementId, userId },
    });

    if (!ack) {
      ack = this.acknowledgmentRepository.create({
        announcementId,
        tenantId,
        userId,
        userName,
        viewedAt: new Date(),
      });

      // Update view count
      announcement.viewCount += 1;
      await this.announcementRepository.save(announcement);
    }

    return this.acknowledgmentRepository.save(ack);
  }

  /**
   * Record acknowledgment
   */
  async recordAcknowledgment(
    announcementId: string,
    tenantId: string,
    userId: string,
    userName: string,
  ): Promise<AnnouncementAcknowledgment> {
    const announcement = await this.getAnnouncement(announcementId);

    if (!announcement.requiresAcknowledgment) {
      throw new BadRequestException('This announcement does not require acknowledgment');
    }

    // Find or create acknowledgment record
    let ack = await this.acknowledgmentRepository.findOne({
      where: { announcementId, userId },
    });

    if (!ack) {
      ack = this.acknowledgmentRepository.create({
        announcementId,
        tenantId,
        userId,
        userName,
        viewedAt: new Date(),
      });
      announcement.viewCount += 1;
    }

    if (!ack.acknowledgedAt) {
      ack.acknowledgedAt = new Date();
      announcement.acknowledgmentCount += 1;
      await this.announcementRepository.save(announcement);
    }

    return this.acknowledgmentRepository.save(ack);
  }

  /**
   * Get acknowledgment status for announcement
   */
  async getAcknowledgmentStatus(announcementId: string): Promise<{
    totalViews: number;
    totalAcknowledgments: number;
    acknowledgments: AnnouncementAcknowledgment[];
  }> {
    const announcement = await this.getAnnouncement(announcementId);
    const acknowledgments = await this.acknowledgmentRepository.find({
      where: { announcementId },
      order: { createdAt: 'DESC' },
    });

    return {
      totalViews: announcement.viewCount,
      totalAcknowledgments: announcement.acknowledgmentCount,
      acknowledgments,
    };
  }

  /**
   * Get pending acknowledgments for user
   */
  async getPendingAcknowledgments(
    tenantId: string,
    userId: string,
  ): Promise<Announcement[]> {
    // Get active announcements requiring acknowledgment
    const announcements = await this.getActiveAnnouncementsForTenant(tenantId);
    const requiresAck = announcements.filter(a => a.requiresAcknowledgment);

    if (requiresAck.length === 0) return [];

    // Get user's acknowledgments
    const acks = await this.acknowledgmentRepository.find({
      where: {
        userId,
        announcementId: In(requiresAck.map(a => a.id)),
      },
    });

    const acknowledgedIds = new Set(
      acks.filter(a => a.acknowledgedAt).map(a => a.announcementId)
    );

    // Return announcements not yet acknowledged
    return requiresAck.filter(a => !acknowledgedIds.has(a.id));
  }

  // ============================================================================
  // Scheduled Jobs
  // ============================================================================

  /**
   * Publish scheduled announcements
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async publishScheduledAnnouncements(): Promise<void> {
    const now = new Date();

    const toPublish = await this.announcementRepository.find({
      where: {
        status: 'scheduled' as AnnouncementStatus,
        publishAt: LessThanOrEqual(now),
      },
    });

    for (const announcement of toPublish) {
      announcement.status = 'published';
      await this.announcementRepository.save(announcement);
      this.logger.log(`Published scheduled announcement: ${announcement.id}`);
    }
  }

  /**
   * Expire old announcements
   */
  @Cron(CronExpression.EVERY_HOUR)
  async expireAnnouncements(): Promise<void> {
    const now = new Date();

    const toExpire = await this.announcementRepository.find({
      where: {
        status: 'published' as AnnouncementStatus,
        expiresAt: LessThanOrEqual(now),
      },
    });

    for (const announcement of toExpire) {
      announcement.status = 'expired';
      await this.announcementRepository.save(announcement);
      this.logger.log(`Expired announcement: ${announcement.id}`);
    }
  }

  // ============================================================================
  // Statistics
  // ============================================================================

  /**
   * Get announcement statistics
   */
  async getAnnouncementStats(): Promise<{
    total: number;
    published: number;
    scheduled: number;
    draft: number;
    expired: number;
    totalViews: number;
    totalAcknowledgments: number;
    byType: Record<AnnouncementType, number>;
  }> {
    const all = await this.announcementRepository.find();

    const stats = {
      total: all.length,
      published: all.filter(a => a.status === 'published').length,
      scheduled: all.filter(a => a.status === 'scheduled').length,
      draft: all.filter(a => a.status === 'draft').length,
      expired: all.filter(a => a.status === 'expired').length,
      totalViews: all.reduce((sum, a) => sum + a.viewCount, 0),
      totalAcknowledgments: all.reduce((sum, a) => sum + a.acknowledgmentCount, 0),
      byType: {
        info: all.filter(a => a.type === 'info').length,
        warning: all.filter(a => a.type === 'warning').length,
        critical: all.filter(a => a.type === 'critical').length,
        maintenance: all.filter(a => a.type === 'maintenance').length,
      },
    };

    return stats;
  }
}
