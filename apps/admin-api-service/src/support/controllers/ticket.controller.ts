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
import { TicketService } from '../services/ticket.service';
import { TicketPriority, TicketStatus, TicketCategory, TicketAttachment } from '../entities/support.entity';
import { CurrentUser, CurrentUserData } from '../../decorators/current-user.decorator';
import { AllowTenantAdmin } from '../../decorators/roles.decorator';

// ============================================================================
// DTOs
// ============================================================================

class CreateTicketDto {
  tenantId: string;
  tenantName?: string;
  createdByName: string;
  createdByEmail?: string;
  subject: string;
  description: string;
  category?: TicketCategory;
  priority?: TicketPriority;
  tags?: string[];
}

class UpdateTicketDto {
  subject?: string;
  description?: string;
  category?: TicketCategory;
  priority?: TicketPriority;
  status?: TicketStatus;
  tags?: string[];
  dueAt?: string;
}

class AssignTicketDto {
  assignedTo: string;
  assignedToName: string;
}

class AddCommentDto {
  content: string;
  authorName?: string;
  isInternal?: boolean;
  attachments?: TicketAttachment[];
}

class ChangeStatusDto {
  status: TicketStatus;
  changedByName?: string;
}

class ChangePriorityDto {
  priority: TicketPriority;
  changedByName?: string;
}

class SatisfactionRatingDto {
  rating: number;
  feedback?: string;
}

// ============================================================================
// Controller
// ============================================================================

@Controller('support/tickets')
export class TicketController {
  constructor(private readonly ticketService: TicketService) {}

  // ============================================================================
  // CRUD
  // ============================================================================

  @Get()
  async getAllTickets(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: TicketStatus,
    @Query('priority') priority?: TicketPriority,
    @Query('category') category?: TicketCategory,
    @Query('assignedTo') assignedTo?: string,
    @Query('tenantId') tenantId?: string,
    @Query('search') search?: string,
  ) {
    return this.ticketService.getAllTickets({
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
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
  async getUnassignedTickets() {
    return this.ticketService.getUnassignedTickets();
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
  @AllowTenantAdmin()
  async getTicket(@Param('id') id: string) {
    return this.ticketService.getTicket(id);
  }

  @Get('number/:ticketNumber')
  @AllowTenantAdmin()
  async getTicketByNumber(@Param('ticketNumber') ticketNumber: string) {
    return this.ticketService.getTicketByNumber(ticketNumber);
  }

  @Get('tenant/:tenantId')
  @AllowTenantAdmin()
  async getTicketsForTenant(
    @Param('tenantId') tenantId: string,
    @Query('status') status?: TicketStatus,
  ) {
    return this.ticketService.getTicketsForTenant(tenantId, { status });
  }

  @Get('assigned/:userId')
  async getAssignedTickets(
    @Param('userId') userId: string,
    @Query('status') status?: TicketStatus,
  ) {
    return this.ticketService.getAssignedTickets(userId, { status });
  }

  @Post()
  @AllowTenantAdmin()
  @HttpCode(HttpStatus.CREATED)
  async createTicket(@Body() dto: CreateTicketDto) {
    if (!dto.tenantId || !dto.subject || !dto.description || !dto.createdByName) {
      throw new BadRequestException('tenantId, subject, description, and createdByName are required');
    }

    return this.ticketService.createTicket({
      tenantId: dto.tenantId,
      tenantName: dto.tenantName,
      createdBy: 'tenant-user-id', // In production, would come from auth context
      createdByName: dto.createdByName,
      createdByEmail: dto.createdByEmail,
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

    return this.ticketService.changeStatus(
      id,
      dto.status,
      user.id,
      dto.changedByName || user.email,
    );
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

    return this.ticketService.changePriority(
      id,
      dto.priority,
      user.id,
      dto.changedByName || user.email,
    );
  }

  // ============================================================================
  // Comments
  // ============================================================================

  @Get(':id/comments')
  @AllowTenantAdmin()
  async getComments(
    @Param('id') id: string,
    @Query('includeInternal') includeInternal?: string,
  ) {
    return this.ticketService.getComments(id, {
      includeInternal: includeInternal !== 'false',
    });
  }

  @Post(':id/comments')
  @AllowTenantAdmin()
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
  @AllowTenantAdmin()
  async getReplies(
    @Param('id') id: string,
    @Query('includeInternal') includeInternal?: string,
  ) {
    // Replies are the same as comments, just with different naming
    return this.ticketService.getComments(id, {
      includeInternal: includeInternal !== 'false',
    });
  }

  @Post(':id/replies')
  @AllowTenantAdmin()
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
  @AllowTenantAdmin()
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
