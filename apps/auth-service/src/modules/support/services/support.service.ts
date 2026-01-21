import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Role } from '@platform/backend-common';
import { Repository } from 'typeorm';

import { User } from '../../authentication/entities/user.entity';
import { Tenant } from '../../tenant/entities/tenant.entity';
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
import {
  SupportTicket,
  TicketPriority,
  TicketStatus,
} from '../entities/support-ticket.entity';
import { TicketComment, CommentAuthorType } from '../entities/ticket-comment.entity';

/**
 * SLA configuration (in minutes)
 */
const SLA_CONFIG = {
  [TicketPriority.CRITICAL]: { response: 30, resolution: 240 },
  [TicketPriority.HIGH]: { response: 60, resolution: 480 },
  [TicketPriority.MEDIUM]: { response: 240, resolution: 1440 },
  [TicketPriority.LOW]: { response: 480, resolution: 2880 },
};

/**
 * SupportService
 *
 * Handles support ticket operations.
 * TenantAdmin can create tickets and add comments.
 * SuperAdmin can manage all tickets.
 */
@Injectable()
export class SupportService {
  private readonly logger = new Logger(SupportService.name);

  constructor(
    @InjectRepository(SupportTicket)
    private readonly ticketRepository: Repository<SupportTicket>,
    @InjectRepository(TicketComment)
    private readonly commentRepository: Repository<TicketComment>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Tenant)
    private readonly tenantRepository: Repository<Tenant>,
  ) {}

  // =========================================================
  // Ticket Operations
  // =========================================================

  /**
   * Get tickets for a user (filtered by role)
   */
  async getTickets(
    userId: string,
    filters?: {
      status?: TicketStatus;
      priority?: TicketPriority;
      search?: string;
    },
  ): Promise<TicketListItem[]> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const query = this.ticketRepository
      .createQueryBuilder('ticket')
      .leftJoinAndSelect('ticket.tenant', 'tenant')
      .orderBy('ticket.createdAt', 'DESC');

    // TenantAdmin sees only their tenant's tickets
    if (user.role === Role.TENANT_ADMIN && user.tenantId) {
      query.where('ticket.tenantId = :tenantId', { tenantId: user.tenantId });
    }

    // Apply filters
    if (filters?.status) {
      query.andWhere('ticket.status = :status', { status: filters.status });
    }

    if (filters?.priority) {
      query.andWhere('ticket.priority = :priority', {
        priority: filters.priority,
      });
    }

    if (filters?.search) {
      query.andWhere(
        '(ticket.subject ILIKE :search OR ticket.ticketNumber ILIKE :search)',
        { search: `%${filters.search}%` },
      );
    }

    const tickets = await query.getMany();

    return tickets.map((t) => ({
      id: t.id,
      ticketNumber: t.ticketNumber,
      tenantId: t.tenantId,
      tenantName: t.tenant?.name || 'Unknown',
      subject: t.subject,
      category: t.category,
      priority: t.priority,
      status: t.status,
      assignedToName: t.assignedToName,
      reportedByName: t.reportedByName,
      commentCount: t.commentCount,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      isResponseSLABreached: t.isResponseSLABreached(),
      isResolutionSLABreached: t.isResolutionSLABreached(),
    }));
  }

  /**
   * Get a single ticket by ID
   */
  async getTicket(userId: string, ticketId: string): Promise<SupportTicket> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const ticket = await this.ticketRepository.findOne({
      where: { id: ticketId },
      relations: ['tenant'],
    });

    if (!ticket) throw new NotFoundException('Ticket not found');

    // TenantAdmin can only access their tenant's tickets
    if (user.role === Role.TENANT_ADMIN && ticket.tenantId !== user.tenantId) {
      throw new ForbiddenException('Access denied');
    }

    return ticket;
  }

  /**
   * Get comments for a ticket
   */
  async getComments(userId: string, ticketId: string): Promise<CommentItem[]> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    // Verify access
    await this.getTicket(userId, ticketId);

    const query = this.commentRepository
      .createQueryBuilder('comment')
      .where('comment.ticketId = :ticketId', { ticketId })
      .orderBy('comment.createdAt', 'ASC');

    // TenantAdmin cannot see internal notes
    if (user.role !== Role.SUPER_ADMIN) {
      query.andWhere('comment.isInternal = false');
    }

    const comments = await query.getMany();

    return comments.map((c) => ({
      id: c.id,
      ticketId: c.ticketId,
      authorId: c.authorId,
      authorName: c.authorName,
      authorType: c.authorType,
      content: c.content,
      isInternal: c.isInternal,
      attachments: c.attachments,
      createdAt: c.createdAt,
    }));
  }

  /**
   * Create a new ticket
   */
  async createTicket(
    userId: string,
    input: CreateTicketInput,
  ): Promise<SupportTicket> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    if (!user.tenantId) {
      throw new BadRequestException('User has no tenant');
    }

    const tenant = await this.tenantRepository.findOne({
      where: { id: user.tenantId },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');

    // Calculate SLA deadlines
    const now = new Date();
    const sla = SLA_CONFIG[input.priority];
    const slaResponseDeadline = new Date(now.getTime() + sla.response * 60000);
    const slaResolutionDeadline = new Date(
      now.getTime() + sla.resolution * 60000,
    );

    const ticket = this.ticketRepository.create({
      tenantId: user.tenantId,
      subject: input.subject,
      description: input.description,
      category: input.category,
      priority: input.priority,
      status: TicketStatus.OPEN,
      reportedBy: userId,
      reportedByName: `${user.firstName} ${user.lastName}`,
      slaResponseDeadline,
      slaResolutionDeadline,
      tags: input.tags || [],
      commentCount: 1, // Initial description counts as first comment
    });

    const savedTicket = await this.ticketRepository.save(ticket);

    // Create initial comment (description)
    const comment = this.commentRepository.create({
      ticketId: savedTicket.id,
      authorId: userId,
      authorName: `${user.firstName} ${user.lastName}`,
      authorType: CommentAuthorType.TENANT_ADMIN,
      content: input.description,
      isInternal: false,
    });

    await this.commentRepository.save(comment);

    this.logger.log(`Ticket created: ${savedTicket.ticketNumber} by ${user.email}`);
    return savedTicket;
  }

  /**
   * Add a comment to a ticket
   */
  async addComment(
    userId: string,
    input: AddTicketCommentInput,
  ): Promise<TicketComment> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const ticket = await this.getTicket(userId, input.ticketId);

    if (ticket.status === TicketStatus.CLOSED) {
      throw new BadRequestException('Cannot add comment to closed ticket');
    }

    // Only SuperAdmin can add internal notes
    if (input.isInternal && user.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Only SuperAdmin can create internal notes');
    }

    const isSuperAdmin = user.role === Role.SUPER_ADMIN;

    // Create comment
    const comment = this.commentRepository.create({
      ticketId: ticket.id,
      authorId: userId,
      authorName: `${user.firstName} ${user.lastName}`,
      authorType: isSuperAdmin
        ? CommentAuthorType.SUPER_ADMIN
        : CommentAuthorType.TENANT_ADMIN,
      content: input.content,
      isInternal: input.isInternal,
    });

    const savedComment = await this.commentRepository.save(comment);

    // Update ticket
    ticket.commentCount += 1;

    // If SuperAdmin replies, update firstResponseAt
    if (isSuperAdmin && !ticket.firstResponseAt && !input.isInternal) {
      ticket.firstResponseAt = new Date();
    }

    // Update status if needed
    if (!input.isInternal) {
      if (isSuperAdmin && ticket.status === TicketStatus.OPEN) {
        ticket.status = TicketStatus.IN_PROGRESS;
      } else if (!isSuperAdmin && ticket.status === TicketStatus.WAITING_CUSTOMER) {
        ticket.status = TicketStatus.IN_PROGRESS;
      }
    }

    await this.ticketRepository.save(ticket);

    this.logger.log(`Comment added to ticket ${ticket.ticketNumber}`);
    return savedComment;
  }

  /**
   * Update ticket status (SuperAdmin only)
   */
  async updateStatus(
    userId: string,
    input: UpdateTicketStatusInput,
  ): Promise<SupportTicket> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (user?.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Only SuperAdmin can update ticket status');
    }

    const ticket = await this.ticketRepository.findOne({
      where: { id: input.ticketId },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');

    ticket.status = input.status;

    if (input.status === TicketStatus.RESOLVED) {
      ticket.resolvedAt = new Date();
    }

    const saved = await this.ticketRepository.save(ticket);
    this.logger.log(`Ticket ${ticket.ticketNumber} status updated to ${input.status}`);
    return saved;
  }

  /**
   * Assign ticket to admin (SuperAdmin only)
   */
  async assignTicket(
    userId: string,
    input: AssignTicketInput,
  ): Promise<SupportTicket> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (user?.role !== Role.SUPER_ADMIN) {
      throw new ForbiddenException('Only SuperAdmin can assign tickets');
    }

    const ticket = await this.ticketRepository.findOne({
      where: { id: input.ticketId },
    });
    if (!ticket) throw new NotFoundException('Ticket not found');

    const assignee = await this.userRepository.findOne({
      where: { id: input.assigneeId },
    });
    if (!assignee) throw new NotFoundException('Assignee not found');

    ticket.assignedTo = assignee.id;
    ticket.assignedToName = `${assignee.firstName} ${assignee.lastName}`;

    if (ticket.status === TicketStatus.OPEN) {
      ticket.status = TicketStatus.IN_PROGRESS;
    }

    const saved = await this.ticketRepository.save(ticket);
    this.logger.log(
      `Ticket ${ticket.ticketNumber} assigned to ${assignee.email}`,
    );
    return saved;
  }

  /**
   * Rate ticket satisfaction (TenantAdmin only)
   */
  async rateTicket(userId: string, input: RateTicketInput): Promise<SupportTicket> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    const ticket = await this.getTicket(userId, input.ticketId);

    if (ticket.status !== TicketStatus.RESOLVED) {
      throw new BadRequestException('Can only rate resolved tickets');
    }

    if (ticket.satisfactionRating) {
      throw new BadRequestException('Ticket already rated');
    }

    ticket.satisfactionRating = input.rating;
    ticket.satisfactionComment = input.comment || null;
    ticket.status = TicketStatus.CLOSED;

    const saved = await this.ticketRepository.save(ticket);
    this.logger.log(`Ticket ${ticket.ticketNumber} rated ${input.rating}/5`);
    return saved;
  }

  // =========================================================
  // Statistics
  // =========================================================

  /**
   * Get support statistics
   */
  async getStats(userId: string): Promise<SupportStats> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('User not found');

    let query = this.ticketRepository.createQueryBuilder('ticket');

    // TenantAdmin sees only their tenant's stats
    if (user.role === Role.TENANT_ADMIN && user.tenantId) {
      query = query.where('ticket.tenantId = :tenantId', {
        tenantId: user.tenantId,
      });
    }

    const tickets = await query.getMany();

    const total = tickets.length;
    const open = tickets.filter((t) => t.status === TicketStatus.OPEN).length;
    const inProgress = tickets.filter(
      (t) => t.status === TicketStatus.IN_PROGRESS,
    ).length;
    const waitingCustomer = tickets.filter(
      (t) => t.status === TicketStatus.WAITING_CUSTOMER,
    ).length;
    const resolved = tickets.filter(
      (t) =>
        t.status === TicketStatus.RESOLVED || t.status === TicketStatus.CLOSED,
    ).length;

    // Calculate averages
    const ticketsWithResponse = tickets.filter(
      (t): t is typeof t & { firstResponseAt: Date } => t.firstResponseAt !== null,
    );
    const avgResponseMinutes =
      ticketsWithResponse.length > 0
        ? ticketsWithResponse.reduce((sum, t) => {
            const diff =
              new Date(t.firstResponseAt).getTime() -
              new Date(t.createdAt).getTime();
            return sum + diff / 60000;
          }, 0) / ticketsWithResponse.length
        : 0;

    const ticketsResolved = tickets.filter(
      (t): t is typeof t & { resolvedAt: Date } => t.resolvedAt !== null,
    );
    const avgResolutionMinutes =
      ticketsResolved.length > 0
        ? ticketsResolved.reduce((sum, t) => {
            const diff =
              new Date(t.resolvedAt).getTime() -
              new Date(t.createdAt).getTime();
            return sum + diff / 60000;
          }, 0) / ticketsResolved.length
        : 0;

    // SLA compliance
    const slaBreached = tickets.filter(
      (t) => t.isResponseSLABreached() || t.isResolutionSLABreached(),
    ).length;
    const slaComplianceRate =
      total > 0 ? ((total - slaBreached) / total) * 100 : 100;

    // Satisfaction
    const ratedTickets = tickets.filter((t) => t.satisfactionRating);
    const satisfactionAvg =
      ratedTickets.length > 0
        ? ratedTickets.reduce((sum, t) => sum + (t.satisfactionRating || 0), 0) /
          ratedTickets.length
        : 0;

    return {
      total,
      open,
      inProgress,
      waitingCustomer,
      resolved,
      avgResponseMinutes: Math.round(avgResponseMinutes),
      avgResolutionMinutes: Math.round(avgResolutionMinutes),
      slaComplianceRate: Math.round(slaComplianceRate * 10) / 10,
      satisfactionAvg: Math.round(satisfactionAvg * 10) / 10,
    };
  }
}
