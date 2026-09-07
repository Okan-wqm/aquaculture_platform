/**
 * Messaging Controller
 *
 * Admin-tenant mesajlaşma endpoint'leri.
 */

import { AuditedOperation } from '@aquaculture/backend-common/audit';
import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  HttpStatus,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { IsString, IsOptional, IsBoolean, IsArray, IsObject } from 'class-validator';

import { CurrentUser, CurrentUserData } from '../../decorators/current-user.decorator';
import { PlatformAdminOnly } from '../../decorators/roles.decorator';
import { MessageAttachment, AnnouncementTarget } from '../entities/support.entity';
import { MessagingService } from '../services/messaging.service';

// ============================================================================
// DTOs
// ============================================================================

class CreateThreadDto {
  @IsString()
  tenantId!: string;

  @IsString()
  subject!: string;

  @IsString()
  content!: string;

  @IsOptional()
  @IsString()
  senderName?: string;
}

class AddMessageDto {
  @IsString()
  content!: string;

  @IsOptional()
  @IsString()
  senderName?: string;

  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;

  @IsOptional()
  @IsArray()
  attachments?: MessageAttachment[];
}

class BulkMessageDto {
  @IsString()
  subject!: string;

  @IsString()
  content!: string;

  @IsOptional()
  @IsObject()
  targetCriteria?: AnnouncementTarget;

  @IsOptional()
  @IsArray()
  tenantIds?: string[];

  @IsOptional()
  @IsBoolean()
  sendEmail?: boolean;
}

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Support')
@Controller('support/messages')
export class MessagingController {
  constructor(private readonly messagingService: MessagingService) {}

  // ============================================================================
  // Threads
  // ============================================================================

  @Get('threads')
  async getAllThreads(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: 'open' | 'closed' | 'all',
    @Query('hasUnread') hasUnread?: string,
  ) {
    return this.messagingService.getAllThreads({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      status,
      hasUnread: hasUnread === 'true',
    });
  }

  @Get('threads/:threadId')
  @PlatformAdminOnly()
  async getThread(@Param('threadId') threadId: string) {
    return this.messagingService.getThread(threadId);
  }

  @Get('threads/tenant/:tenantId')
  @PlatformAdminOnly()
  async getThreadsForTenant(@Param('tenantId') tenantId: string) {
    return this.messagingService.getThreadsForTenant(tenantId);
  }

  @AuditedOperation({ resource: 'Thread', action: 'CREATE' })
  @Post('threads')
  @PlatformAdminOnly()
  @HttpCode(HttpStatus.CREATED)
  async createThread(
    @Body() dto: CreateThreadDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    if (!dto.tenantId || !dto.subject || !dto.content) {
      throw new BadRequestException('tenantId, subject, and content are required');
    }

    return this.messagingService.createThread(
      dto.tenantId,
      dto.subject,
      dto.content,
      user.id,
      'admin',
      dto.senderName || user.email,
    );
  }

  @AuditedOperation({ resource: 'Thread', action: 'CLOSE' })
  @Post('threads/:threadId/close')
  async closeThread(@Param('threadId') threadId: string) {
    return this.messagingService.closeThread(threadId);
  }

  @AuditedOperation({ resource: 'Thread', action: 'REOPEN' })
  @Post('threads/:threadId/reopen')
  async reopenThread(@Param('threadId') threadId: string) {
    return this.messagingService.reopenThread(threadId);
  }

  @AuditedOperation({ resource: 'Thread', action: 'ARCHIVE' })
  @Post('threads/:threadId/archive')
  async archiveThread(@Param('threadId') threadId: string) {
    return this.messagingService.archiveThread(threadId);
  }

  // ============================================================================
  // Messages
  // ============================================================================

  @Get('threads/:threadId/messages')
  @PlatformAdminOnly()
  async getMessages(
    @Param('threadId') threadId: string,
    @Query('includeInternal') includeInternal?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.messagingService.getMessages(threadId, {
      includeInternal: includeInternal !== 'false',
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @AuditedOperation({ resource: 'Message', action: 'ADD' })
  @Post('threads/:threadId/messages')
  @PlatformAdminOnly()
  @HttpCode(HttpStatus.CREATED)
  async addMessage(
    @Param('threadId') threadId: string,
    @Body() dto: AddMessageDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    if (!dto.content) {
      throw new BadRequestException('content is required');
    }

    return this.messagingService.addMessage(threadId, {
      senderId: user.id,
      senderType: 'admin',
      senderName: dto.senderName || user.email,
      content: dto.content,
      isInternal: dto.isInternal,
      attachments: dto.attachments,
    });
  }

  @AuditedOperation({ resource: 'AsRead', action: 'MARK' })
  @Post('threads/:threadId/read')
  @PlatformAdminOnly()
  async markAsRead(@Param('threadId') threadId: string) {
    await this.messagingService.markMessagesAsRead(threadId, 'admin');
    return { success: true };
  }

  // ============================================================================
  // Bulk Messaging
  // ============================================================================

  @AuditedOperation({ resource: 'BulkMessage', action: 'SEND' })
  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  async sendBulkMessage(
    @Body() dto: BulkMessageDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    if (!dto.subject || !dto.content) {
      throw new BadRequestException('subject and content are required');
    }

    // Get target tenant IDs
    let tenantIds = dto.tenantIds || [];

    if (dto.targetCriteria && !dto.tenantIds?.length) {
      tenantIds = await this.messagingService.getTargetTenants(dto.targetCriteria);
    }

    if (tenantIds.length === 0) {
      throw new BadRequestException('No target tenants specified');
    }

    return this.messagingService.sendBulkMessage(
      {
        subject: dto.subject,
        content: dto.content,
        targetCriteria: dto.targetCriteria,
        sendEmail: dto.sendEmail || false,
      },
      user.id,
      user.email,
      tenantIds,
    );
  }

  // ============================================================================
  // Statistics
  // ============================================================================

  @Get('stats')
  async getStats() {
    return this.messagingService.getMessagingStats();
  }

  @Get('unread-count')
  async getUnreadCount() {
    const count = await this.messagingService.getUnreadCount();
    return { unreadCount: count };
  }
}
