/**
 * Ticket Controller
 *
 * Destek ticket yönetimi endpoint'leri.
 */

import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Query,
  HttpStatus,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';

import { IsString, IsOptional, IsArray, IsBoolean, IsNumber, IsObject } from 'class-validator';

import { CurrentUser, CurrentUserData } from '../../decorators/current-user.decorator';
import { PlatformAdminOnly } from '../../decorators/roles.decorator';
import { PaginationQueryDto } from '../../shared/pagination-query.dto';
import { TicketPriority, TicketStatus, TicketCategory, TicketAttachment } from '../entities/support.entity';
import { TicketService } from '../services/ticket.service';

// ============================================================================
// DTOs
// ============================================================================

class CreateTicketDto {
  @IsString()
  tenantId!: string;

  @IsOptional()
  @IsString()
  tenantName?: string;

  @IsString()
  subject!: string;

  @IsString()
  description!: string;

  @IsOptional()
  @IsString()
  category?: TicketCategory;

  @IsOptional()
  @IsString()
  priority?: TicketPriority;

  @IsOptional()
  @IsArray()
  tags?: string[];
}

class UpdateTicketDto {
  @IsOptional()
  @IsString()
  subject?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  category?: TicketCategory;

  @IsOptional()
  @IsString()
  priority?: TicketPriority;

  @IsOptional()
  @IsString()
  status?: TicketStatus;

  @IsOptional()
  @IsArray()
  tags?: string[];

  @IsOptional()
  @IsString()
  dueAt?: string;
}

class AssignTicketDto {
  @IsString()
  assignedTo!: string;

  @IsString()
  assignedToName!: string;
}

class AddCommentDto {
  @IsString()
  content!: string;

  @IsOptional()
  @IsString()
  authorName?: string;

  @IsOptional()
  @IsBoolean()
  isInternal?: boolean;

  @IsOptional()
  @IsArray()
  attachments?: TicketAttachment[];
}

class ChangeStatusDto {
  @IsString()
  status!: TicketStatus;
}

class ChangePriorityDto {
  @IsString()
  priority!: TicketPriority;
}

class SatisfactionRatingDto {
  @IsNumber()
  rating!: number;

  @IsOptional()
  @IsString()
  feedback?: string;
}

// ============================================================================
// Controller
// ============================================================================

@ApiTags('Support')
@Controller('support/tickets')
export class TicketController {
  constructor(private readonly ticketService: TicketService) {}

  // ============================================================================
  // CRUD
  // ============================================================================

  @Get()
  async getAllTickets(
    @Query('status') status?: TicketStatus,
    @Query('priority') priority?: TicketPriority,
    @Query('category') category?: TicketCategory,
    @Query('assignedTo') assignedTo?: string,
    @Query('tenantId') tenantId?: string,
    @Query('search') search?: string,
    @Query() pagination?: PaginationQueryDto,
  ) {
    return this.ticketService.getAllTickets({
      page: pagination?.page,
      limit: pagination?.limit,
      status,
      priority,
      category,
      assignedTo,
      tenantId,
      search,
    });
  }

  @Get('stats')
  async getStats() {
    return this.ticketService.getTicketStats();
  }

  @Get('stats/by-category')
  async getStatsByCategory() {
    return this.ticketService.getStatsByCategory();
  }

  @Get('stats/by-priority')
  async getStatsByPriority() {
    return this.ticketService.getStatsByPriority();
  }

  @Get('unassigned')
  async getUnassignedTickets(
    @Query() pagination?: PaginationQueryDto,
  ) {
    return this.ticketService.getUnassignedTickets({
      page: pagination?.page,
      limit: pagination?.limit,
    });
  }

  @Get('sla-risk')
  async getTicketsAtSLARisk() {
    return this.ticketService.getTicketsAtSLARisk();
  }

  @Get('team')
  async getTicketTeam() {
    return this.ticketService.getTicketTeam();
  }

  @Get(':id')
  @PlatformAdminOnly()
  async getTicket(@Param('id') id: string) {
    return this.ticketService.getTicket(id);
  }

  @Get('number/:ticketNumber')
  @PlatformAdminOnly()
  async getTicketByNumber(@Param('ticketNumber') ticketNumber: string) {
    return this.ticketService.getTicketByNumber(ticketNumber);
  }

  @Get('tenant/:tenantId')
  @PlatformAdminOnly()
  async getTicketsForTenant(
    @Param('tenantId') tenantId: string,
    @Query('status') status?: TicketStatus,
    @Query() pagination?: PaginationQueryDto,
  ) {
    return this.ticketService.getTicketsForTenant(tenantId, {
      status,
      page: pagination?.page,
      limit: pagination?.limit,
    });
  }

  @Get('assigned/:userId')
  async getAssignedTickets(
    @Param('userId') userId: string,
    @Query('status') status?: TicketStatus,
    @Query() pagination?: PaginationQueryDto,
  ) {
    return this.ticketService.getAssignedTickets(userId, {
      status,
      page: pagination?.page,
      limit: pagination?.limit,
    });
  }

  @Post()
  @PlatformAdminOnly()
  @HttpCode(HttpStatus.CREATED)
  async createTicket(@Body() dto: CreateTicketDto, @CurrentUser() user: CurrentUserData) {
    if (!dto.tenantId || !dto.subject || !dto.description) {
      throw new BadRequestException('tenantId, subject, and description are required');
    }

    // ADMIN-CRITICAL-008: the creator is the verified platform admin, not a
    // name the request body offers.
    return this.ticketService.createTicket({
      tenantId: dto.tenantId,
      tenantName: dto.tenantName,
      createdBy: user.id,
      createdByName: user.email,
      createdByEmail: user.email,
      subject: dto.subject,
      description: dto.description,
      category: dto.category,
      priority: dto.priority,
      tags: dto.tags,
    });
  }

  @Put(':id')
  async updateTicket(
    @Param('id') id: string,
    @Body() dto: UpdateTicketDto,
  ) {
    return this.ticketService.updateTicket(id, {
      subject: dto.subject,
      description: dto.description,
      category: dto.category,
      priority: dto.priority,
      status: dto.status,
      tags: dto.tags,
      dueAt: dto.dueAt ? new Date(dto.dueAt) : undefined,
    });
  }

  // ============================================================================
  // Actions
  // ============================================================================

  @Post(':id/assign')
  async assignTicket(
    @Param('id') id: string,
    @Body() dto: AssignTicketDto,
  ) {
    if (!dto.assignedTo || !dto.assignedToName) {
      throw new BadRequestException('assignedTo and assignedToName are required');
    }

    return this.ticketService.assignTicket(id, dto.assignedTo, dto.assignedToName);
  }

  @Post(':id/status')
  async changeStatus(
    @Param('id') id: string,
    @Body() dto: ChangeStatusDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    if (!dto.status) {
      throw new BadRequestException('status is required');
    }

    return this.ticketService.changeStatus(id, dto.status, user.id, user.email);
  }

  @Post(':id/priority')
  async changePriority(
    @Param('id') id: string,
    @Body() dto: ChangePriorityDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    if (!dto.priority) {
      throw new BadRequestException('priority is required');
    }

    return this.ticketService.changePriority(id, dto.priority, user.id, user.email);
  }

  // ============================================================================
  // Comments
  // ============================================================================

  @Get(':id/comments')
  @PlatformAdminOnly()
  async getComments(
    @Param('id') id: string,
    @Query('includeInternal') includeInternal?: string,
    @Query() pagination?: PaginationQueryDto,
  ) {
    return this.ticketService.getComments(id, {
      includeInternal: includeInternal !== 'false',
      page: pagination?.page,
      limit: pagination?.limit,
    });
  }

  @Post(':id/comments')
  @PlatformAdminOnly()
  @HttpCode(HttpStatus.CREATED)
  async addComment(
    @Param('id') id: string,
    @Body() dto: AddCommentDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    if (!dto.content) {
      throw new BadRequestException('content is required');
    }

    return this.ticketService.addComment(id, {
      authorId: user.id,
      authorType: 'admin',
      authorName: dto.authorName || user.email,
      content: dto.content,
      isInternal: dto.isInternal,
      attachments: dto.attachments,
    });
  }

  // ============================================================================
  // Replies (Alias for Comments - Frontend Compatibility)
  // ============================================================================

  @Get(':id/replies')
  @PlatformAdminOnly()
  async getReplies(
    @Param('id') id: string,
    @Query('includeInternal') includeInternal?: string,
    @Query() pagination?: PaginationQueryDto,
  ) {
    // Replies are the same as comments, just with different naming
    return this.ticketService.getComments(id, {
      includeInternal: includeInternal !== 'false',
      page: pagination?.page,
      limit: pagination?.limit,
    });
  }

  @Post(':id/replies')
  @PlatformAdminOnly()
  @HttpCode(HttpStatus.CREATED)
  async addReply(
    @Param('id') id: string,
    @Body() dto: AddCommentDto,
    @CurrentUser() user: CurrentUserData,
  ) {
    if (!dto.content) {
      throw new BadRequestException('content is required');
    }

    return this.ticketService.addComment(id, {
      authorId: user.id,
      authorType: 'admin',
      authorName: dto.authorName || user.email,
      content: dto.content,
      isInternal: dto.isInternal,
      attachments: dto.attachments,
    });
  }

  // ============================================================================
  // Satisfaction
  // ============================================================================

  @Post(':id/satisfaction')
  @PlatformAdminOnly()
  async submitSatisfactionRating(
    @Param('id') id: string,
    @Body() dto: SatisfactionRatingDto,
  ) {
    if (!dto.rating) {
      throw new BadRequestException('rating is required');
    }

    return this.ticketService.submitSatisfactionRating(id, dto.rating, dto.feedback);
  }
}
