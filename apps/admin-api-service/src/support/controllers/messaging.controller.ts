/**
 * Messaging Controller
 *
 * Admin-tenant mesajlaşma endpoint'leri.
 */

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
import { MessagingService } from '../services/messaging.service';
import { MessageAttachment, AnnouncementTarget } from '../entities/support.entity';
import { CurrentUser, CurrentUserData } from '../../decorators/current-user.decorator';
import { AllowTenantAdmin } from '../../decorators/roles.decorator';

// ============================================================================
// DTOs
// ============================================================================

class CreateThreadDto {
  tenantId: string;
  subject: string;
  content: string;
  senderName?: string;
}

class AddMessageDto {
  content: string;
  senderName?: string;
  isInternal?: boolean;
  attachments?: MessageAttachment[];
}

class BulkMessageDto {
  subject: string;
  content: string;
  targetCriteria?: AnnouncementTarget;
  tenantIds?: string[];
  sendEmail?: boolean;
}

// ============================================================================
// Controller
// ============================================================================

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
  @AllowTenantAdmin()
  async getThread(@Param('threadId') threadId: string) {
    return this.messagingService.getThread(threadId);
  }

  @Get('threads/tenant/:tenantId')
  @AllowTenantAdmin()
  async getThreadsForTenant(@Param('tenantId') tenantId: string) {
    return this.messagingService.getThreadsForTenant(tenantId);
  }

  @Post('threads')
  @AllowTenantAdmin()
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

  @Post('threads/:threadId/close')
  async closeThread(@Param('threadId') threadId: string) {
    return this.messagingService.closeThread(threadId);
  }

  @Post('threads/:threadId/reopen')
  async reopenThread(@Param('threadId') threadId: string) {
    return this.messagingService.reopenThread(threadId);
  }

  @Post('threads/:threadId/archive')
  async archiveThread(@Param('threadId') threadId: string) {
    return this.messagingService.archiveThread(threadId);
  }

  // ============================================================================
  // Messages
  // ============================================================================

  @Get('threads/:threadId/messages')
  @AllowTenantAdmin()
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

  @Post('threads/:threadId/messages')
  @AllowTenantAdmin()
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

  @Post('threads/:threadId/read')
  @AllowTenantAdmin()
  async markAsRead(@Param('threadId') threadId: string) {
    await this.messagingService.markMessagesAsRead(threadId, 'admin');
    return { success: true };
  }

  // ============================================================================
  // Bulk Messaging
  // ============================================================================

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
