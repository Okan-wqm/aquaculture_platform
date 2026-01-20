import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { AnnouncementService } from '../services/announcement.service';
import { JwtAuthGuard } from '../../authentication/guards/jwt-auth.guard';
import { TenantAdminOrHigher, SuperAdminOnly, CurrentUser } from '@platform/backend-common';
import {
  Announcement,
  AnnouncementType,
  AnnouncementStatus,
} from '../entities/announcement.entity';
import { AnnouncementAcknowledgment } from '../entities/announcement-acknowledgment.entity';
import {
  CreatePlatformAnnouncementInput,
  CreateTenantAnnouncementInput,
  AnnouncementListItem,
  AnnouncementStats,
} from '../dto/announcement.dto';

/**
 * AnnouncementResolver
 *
 * GraphQL resolver for announcement operations.
 */
@Resolver()
@UseGuards(JwtAuthGuard)
export class AnnouncementResolver {
  constructor(private readonly announcementService: AnnouncementService) {}

  // =========================================================
  // Queries
  // =========================================================

  /**
   * Get all announcements for current user
   */
  @Query(() => [AnnouncementListItem])
  @TenantAdminOrHigher()
  async myAnnouncements(
    @CurrentUser('sub') userId: string,
    @Args('status', { type: () => AnnouncementStatus, nullable: true })
    status?: AnnouncementStatus,
    @Args('type', { type: () => AnnouncementType, nullable: true })
    type?: AnnouncementType,
  ): Promise<AnnouncementListItem[]> {
    return this.announcementService.getAnnouncements(userId, { status, type });
  }

  /**
   * Get a single announcement
   */
  @Query(() => Announcement)
  @TenantAdminOrHigher()
  async announcement(
    @CurrentUser('sub') userId: string,
    @Args('id', { type: () => ID }) announcementId: string,
  ): Promise<Announcement> {
    return this.announcementService.getAnnouncement(userId, announcementId);
  }

  /**
   * Get announcement statistics
   */
  @Query(() => AnnouncementStats)
  @TenantAdminOrHigher()
  async announcementStats(
    @CurrentUser('sub') userId: string,
  ): Promise<AnnouncementStats> {
    return this.announcementService.getStats(userId);
  }

  // =========================================================
  // Mutations - Platform Announcements (SuperAdmin)
  // =========================================================

  /**
   * Create a platform-wide announcement (SuperAdmin only)
   */
  @Mutation(() => Announcement)
  @SuperAdminOnly()
  async createPlatformAnnouncement(
    @CurrentUser('sub') userId: string,
    @Args('input') input: CreatePlatformAnnouncementInput,
  ): Promise<Announcement> {
    return this.announcementService.createPlatformAnnouncement(userId, input);
  }

  // =========================================================
  // Mutations - Tenant Announcements (TenantAdmin)
  // =========================================================

  /**
   * Create a tenant-level announcement
   */
  @Mutation(() => Announcement)
  @TenantAdminOrHigher()
  async createTenantAnnouncement(
    @CurrentUser('sub') userId: string,
    @Args('input') input: CreateTenantAnnouncementInput,
  ): Promise<Announcement> {
    return this.announcementService.createTenantAnnouncement(userId, input);
  }

  // =========================================================
  // Mutations - Announcement Management
  // =========================================================

  /**
   * Publish an announcement
   */
  @Mutation(() => Announcement)
  @TenantAdminOrHigher()
  async publishAnnouncement(
    @CurrentUser('sub') userId: string,
    @Args('id', { type: () => ID }) announcementId: string,
  ): Promise<Announcement> {
    return this.announcementService.publishAnnouncement(userId, announcementId);
  }

  /**
   * Cancel an announcement
   */
  @Mutation(() => Announcement)
  @TenantAdminOrHigher()
  async cancelAnnouncement(
    @CurrentUser('sub') userId: string,
    @Args('id', { type: () => ID }) announcementId: string,
  ): Promise<Announcement> {
    return this.announcementService.cancelAnnouncement(userId, announcementId);
  }

  /**
   * Delete an announcement (draft only)
   */
  @Mutation(() => Boolean)
  @TenantAdminOrHigher()
  async deleteAnnouncement(
    @CurrentUser('sub') userId: string,
    @Args('id', { type: () => ID }) announcementId: string,
  ): Promise<boolean> {
    return this.announcementService.deleteAnnouncement(userId, announcementId);
  }

  // =========================================================
  // Mutations - View & Acknowledge
  // =========================================================

  /**
   * Mark announcement as viewed
   */
  @Mutation(() => AnnouncementAcknowledgment)
  @TenantAdminOrHigher()
  async viewAnnouncement(
    @CurrentUser('sub') userId: string,
    @Args('id', { type: () => ID }) announcementId: string,
  ): Promise<AnnouncementAcknowledgment> {
    return this.announcementService.viewAnnouncement(userId, announcementId);
  }

  /**
   * Acknowledge an announcement
   */
  @Mutation(() => AnnouncementAcknowledgment)
  @TenantAdminOrHigher()
  async acknowledgeAnnouncement(
    @CurrentUser('sub') userId: string,
    @Args('id', { type: () => ID }) announcementId: string,
  ): Promise<AnnouncementAcknowledgment> {
    return this.announcementService.acknowledgeAnnouncement(
      userId,
      announcementId,
    );
  }
}
