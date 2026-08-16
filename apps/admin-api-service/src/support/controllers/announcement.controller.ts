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
import { ApiTags } from '@nestjs/swagger';
import {
  createStandardPaginatedResult,
  type IStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';

import { IsString, IsOptional, IsBoolean, IsObject, IsUUID } from 'class-validator';

import { CurrentUser, CurrentUserData } from '../../decorators/current-user.decorator';
import { PlatformAdminOnly } from '../../decorators/roles.decorator';
import {
  AnnouncementType,
  AnnouncementStatus,
  AnnouncementTarget,
} from '../entities/support.entity';
import {
  type AnnouncementAcknowledgmentDto,
  type AnnouncementAcknowledgmentStatusDto,
  type AnnouncementDto,
  toAnnouncementAcknowledgmentDto,
  toAnnouncementDto,
} from '../dto/support-http-response.dto';
import { AnnouncementService } from '../services/announcement.service';
import { AdminResponseContract } from '../../shared/admin-response-contract.decorator';
import {
  announcementAnnouncementPageContract,
  type AnnouncementAnnouncementDto,
  announcementGetStatsResponseContract,
  type AnnouncementGetStatsResponseDto,
  announcementAnnouncementContract,
  voidResponseContract,
  type VoidResponseDto,
  announcementAnnouncementDtoArrayContract,
  type AnnouncementAnnouncementDtoDto,
  announcementGetAcknowledgmentStatusResponseContract,
  type AnnouncementGetAcknowledgmentStatusResponseDto,
  announcementAnnouncementAcknowledgmentDtoContract,
  type AnnouncementAnnouncementAcknowledgmentDtoDto,
} from '../contracts/admin-http-response.contract';

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
  @IsUUID()
  tenantId!: string;

  @IsUUID()
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

  @AdminResponseContract(announcementAnnouncementPageContract)
  @Get()
  @PlatformAdminOnly()
  async getAllAnnouncements(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: AnnouncementStatus,
    @Query('type') type?: AnnouncementType,
  ): Promise<IStandardPaginatedResult<AnnouncementAnnouncementDto>> {
    const result = await this.announcementService.getAllAnnouncements({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      status,
      type,
    });
    return createStandardPaginatedResult(
      result.items.map(toAnnouncementDto),
      result.total,
      result.page,
      result.limit,
    );
  }

  @AdminResponseContract(announcementGetStatsResponseContract)
  @Get('stats')
  async getStats(): Promise<AnnouncementGetStatsResponseDto> {
    return this.announcementService.getAnnouncementStats();
  }

  @AdminResponseContract(announcementAnnouncementContract)
  @Get(':id')
  @PlatformAdminOnly()
  async getAnnouncement(@Param('id') id: string): Promise<AnnouncementAnnouncementDto> {
    return toAnnouncementDto(await this.announcementService.getAnnouncement(id));
  }

  @AdminResponseContract(announcementAnnouncementContract)
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createAnnouncement(
    @Body() dto: CreateAnnouncementDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<AnnouncementAnnouncementDto> {
    if (!dto.title || !dto.content || !dto.type) {
      throw new BadRequestException('title, content, and type are required');
    }

    return toAnnouncementDto(
      await this.announcementService.createAnnouncement({
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
      }),
    );
  }

  @AdminResponseContract(announcementAnnouncementContract)
  @Put(':id')
  async updateAnnouncement(
    @Param('id') id: string,
    @Body() dto: UpdateAnnouncementDto,
  ): Promise<AnnouncementAnnouncementDto> {
    return toAnnouncementDto(
      await this.announcementService.updateAnnouncement(id, {
        title: dto.title,
        content: dto.content,
        type: dto.type,
        isGlobal: dto.isGlobal,
        targetCriteria: dto.targetCriteria,
        publishAt: dto.publishAt ? new Date(dto.publishAt) : undefined,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
        requiresAcknowledgment: dto.requiresAcknowledgment,
      }),
    );
  }

  @AdminResponseContract(voidResponseContract)
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteAnnouncement(@Param('id') id: string): Promise<void> {
    await this.announcementService.deleteAnnouncement(id);
  }

  // ============================================================================
  // Actions
  // ============================================================================

  @AdminResponseContract(announcementAnnouncementContract)
  @Post(':id/publish')
  async publishAnnouncement(@Param('id') id: string): Promise<AnnouncementAnnouncementDto> {
    return toAnnouncementDto(await this.announcementService.publishAnnouncement(id));
  }

  @AdminResponseContract(announcementAnnouncementContract)
  @Post(':id/cancel')
  async cancelAnnouncement(@Param('id') id: string): Promise<AnnouncementAnnouncementDto> {
    return toAnnouncementDto(await this.announcementService.cancelAnnouncement(id));
  }

  // ============================================================================
  // Tenant Announcements
  // ============================================================================

  @AdminResponseContract(announcementAnnouncementDtoArrayContract)
  @Get('tenant/:tenantId/active')
  @PlatformAdminOnly()
  async getActiveForTenant(
    @Param('tenantId') tenantId: string,
  ): Promise<AnnouncementAnnouncementDtoDto[]> {
    const announcements = await this.announcementService.getActiveAnnouncementsForTenant(tenantId);
    return announcements.map(toAnnouncementDto);
  }

  @AdminResponseContract(announcementAnnouncementDtoArrayContract)
  @Get('tenant/:tenantId/pending')
  @PlatformAdminOnly()
  async getPendingAcknowledgments(
    @Param('tenantId') tenantId: string,
    @Query('userId') userId: string,
  ): Promise<AnnouncementAnnouncementDtoDto[]> {
    if (!userId) {
      throw new BadRequestException('userId is required');
    }
    const announcements = await this.announcementService.getPendingAcknowledgments(
      tenantId,
      userId,
    );
    return announcements.map(toAnnouncementDto);
  }

  // ============================================================================
  // Acknowledgments
  // ============================================================================

  @AdminResponseContract(announcementGetAcknowledgmentStatusResponseContract)
  @Get(':id/acknowledgments')
  async getAcknowledgmentStatus(
    @Param('id') id: string,
  ): Promise<AnnouncementGetAcknowledgmentStatusResponseDto> {
    const status = await this.announcementService.getAcknowledgmentStatus(id);
    return {
      totalViews: status.totalViews,
      totalAcknowledgments: status.totalAcknowledgments,
      acknowledgments: status.acknowledgments.map(toAnnouncementAcknowledgmentDto),
    };
  }

  @AdminResponseContract(announcementAnnouncementAcknowledgmentDtoContract)
  @Post(':id/view')
  @PlatformAdminOnly()
  async recordView(
    @Param('id') id: string,
    @Body() dto: AcknowledgeDto,
  ): Promise<AnnouncementAnnouncementAcknowledgmentDtoDto> {
    if (!dto.tenantId || !dto.userId) {
      throw new BadRequestException('tenantId and userId are required');
    }

    return toAnnouncementAcknowledgmentDto(
      await this.announcementService.recordView(
        id,
        dto.tenantId,
        dto.userId,
        dto.userName || 'Unknown User',
      ),
    );
  }

  @AdminResponseContract(announcementAnnouncementAcknowledgmentDtoContract)
  @Post(':id/acknowledge')
  @PlatformAdminOnly()
  async recordAcknowledgment(
    @Param('id') id: string,
    @Body() dto: AcknowledgeDto,
  ): Promise<AnnouncementAnnouncementAcknowledgmentDtoDto> {
    if (!dto.tenantId || !dto.userId) {
      throw new BadRequestException('tenantId and userId are required');
    }

    return toAnnouncementAcknowledgmentDto(
      await this.announcementService.recordAcknowledgment(
        id,
        dto.tenantId,
        dto.userId,
        dto.userName || 'Unknown User',
      ),
    );
  }
}
