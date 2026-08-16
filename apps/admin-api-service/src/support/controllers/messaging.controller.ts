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
import { ApiTags } from '@nestjs/swagger';

import { IsString, IsOptional, IsBoolean, IsArray, IsObject, IsUUID } from 'class-validator';

import { CurrentUser, CurrentUserData } from '../../decorators/current-user.decorator';
import { PlatformAdminOnly } from '../../decorators/roles.decorator';
import { MessageAttachment, AnnouncementTarget } from '../entities/support.entity';
import {
  type MessageThreadDto,
  type SupportMessageDto,
  toMessageThreadDto,
  toSupportMessageDto,
} from '../dto/support-http-response.dto';
import { MessagingService } from '../services/messaging.service';
import type { IStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { AdminResponseContract } from '../../shared/admin-response-contract.decorator';
import {
  messagingThreadSummaryPageContract,
  type MessagingThreadSummaryDto,
  messagingMessageThreadDtoContract,
  type MessagingMessageThreadDtoDto,
  messagingMessageThreadDtoArrayContract,
  messagingSupportMessageDtoArrayContract,
  type MessagingSupportMessageDtoDto,
  messagingSupportMessageDtoContract,
  messagingMarkAsReadResponseContract,
  type MessagingMarkAsReadResponseDto,
  messagingSendBulkMessageResponseContract,
  type MessagingSendBulkMessageResponseDto,
  messagingGetStatsResponseContract,
  type MessagingGetStatsResponseDto,
  messagingGetUnreadCountResponseContract,
  type MessagingGetUnreadCountResponseDto,
} from '../contracts/admin-http-response.contract';

// ============================================================================
// DTOs
// ============================================================================

class CreateThreadDto {
  @IsUUID()
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
  @IsUUID('all', { each: true })
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

  @AdminResponseContract(messagingThreadSummaryPageContract)
  @Get('threads')
  async getAllThreads(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: 'open' | 'closed' | 'all',
    @Query('hasUnread') hasUnread?: string,
  ): Promise<IStandardPaginatedResult<MessagingThreadSummaryDto>> {
    return this.messagingService.getAllThreads({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      status,
      hasUnread: hasUnread === 'true',
    });
  }

  @AdminResponseContract(messagingMessageThreadDtoContract)
  @Get('threads/:threadId')
  @PlatformAdminOnly()
  async getThread(@Param('threadId') threadId: string): Promise<MessagingMessageThreadDtoDto> {
    return toMessageThreadDto(await this.messagingService.getThread(threadId));
  }

  @AdminResponseContract(messagingMessageThreadDtoArrayContract)
  @Get('tenants/:tenantId/threads')
  @PlatformAdminOnly()
  async getThreadsForTenant(
    @Param('tenantId') tenantId: string,
  ): Promise<MessagingMessageThreadDtoDto[]> {
    const threads = await this.messagingService.getThreadsForTenant(tenantId);
    return threads.map(toMessageThreadDto);
  }

  @AdminResponseContract(messagingMessageThreadDtoContract)
  @Post('threads')
  @PlatformAdminOnly()
  @HttpCode(HttpStatus.CREATED)
  async createThread(
    @Body() dto: CreateThreadDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<MessagingMessageThreadDtoDto> {
    if (!dto.tenantId || !dto.subject || !dto.content) {
      throw new BadRequestException('tenantId, subject, and content are required');
    }

    return toMessageThreadDto(
      await this.messagingService.createThread(
        dto.tenantId,
        dto.subject,
        dto.content,
        user.id,
        'admin',
        dto.senderName || user.email,
      ),
    );
  }

  @AdminResponseContract(messagingMessageThreadDtoContract)
  @Post('threads/:threadId/close')
  async closeThread(@Param('threadId') threadId: string): Promise<MessagingMessageThreadDtoDto> {
    return toMessageThreadDto(await this.messagingService.closeThread(threadId));
  }

  @AdminResponseContract(messagingMessageThreadDtoContract)
  @Post('threads/:threadId/reopen')
  async reopenThread(@Param('threadId') threadId: string): Promise<MessagingMessageThreadDtoDto> {
    return toMessageThreadDto(await this.messagingService.reopenThread(threadId));
  }

  @AdminResponseContract(messagingMessageThreadDtoContract)
  @Post('threads/:threadId/archive')
  async archiveThread(@Param('threadId') threadId: string): Promise<MessagingMessageThreadDtoDto> {
    return toMessageThreadDto(await this.messagingService.archiveThread(threadId));
  }

  // ============================================================================
  // Messages
  // ============================================================================

  @AdminResponseContract(messagingSupportMessageDtoArrayContract)
  @Get('threads/:threadId/messages')
  @PlatformAdminOnly()
  async getMessages(
    @Param('threadId') threadId: string,
    @Query('includeInternal') includeInternal?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ): Promise<MessagingSupportMessageDtoDto[]> {
    const messages = await this.messagingService.getMessages(threadId, {
      includeInternal: includeInternal !== 'false',
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return messages.map(toSupportMessageDto);
  }

  @AdminResponseContract(messagingSupportMessageDtoContract)
  @Post('threads/:threadId/messages')
  @PlatformAdminOnly()
  @HttpCode(HttpStatus.CREATED)
  async addMessage(
    @Param('threadId') threadId: string,
    @Body() dto: AddMessageDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<MessagingSupportMessageDtoDto> {
    if (!dto.content) {
      throw new BadRequestException('content is required');
    }

    return toSupportMessageDto(
      await this.messagingService.addMessage(threadId, {
        senderId: user.id,
        senderType: 'admin',
        senderName: dto.senderName || user.email,
        content: dto.content,
        isInternal: dto.isInternal,
        attachments: dto.attachments,
      }),
    );
  }

  @AdminResponseContract(messagingMarkAsReadResponseContract)
  @Post('threads/:threadId/read')
  @PlatformAdminOnly()
  async markAsRead(@Param('threadId') threadId: string): Promise<MessagingMarkAsReadResponseDto> {
    await this.messagingService.markMessagesAsRead(threadId, 'admin');
    return { success: true };
  }

  // ============================================================================
  // Bulk Messaging
  // ============================================================================

  @AdminResponseContract(messagingSendBulkMessageResponseContract)
  @Post('bulk')
  @HttpCode(HttpStatus.OK)
  async sendBulkMessage(
    @Body() dto: BulkMessageDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<MessagingSendBulkMessageResponseDto> {
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

  @AdminResponseContract(messagingGetStatsResponseContract)
  @Get('stats')
  async getStats(): Promise<MessagingGetStatsResponseDto> {
    return this.messagingService.getMessagingStats();
  }

  @AdminResponseContract(messagingGetUnreadCountResponseContract)
  @Get('unread-count')
  async getUnreadCount(): Promise<MessagingGetUnreadCountResponseDto> {
    const count = await this.messagingService.getUnreadCount();
    return { unreadCount: count };
  }
}
