import { Resolver, Query, Mutation, Args, ID } from '@nestjs/graphql';
import { UseGuards } from '@nestjs/common';
import { SupportService } from '../services/support.service';
import { JwtAuthGuard } from '../../authentication/guards/jwt-auth.guard';
import { TenantAdminOrHigher, SuperAdminOnly, CurrentUser } from '@platform/backend-common';
import { SupportTicket, TicketStatus, TicketPriority } from '../entities/support-ticket.entity';
import { TicketComment } from '../entities/ticket-comment.entity';
import {
  CreateTicketInput,
  AddTicketCommentInput,
  UpdateTicketStatusInput,
  AssignTicketInput,
  RateTicketInput,
  TicketListItem,
  CommentItem,
  SupportStats,
} from '../dto/support.dto';

/**
 * SupportResolver
 *
 * GraphQL resolver for support ticket operations.
 */
@Resolver()
@UseGuards(JwtAuthGuard)
export class SupportResolver {
  constructor(private readonly supportService: SupportService) {}

  // =========================================================
  // Queries
  // =========================================================

  /**
   * Get all tickets for current user
   */
  @Query(() => [TicketListItem])
  @TenantAdminOrHigher()
  async myTickets(
    @CurrentUser('sub') userId: string,
    @Args('status', { type: () => TicketStatus, nullable: true })
    status?: TicketStatus,
    @Args('priority', { type: () => TicketPriority, nullable: true })
    priority?: TicketPriority,
    @Args('search', { nullable: true }) search?: string,
  ): Promise<TicketListItem[]> {
    return this.supportService.getTickets(userId, { status, priority, search });
  }

  /**
   * Get a single ticket
   */
  @Query(() => SupportTicket)
  @TenantAdminOrHigher()
  async ticket(
    @CurrentUser('sub') userId: string,
    @Args('id', { type: () => ID }) ticketId: string,
  ): Promise<SupportTicket> {
    return this.supportService.getTicket(userId, ticketId);
  }

  /**
   * Get comments for a ticket
   */
  @Query(() => [CommentItem])
  @TenantAdminOrHigher()
  async ticketComments(
    @CurrentUser('sub') userId: string,
    @Args('ticketId', { type: () => ID }) ticketId: string,
  ): Promise<CommentItem[]> {
    return this.supportService.getComments(userId, ticketId);
  }

  /**
   * Get support statistics
   */
  @Query(() => SupportStats)
  @TenantAdminOrHigher()
  async supportStats(@CurrentUser('sub') userId: string): Promise<SupportStats> {
    return this.supportService.getStats(userId);
  }

  // =========================================================
  // Mutations
  // =========================================================

  /**
   * Create a new ticket
   */
  @Mutation(() => SupportTicket)
  @TenantAdminOrHigher()
  async createTicket(
    @CurrentUser('sub') userId: string,
    @Args('input') input: CreateTicketInput,
  ): Promise<SupportTicket> {
    return this.supportService.createTicket(userId, input);
  }

  /**
   * Add a comment to a ticket
   */
  @Mutation(() => TicketComment)
  @TenantAdminOrHigher()
  async addTicketComment(
    @CurrentUser('sub') userId: string,
    @Args('input') input: AddTicketCommentInput,
  ): Promise<TicketComment> {
    return this.supportService.addComment(userId, input);
  }

  /**
   * Update ticket status (SuperAdmin only)
   */
  @Mutation(() => SupportTicket)
  @SuperAdminOnly()
  async updateTicketStatus(
    @CurrentUser('sub') userId: string,
    @Args('input') input: UpdateTicketStatusInput,
  ): Promise<SupportTicket> {
    return this.supportService.updateStatus(userId, input);
  }

  /**
   * Assign ticket to admin (SuperAdmin only)
   */
  @Mutation(() => SupportTicket)
  @SuperAdminOnly()
  async assignTicket(
    @CurrentUser('sub') userId: string,
    @Args('input') input: AssignTicketInput,
  ): Promise<SupportTicket> {
    return this.supportService.assignTicket(userId, input);
  }

  /**
   * Rate ticket satisfaction
   */
  @Mutation(() => SupportTicket)
  @TenantAdminOrHigher()
  async rateTicket(
    @CurrentUser('sub') userId: string,
    @Args('input') input: RateTicketInput,
  ): Promise<SupportTicket> {
    return this.supportService.rateTicket(userId, input);
  }
}
