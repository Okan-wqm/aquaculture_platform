/**
 * Announcement Controller
 *
 * Platform duyuru yönetimi endpoint'leri.
 */

import { Destructive, RequiresCapability } from '@aquaculture/backend-common/decorators';
import { AuditedOperation } from '@aquaculture/backend-common/audit';
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
import { ApiTags } from '@nestjs/swagger';

import { IsString, IsOptional, IsBoolean, IsObject } from 'class-validator';

import { CurrentUser, CurrentUserData } from '../../decorators/current-user.decorator';
import { PlatformAdminOnly } from '../../decorators/roles.decorator';
import { AnnouncementType, AnnouncementStatus, AnnouncementTarget } from '../entities/support.entity';
import { AnnouncementService } from '../services/announcement.service';

// ============================================================================
// DTOs
// ============================================================================

class CreateAnnouncementDto {
  @IsString()
  title!: string;

  @IsString()
  content!: string;

  @IsString()
  type!: AnnouncementType;

  @IsBoolean()
  isGlobal!: boolean;

  @IsOptional()
  @IsObject()
  targetCriteria?: AnnouncementTarget;

  @IsOptional()
  @IsString()
  publishAt?: string;

  @IsOptional()
  @IsString()
  expiresAt?: string;

  @IsOptional()
  @IsBoolean()
  requiresAcknowledgment?: boolean;
}

class UpdateAnnouncementDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  content?: string;

  @IsOptional()
  @IsString()
  type?: AnnouncementType;

  @IsOptional()
  @IsBoolean()
  isGlobal?: boolean;

  @IsOptional()
  @IsObject()
  targetCriteria?: AnnouncementTarget;

  @IsOptional()
  @IsString()
  publishAt?: string;

  @IsOptional()
  @IsString()
  expiresAt?: string;

  @IsOptional()
  @IsBoolean()
  requiresAcknowledgment?: boolean;
}

class AcknowledgeDto {
  @IsString()
  tenantId!: string;

  @IsString()
  userId!: string;

  @IsString()
  userName!: string;
}

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Support')
@Controller('support/announcements')
export class AnnouncementController {
  constructor(private readonly announcementService: AnnouncementService) {}

  // ============================================================================
  // CRUD
  // ============================================================================

  @Get()
  @PlatformAdminOnly()
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
  @PlatformAdminOnly()
  async getAnnouncement(@Param('id') id: string) {
    return this.announcementService.getAnnouncement(id);
  }

  @AuditedOperation({ resource: 'Announcement', action: 'CREATE' })
  @RequiresCapability('support-ops')
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

  @AuditedOperation({ resource: 'Announcement', action: 'UPDATE' })
  @RequiresCapability('support-ops')
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

  @AuditedOperation({ resource: 'Announcement', action: 'DELETE' })
  @Destructive()
  @RequiresCapability('support-ops')
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAnnouncement(@Param('id') id: string) {
    await this.announcementService.deleteAnnouncement(id);
  }

  // ============================================================================
  // Actions
  // ============================================================================

  @AuditedOperation({ resource: 'Announcement', action: 'PUBLISH' })
  @RequiresCapability('support-ops')
  @Post(':id/publish')
  async publishAnnouncement(@Param('id') id: string) {
    return this.announcementService.publishAnnouncement(id);
  }

  @AuditedOperation({ resource: 'Announcement', action: 'CANCEL' })
  @RequiresCapability('support-ops')
  @Post(':id/cancel')
  async cancelAnnouncement(@Param('id') id: string) {
    return this.announcementService.cancelAnnouncement(id);
  }

  // ============================================================================
  // Tenant Announcements
  // ============================================================================

  @Get('tenant/:tenantId/active')
  @PlatformAdminOnly()
  async getActiveForTenant(@Param('tenantId') tenantId: string) {
    return this.announcementService.getActiveAnnouncementsForTenant(tenantId);
  }

  @Get('tenant/:tenantId/pending')
  @PlatformAdminOnly()
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

  @AuditedOperation({ resource: 'View', action: 'RECORD' })
  @RequiresCapability('support-ops')
  @Post(':id/view')
  @PlatformAdminOnly()
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

  @AuditedOperation({ resource: 'Acknowledgment', action: 'RECORD' })
  @RequiresCapability('support-ops')
  @Post(':id/acknowledge')
  @PlatformAdminOnly()
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
