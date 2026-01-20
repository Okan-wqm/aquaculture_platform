/**
 * Announcement Controller
 *
 * Platform duyuru yönetimi endpoint'leri.
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  HttpStatus,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { AnnouncementService } from '../services/announcement.service';
import { AnnouncementType, AnnouncementStatus, AnnouncementTarget } from '../entities/support.entity';
import { CurrentUser, CurrentUserData } from '../../decorators/current-user.decorator';
import { AllowTenantAdmin } from '../../decorators/roles.decorator';

// ============================================================================
// DTOs
// ============================================================================

class CreateAnnouncementDto {
  title: string;
  content: string;
  type: AnnouncementType;
  isGlobal: boolean;
  targetCriteria?: AnnouncementTarget;
  publishAt?: string;
  expiresAt?: string;
  requiresAcknowledgment?: boolean;
}

class UpdateAnnouncementDto {
  title?: string;
  content?: string;
  type?: AnnouncementType;
  isGlobal?: boolean;
  targetCriteria?: AnnouncementTarget;
  publishAt?: string;
  expiresAt?: string;
  requiresAcknowledgment?: boolean;
}

class AcknowledgeDto {
  tenantId: string;
  userId: string;
  userName: string;
}

// ============================================================================
// Controller
// ============================================================================

@Controller('support/announcements')
export class AnnouncementController {
  constructor(private readonly announcementService: AnnouncementService) {}

  // ============================================================================
  // CRUD
  // ============================================================================

  @Get()
  @AllowTenantAdmin()
  async getAllAnnouncements(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: AnnouncementStatus,
    @Query('type') type?: AnnouncementType,
  ) {
    return this.announcementService.getAllAnnouncements({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      status,
      type,
    });
  }

  @Get('stats')
  async getStats() {
    return this.announcementService.getAnnouncementStats();
  }

  @Get(':id')
  @AllowTenantAdmin()
  async getAnnouncement(@Param('id') id: string) {
    return this.announcementService.getAnnouncement(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createAnnouncement(
    @Body() dto: CreateAnnouncementDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    if (!dto.title || !dto.content || !dto.type) {
      throw new BadRequestException('title, content, and type are required');
    }

    return this.announcementService.createAnnouncement({
      title: dto.title,
      content: dto.content,
      type: dto.type,
      isGlobal: dto.isGlobal ?? true,
      targetCriteria: dto.targetCriteria,
      publishAt: dto.publishAt ? new Date(dto.publishAt) : undefined,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      requiresAcknowledgment: dto.requiresAcknowledgment,
      createdBy: user.id,
      createdByName: user.email,
    });
  }

  @Put(':id')
  async updateAnnouncement(
    @Param('id') id: string,
    @Body() dto: UpdateAnnouncementDto,
  ) {
    return this.announcementService.updateAnnouncement(id, {
      title: dto.title,
      content: dto.content,
      type: dto.type,
      isGlobal: dto.isGlobal,
      targetCriteria: dto.targetCriteria,
      publishAt: dto.publishAt ? new Date(dto.publishAt) : undefined,
      expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      requiresAcknowledgment: dto.requiresAcknowledgment,
    });
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAnnouncement(@Param('id') id: string) {
    await this.announcementService.deleteAnnouncement(id);
  }

  // ============================================================================
  // Actions
  // ============================================================================

  @Post(':id/publish')
  async publishAnnouncement(@Param('id') id: string) {
    return this.announcementService.publishAnnouncement(id);
  }

  @Post(':id/cancel')
  async cancelAnnouncement(@Param('id') id: string) {
    return this.announcementService.cancelAnnouncement(id);
  }

  // ============================================================================
  // Tenant Announcements
  // ============================================================================

  @Get('tenant/:tenantId/active')
  @AllowTenantAdmin()
  async getActiveForTenant(@Param('tenantId') tenantId: string) {
    return this.announcementService.getActiveAnnouncementsForTenant(tenantId);
  }

  @Get('tenant/:tenantId/pending')
  @AllowTenantAdmin()
  async getPendingAcknowledgments(
    @Param('tenantId') tenantId: string,
    @Query('userId') userId: string,
  ) {
    if (!userId) {
      throw new BadRequestException('userId is required');
    }
    return this.announcementService.getPendingAcknowledgments(tenantId, userId);
  }

  // ============================================================================
  // Acknowledgments
  // ============================================================================

  @Get(':id/acknowledgments')
  async getAcknowledgmentStatus(@Param('id') id: string) {
    return this.announcementService.getAcknowledgmentStatus(id);
  }

  @Post(':id/view')
  @AllowTenantAdmin()
  async recordView(
    @Param('id') id: string,
    @Body() dto: AcknowledgeDto,
  ) {
    if (!dto.tenantId || !dto.userId) {
      throw new BadRequestException('tenantId and userId are required');
    }

    return this.announcementService.recordView(
      id,
      dto.tenantId,
      dto.userId,
      dto.userName || 'Unknown User',
    );
  }

  @Post(':id/acknowledge')
  @AllowTenantAdmin()
  async recordAcknowledgment(
    @Param('id') id: string,
    @Body() dto: AcknowledgeDto,
  ) {
    if (!dto.tenantId || !dto.userId) {
      throw new BadRequestException('tenantId and userId are required');
    }

    return this.announcementService.recordAcknowledgment(
      id,
      dto.tenantId,
      dto.userId,
      dto.userName || 'Unknown User',
    );
  }
}
