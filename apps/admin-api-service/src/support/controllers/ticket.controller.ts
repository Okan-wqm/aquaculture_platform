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
import {
  createStandardPaginatedResult,
  type IStandardPaginatedResult,
} from '@aquaculture/backend-common/pagination';

import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';

import { CurrentUser, CurrentUserData } from '../../decorators/current-user.decorator';
import { PlatformAdminOnly } from '../../decorators/roles.decorator';
import { PaginationQueryDto } from '../../shared/pagination-query.dto';
import { type TicketCommentDto, toTicketCommentDto } from '../dto/support-http-response.dto';
import {
  TicketPriority,
  TicketStatus,
  TicketCategory,
  TicketAttachment,
} from '../entities/support.entity';
import { TicketService } from '../services/ticket.service';
import { AdminResponseContract } from '../../shared/admin-response-contract.decorator';
import {
  ticketSupportTicketPageContract,
  type TicketSupportTicketDto,
  ticketTicketStatsContract,
  type TicketTicketStatsDto,
  ticketGetStatsByCategoryResponseContract,
  type TicketGetStatsByCategoryResponseDto,
  ticketGetStatsByPriorityResponseContract,
  type TicketGetStatsByPriorityResponseDto,
  ticketSupportTicketArrayContract,
  ticketGetTicketTeamResponseArrayContract,
  type TicketGetTicketTeamResponseDto,
  ticketSupportTicketContract,
  ticketTicketCommentDtoContract,
  type TicketTicketCommentDtoDto,
  ticketTicketCommentDtoPageContract,
} from '../contracts/admin-http-response.contract';

// ============================================================================
// DTOs
// ============================================================================

class CreateTicketDto {
  @IsUUID()
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
  @IsUUID()
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

  @IsOptional()
  @IsString()
  changedByName?: string;
}

class ChangePriorityDto {
  @IsString()
  priority!: TicketPriority;

  @IsOptional()
  @IsString()
  changedByName?: string;
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

  @AdminResponseContract(ticketSupportTicketPageContract)
  @Get()
  async getAllTickets(
    @Query('status') status?: TicketStatus,
    @Query('priority') priority?: TicketPriority,
    @Query('category') category?: TicketCategory,
    @Query('assignedTo') assignedTo?: string,
    @Query('tenantId') tenantId?: string,
    @Query('search') search?: string,
    @Query() pagination?: PaginationQueryDto,
  ): Promise<IStandardPaginatedResult<TicketSupportTicketDto>> {
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

  @AdminResponseContract(ticketTicketStatsContract)
  @Get('stats')
  async getStats(): Promise<TicketTicketStatsDto> {
    return this.ticketService.getTicketStats();
  }

  @AdminResponseContract(ticketGetStatsByCategoryResponseContract)
  @Get('stats/by-category')
  async getStatsByCategory(): Promise<TicketGetStatsByCategoryResponseDto> {
    return this.ticketService.getStatsByCategory();
  }

  @AdminResponseContract(ticketGetStatsByPriorityResponseContract)
  @Get('stats/by-priority')
  async getStatsByPriority(): Promise<TicketGetStatsByPriorityResponseDto> {
    return this.ticketService.getStatsByPriority();
  }

  @AdminResponseContract(ticketSupportTicketPageContract)
  @Get('unassigned')
  async getUnassignedTickets(
    @Query() pagination?: PaginationQueryDto,
  ): Promise<IStandardPaginatedResult<TicketSupportTicketDto>> {
    return this.ticketService.getUnassignedTickets({
      page: pagination?.page,
      limit: pagination?.limit,
    });
  }

  @AdminResponseContract(ticketSupportTicketArrayContract)
  @Get('sla-risk')
  async getTicketsAtSLARisk(): Promise<TicketSupportTicketDto[]> {
    return this.ticketService.getTicketsAtSLARisk();
  }

  @AdminResponseContract(ticketGetTicketTeamResponseArrayContract)
  @Get('team')
  async getTicketTeam(): Promise<TicketGetTicketTeamResponseDto[]> {
    return this.ticketService.getTicketTeam();
  }

  @AdminResponseContract(ticketSupportTicketContract)
  @Get(':id')
  @PlatformAdminOnly()
  async getTicket(@Param('id') id: string): Promise<TicketSupportTicketDto> {
    return this.ticketService.getTicket(id);
  }

  @AdminResponseContract(ticketSupportTicketContract)
  @Get('number/:ticketNumber')
  @PlatformAdminOnly()
  async getTicketByNumber(
    @Param('ticketNumber') ticketNumber: string,
  ): Promise<TicketSupportTicketDto> {
    return this.ticketService.getTicketByNumber(ticketNumber);
  }

  @AdminResponseContract(ticketSupportTicketPageContract)
  @Get('tenant/:tenantId')
  @PlatformAdminOnly()
  async getTicketsForTenant(
    @Param('tenantId') tenantId: string,
    @Query('status') status?: TicketStatus,
    @Query() pagination?: PaginationQueryDto,
  ): Promise<IStandardPaginatedResult<TicketSupportTicketDto>> {
    return this.ticketService.getTicketsForTenant(tenantId, {
      status,
      page: pagination?.page,
      limit: pagination?.limit,
    });
  }

  @AdminResponseContract(ticketSupportTicketPageContract)
  @Get('assigned/:userId')
  async getAssignedTickets(
    @Param('userId') userId: string,
    @Query('status') status?: TicketStatus,
    @Query() pagination?: PaginationQueryDto,
  ): Promise<IStandardPaginatedResult<TicketSupportTicketDto>> {
    return this.ticketService.getAssignedTickets(userId, {
      status,
      page: pagination?.page,
      limit: pagination?.limit,
    });
  }

  @AdminResponseContract(ticketSupportTicketContract)
  @Post()
  @PlatformAdminOnly()
  @HttpCode(HttpStatus.CREATED)
  async createTicket(
    @Body() dto: CreateTicketDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<TicketSupportTicketDto> {
    if (!dto.tenantId || !dto.subject || !dto.description) {
      throw new BadRequestException('tenantId, subject, and description are required');
    }

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

  @AdminResponseContract(ticketSupportTicketContract)
  @Put(':id')
  async updateTicket(
    @Param('id') id: string,
    @Body() dto: UpdateTicketDto,
  ): Promise<TicketSupportTicketDto> {
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

  @AdminResponseContract(ticketSupportTicketContract)
  @Post(':id/assign')
  async assignTicket(
    @Param('id') id: string,
    @Body() dto: AssignTicketDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<TicketSupportTicketDto> {
    if (!dto.assignedTo || !dto.assignedToName) {
      throw new BadRequestException('assignedTo and assignedToName are required');
    }

    return this.ticketService.assignTicket(id, dto.assignedTo, dto.assignedToName, user.id);
  }

  @AdminResponseContract(ticketSupportTicketContract)
  @Post(':id/status')
  async changeStatus(
    @Param('id') id: string,
    @Body() dto: ChangeStatusDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<TicketSupportTicketDto> {
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

  @AdminResponseContract(ticketSupportTicketContract)
  @Post(':id/priority')
  async changePriority(
    @Param('id') id: string,
    @Body() dto: ChangePriorityDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<TicketSupportTicketDto> {
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

  @AdminResponseContract(ticketTicketCommentDtoPageContract)
  @Get('by-id/:id/comments')
  @PlatformAdminOnly()
  async getComments(
    @Param('id') id: string,
    @Query('includeInternal') includeInternal?: string,
    @Query() pagination?: PaginationQueryDto,
  ): Promise<IStandardPaginatedResult<TicketTicketCommentDtoDto>> {
    const result = await this.ticketService.getComments(id, {
      includeInternal: includeInternal !== 'false',
      page: pagination?.page,
      limit: pagination?.limit,
    });
    return createStandardPaginatedResult(
      result.items.map(toTicketCommentDto),
      result.total,
      result.page,
      result.limit,
    );
  }

  @AdminResponseContract(ticketTicketCommentDtoContract)
  @Post('by-id/:id/comments')
  @PlatformAdminOnly()
  @HttpCode(HttpStatus.CREATED)
  async addComment(
    @Param('id') id: string,
    @Body() dto: AddCommentDto,
    @CurrentUser() user: CurrentUserData,
  ): Promise<TicketTicketCommentDtoDto> {
    if (!dto.content) {
      throw new BadRequestException('content is required');
    }

    return toTicketCommentDto(
      await this.ticketService.addComment(id, {
        authorId: user.id,
        authorType: 'admin',
        authorName: dto.authorName || user.email,
        content: dto.content,
        isInternal: dto.isInternal,
        attachments: dto.attachments,
      }),
    );
  }

  // ============================================================================
  // Satisfaction
  // ============================================================================

  @AdminResponseContract(ticketSupportTicketContract)
  @Post(':id/satisfaction')
  @PlatformAdminOnly()
  async submitSatisfactionRating(
    @Param('id') id: string,
    @Body() dto: SatisfactionRatingDto,
  ): Promise<TicketSupportTicketDto> {
    if (!dto.rating) {
      throw new BadRequestException('rating is required');
    }

    return this.ticketService.submitSatisfactionRating(id, dto.rating, dto.feedback);
  }
}
