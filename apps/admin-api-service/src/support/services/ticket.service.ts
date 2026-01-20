/**
 * Ticket Service
 *
 * Destek ticket sistemi - SLA tracking, önceliklendirme, atama.
 */

import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, LessThan, IsNull, Not } from 'typeorm';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  SupportTicket,
  TicketComment,
  TicketPriority,
  TicketStatus,
  TicketCategory,
  TicketAttachment,
  TicketStats,
  SLAConfig,
} from '../entities/support.entity';

// ============================================================================
// SLA Configuration
// ============================================================================

const DEFAULT_SLA_CONFIG: SLAConfig[] = [
  { priority: 'critical', firstResponseMinutes: 30, resolutionMinutes: 240 },
  { priority: 'high', firstResponseMinutes: 60, resolutionMinutes: 480 },
  { priority: 'medium', firstResponseMinutes: 240, resolutionMinutes: 1440 },
  { priority: 'low', firstResponseMinutes: 480, resolutionMinutes: 2880 },
];

// ============================================================================
// Service
// ============================================================================

@Injectable()
export class TicketService {
  private readonly logger = new Logger(TicketService.name);
  private ticketCounter = 1000;

  constructor(
    @InjectRepository(SupportTicket)
    private readonly ticketRepository: Repository<SupportTicket>,
    @InjectRepository(TicketComment)
    private readonly commentRepository: Repository<TicketComment>,
  ) {}

  // ============================================================================
  // Ticket CRUD
  // ============================================================================

  /**
   * Create support ticket
   */
  async createTicket(data: {
    tenantId: string;
    tenantName?: string;
    createdBy: string;
    createdByName: string;
    createdByEmail?: string;
    subject: string;
    description: string;
    category?: TicketCategory;
    priority?: TicketPriority;
    tags?: string[];
  }): Promise<SupportTicket> {
    this.logger.log(`Creating ticket for tenant ${data.tenantId}: ${data.subject}`);

    const ticketNumber = this.generateTicketNumber();
    const priority = data.priority || 'medium';
    const slaConfig = this.getSLAConfig(priority);

    // Calculate due date based on SLA
    const dueAt = new Date();
    dueAt.setMinutes(dueAt.getMinutes() + slaConfig.resolutionMinutes);

    const ticket = this.ticketRepository.create({
      ticketNumber,
      tenantId: data.tenantId,
      tenantName: data.tenantName,
      createdBy: data.createdBy,
      createdByName: data.createdByName,
      createdByEmail: data.createdByEmail,
      subject: data.subject,
      description: data.description,
      category: data.category || 'general',
      priority,
      status: 'open' as TicketStatus,
      tags: data.tags || [],
      dueAt,
      slaResponseMinutes: slaConfig.firstResponseMinutes,
      slaResolutionMinutes: slaConfig.resolutionMinutes,
    });

    return this.ticketRepository.save(ticket);
  }

  /**
   * Generate unique ticket number
   */
  private generateTicketNumber(): string {
    this.ticketCounter++;
    const year = new Date().getFullYear();
    return `TKT-${year}-${String(this.ticketCounter).padStart(5, '0')}`;
  }

  /**
   * Get SLA config for priority
   */
  private getSLAConfig(priority: TicketPriority): SLAConfig {
    const config = DEFAULT_SLA_CONFIG.find(c => c.priority === priority);
    const defaultConfig = DEFAULT_SLA_CONFIG[2];
    if (config) return config;
    if (defaultConfig) return defaultConfig;
    // Fallback config
    return { priority: 'medium' as TicketPriority, firstResponseMinutes: 1440, resolutionMinutes: 4320 };
  }

  /**
   * Get ticket by ID
   */
  async getTicket(id: string): Promise<SupportTicket> {
    const ticket = await this.ticketRepository.findOne({
      where: { id },
      relations: ['comments'],
    });

    if (!ticket) {
      throw new NotFoundException(`Ticket not found: ${id}`);
    }

    return ticket;
  }

  /**
   * Get ticket by number
   */
  async getTicketByNumber(ticketNumber: string): Promise<SupportTicket> {
    const ticket = await this.ticketRepository.findOne({
      where: { ticketNumber },
      relations: ['comments'],
    });

    if (!ticket) {
      throw new NotFoundException(`Ticket not found: ${ticketNumber}`);
    }

    return ticket;
  }

  /**
   * Update ticket
   */
  async updateTicket(
    id: string,
    data: Partial<{
      subject: string;
      description: string;
      category: TicketCategory;
      priority: TicketPriority;
      status: TicketStatus;
      assignedTo: string;
      assignedToName: string;
      tags: string[];
      dueAt: Date;
    }>,
  ): Promise<SupportTicket> {
    const ticket = await this.getTicket(id);
    const oldStatus = ticket.status;
    const oldPriority = ticket.priority;

    Object.assign(ticket, data);

    // Update SLA if priority changed
    if (data.priority && data.priority !== oldPriority) {
      const slaConfig = this.getSLAConfig(data.priority);
      ticket.slaResponseMinutes = slaConfig.firstResponseMinutes;
      ticket.slaResolutionMinutes = slaConfig.resolutionMinutes;

      // Recalculate due date if not resolved
      if (!ticket.resolvedAt) {
        const dueAt = new Date(ticket.createdAt);
        dueAt.setMinutes(dueAt.getMinutes() + slaConfig.resolutionMinutes);
        ticket.dueAt = dueAt;
      }
    }

    // Track status changes
    if (data.status && data.status !== oldStatus) {
      if (data.status === 'resolved') {
        ticket.resolvedAt = new Date();
      } else if (data.status === 'closed') {
        ticket.closedAt = new Date();
      }
    }

    return this.ticketRepository.save(ticket);
  }

  // ============================================================================
  // Ticket Queries
  // ============================================================================

  /**
   * Get all tickets with pagination and filters
   */
  async getAllTickets(options: {
    page?: number;
    limit?: number;
    status?: TicketStatus;
    priority?: TicketPriority;
    category?: TicketCategory;
    assignedTo?: string;
    tenantId?: string;
    search?: string;
  }): Promise<{
    data: SupportTicket[];
    total: number;
    page: number;
    limit: number;
  }> {
    const { page = 1, limit = 20, status, priority, category, assignedTo, tenantId, search } = options;

    const qb = this.ticketRepository.createQueryBuilder('ticket');

    if (status) qb.andWhere('ticket.status = :status', { status });
    if (priority) qb.andWhere('ticket.priority = :priority', { priority });
    if (category) qb.andWhere('ticket.category = :category', { category });
    if (assignedTo) qb.andWhere('ticket.assignedTo = :assignedTo', { assignedTo });
    if (tenantId) qb.andWhere('ticket.tenantId = :tenantId', { tenantId });
    if (search) {
      qb.andWhere(
        '(ticket.subject ILIKE :search OR ticket.ticketNumber ILIKE :search)',
        { search: `%${search}%` },
      );
    }

    qb.orderBy('ticket.createdAt', 'DESC');
    qb.skip((page - 1) * limit);
    qb.take(limit);

    const [data, total] = await qb.getManyAndCount();

    return { data, total, page, limit };
  }

  /**
   * Get tickets for tenant
   */
  async getTicketsForTenant(
    tenantId: string,
    options: { status?: TicketStatus } = {},
  ): Promise<SupportTicket[]> {
    const where: Record<string, unknown> = { tenantId };
    if (options.status) where.status = options.status;

    return this.ticketRepository.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Get assigned tickets
   */
  async getAssignedTickets(
    assignedTo: string,
    options: { status?: TicketStatus } = {},
  ): Promise<SupportTicket[]> {
    const where: Record<string, unknown> = { assignedTo };
    if (options.status) where.status = options.status;

    return this.ticketRepository.find({
      where,
      order: { priority: 'DESC', createdAt: 'ASC' },
    });
  }

  /**
   * Get unassigned tickets
   */
  async getUnassignedTickets(): Promise<SupportTicket[]> {
    return this.ticketRepository.find({
      where: {
        assignedTo: IsNull(),
        status: Not('closed' as TicketStatus),
      },
      order: { priority: 'DESC', createdAt: 'ASC' },
    });
  }

  // ============================================================================
  // Ticket Actions
  // ============================================================================

  /**
   * Assign ticket
   */
  async assignTicket(
    ticketId: string,
    assignedTo: string,
    assignedToName: string,
  ): Promise<SupportTicket> {
    const ticket = await this.getTicket(ticketId);

    ticket.assignedTo = assignedTo;
    ticket.assignedToName = assignedToName;

    if (ticket.status === 'open') {
      ticket.status = 'in_progress';
    }

    // Add system comment
    await this.addComment(ticketId, {
      authorId: 'system',
      authorType: 'system',
      authorName: 'System',
      content: `Ticket assigned to ${assignedToName}`,
      isInternal: true,
    });

    return this.ticketRepository.save(ticket);
  }

  /**
   * Change ticket status
   */
  async changeStatus(
    ticketId: string,
    newStatus: TicketStatus,
    changedBy: string,
    changedByName: string,
  ): Promise<SupportTicket> {
    const ticket = await this.getTicket(ticketId);
    const oldStatus = ticket.status;

    if (oldStatus === newStatus) {
      return ticket;
    }

    ticket.status = newStatus;

    // Track timestamps
    switch (newStatus) {
      case 'resolved':
        ticket.resolvedAt = new Date();
        break;
      case 'closed':
        ticket.closedAt = new Date();
        break;
    }

    // Add system comment
    await this.addComment(ticketId, {
      authorId: changedBy,
      authorType: 'admin',
      authorName: changedByName,
      content: `Status changed from ${oldStatus} to ${newStatus}`,
      isInternal: true,
    });

    return this.ticketRepository.save(ticket);
  }

  /**
   * Change ticket priority
   */
  async changePriority(
    ticketId: string,
    newPriority: TicketPriority,
    changedBy: string,
    changedByName: string,
  ): Promise<SupportTicket> {
    const ticket = await this.getTicket(ticketId);
    const oldPriority = ticket.priority;

    if (oldPriority === newPriority) {
      return ticket;
    }

    // Update priority and SLA
    ticket.priority = newPriority;
    const slaConfig = this.getSLAConfig(newPriority);
    ticket.slaResponseMinutes = slaConfig.firstResponseMinutes;
    ticket.slaResolutionMinutes = slaConfig.resolutionMinutes;

    // Add system comment
    await this.addComment(ticketId, {
      authorId: changedBy,
      authorType: 'admin',
      authorName: changedByName,
      content: `Priority changed from ${oldPriority} to ${newPriority}`,
      isInternal: true,
    });

    return this.ticketRepository.save(ticket);
  }

  // ============================================================================
  // Comments
  // ============================================================================

  /**
   * Add comment to ticket
   */
  async addComment(
    ticketId: string,
    data: {
      authorId: string;
      authorType: 'admin' | 'tenant_user' | 'system';
      authorName: string;
      content: string;
      isInternal?: boolean;
      attachments?: TicketAttachment[];
    },
  ): Promise<TicketComment> {
    const ticket = await this.ticketRepository.findOne({
      where: { id: ticketId },
    });

    if (!ticket) {
      throw new NotFoundException(`Ticket not found: ${ticketId}`);
    }

    // Create comment
    const comment = this.commentRepository.create({
      ticketId,
      authorId: data.authorId,
      authorType: data.authorType,
      authorName: data.authorName,
      content: data.content,
      isInternal: data.isInternal || false,
      attachments: data.attachments || [],
    });
    await this.commentRepository.save(comment);

    // Track first response time for admin responses
    if (data.authorType === 'admin' && !ticket.firstResponseAt) {
      ticket.firstResponseAt = new Date();

      // Check SLA breach
      const responseTime = (ticket.firstResponseAt.getTime() - ticket.createdAt.getTime()) / 60000;
      if (responseTime > (ticket.slaResponseMinutes || 0)) {
        ticket.slaBreached = true;
      }

      await this.ticketRepository.save(ticket);
    }

    // Update ticket status if customer responds to waiting_customer
    if (data.authorType === 'tenant_user' && ticket.status === 'waiting_customer') {
      ticket.status = 'in_progress';
      await this.ticketRepository.save(ticket);
    }

    return comment;
  }

  /**
   * Get comments for ticket
   */
  async getComments(
    ticketId: string,
    options: { includeInternal?: boolean } = {},
  ): Promise<TicketComment[]> {
    const { includeInternal = true } = options;

    const where: Record<string, unknown> = { ticketId };
    if (!includeInternal) where.isInternal = false;

    return this.commentRepository.find({
      where,
      order: { createdAt: 'ASC' },
    });
  }

  // ============================================================================
  // Satisfaction Rating
  // ============================================================================

  /**
   * Submit satisfaction rating
   */
  async submitSatisfactionRating(
    ticketId: string,
    rating: number,
    feedback?: string,
  ): Promise<SupportTicket> {
    if (rating < 1 || rating > 5) {
      throw new BadRequestException('Rating must be between 1 and 5');
    }

    const ticket = await this.getTicket(ticketId);

    if (ticket.status !== 'closed' && ticket.status !== 'resolved') {
      throw new BadRequestException('Can only rate closed or resolved tickets');
    }

    ticket.satisfactionRating = rating;
    ticket.satisfactionFeedback = feedback ?? null;

    return this.ticketRepository.save(ticket);
  }

  // ============================================================================
  // SLA Monitoring
  // ============================================================================

  /**
   * Check SLA breaches (runs every 5 minutes)
   */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkSLABreaches(): Promise<void> {
    const now = new Date();

    // Find tickets at risk of SLA breach
    const atRisk = await this.ticketRepository.find({
      where: {
        status: Not('closed' as TicketStatus),
        slaBreached: false,
        dueAt: LessThan(now),
      },
    });

    for (const ticket of atRisk) {
      ticket.slaBreached = true;
      await this.ticketRepository.save(ticket);
      this.logger.warn(`SLA breached for ticket: ${ticket.ticketNumber}`);
    }
  }

  /**
   * Get tickets at SLA risk
   */
  async getTicketsAtSLARisk(): Promise<SupportTicket[]> {
    const now = new Date();
    const warningThreshold = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour

    return this.ticketRepository.find({
      where: {
        status: Not('closed' as TicketStatus),
        slaBreached: false,
        dueAt: Between(now, warningThreshold),
      },
      order: { dueAt: 'ASC' },
    });
  }

  // ============================================================================
  // Team
  // ============================================================================

  /**
   * Get support team members with their active ticket counts
   */
  async getTicketTeam(): Promise<Array<{ id: string; name: string; activeTickets: number }>> {
    const result = await this.ticketRepository
      .createQueryBuilder('ticket')
      .select('ticket.assignedTo', 'id')
      .addSelect('ticket.assignedToName', 'name')
      .addSelect('COUNT(*)', 'activeTickets')
      .where('ticket.assignedTo IS NOT NULL')
      .andWhere('ticket.status NOT IN (:...closedStatuses)', {
        closedStatuses: ['closed', 'resolved'],
      })
      .groupBy('ticket.assignedTo')
      .addGroupBy('ticket.assignedToName')
      .orderBy('COUNT(*)', 'DESC')
      .getRawMany();

    return result.map((r) => ({
      id: r.id || '',
      name: r.name || 'Unknown',
      activeTickets: parseInt(r.activeTickets, 10) || 0,
    }));
  }

  // ============================================================================
  // Statistics
  // ============================================================================

  /**
   * Get ticket statistics
   */
  async getTicketStats(): Promise<TicketStats> {
    const all = await this.ticketRepository.find();

    const resolved = all.filter(t => t.resolvedAt);
    const withResponse = all.filter(t => t.firstResponseAt);
    const withRating = all.filter(t => t.satisfactionRating > 0);

    // Calculate averages
    let avgFirstResponse = 0;
    if (withResponse.length > 0) {
      const totalResponseTime = withResponse.reduce((sum, t) => {
        return sum + (t.firstResponseAt!.getTime() - t.createdAt.getTime());
      }, 0);
      avgFirstResponse = Math.round(totalResponseTime / withResponse.length / 60000);
    }

    let avgResolution = 0;
    if (resolved.length > 0) {
      const totalResolutionTime = resolved.reduce((sum, t) => {
        return sum + (t.resolvedAt!.getTime() - t.createdAt.getTime());
      }, 0);
      avgResolution = Math.round(totalResolutionTime / resolved.length / 60000);
    }

    let avgSatisfaction = 0;
    if (withRating.length > 0) {
      avgSatisfaction = withRating.reduce((sum, t) => sum + t.satisfactionRating, 0) / withRating.length;
    }

    return {
      total: all.length,
      open: all.filter(t => t.status === 'open').length,
      inProgress: all.filter(t => t.status === 'in_progress').length,
      waitingCustomer: all.filter(t => t.status === 'waiting_customer').length,
      resolved: all.filter(t => t.status === 'resolved').length,
      closed: all.filter(t => t.status === 'closed').length,
      avgFirstResponseMinutes: avgFirstResponse,
      avgResolutionMinutes: avgResolution,
      slaBreachCount: all.filter(t => t.slaBreached).length,
      avgSatisfactionRating: Math.round(avgSatisfaction * 10) / 10,
    };
  }

  /**
   * Get stats by category
   */
  async getStatsByCategory(): Promise<Record<TicketCategory, number>> {
    const all = await this.ticketRepository.find();

    return {
      technical: all.filter(t => t.category === 'technical').length,
      billing: all.filter(t => t.category === 'billing').length,
      feature_request: all.filter(t => t.category === 'feature_request').length,
      bug_report: all.filter(t => t.category === 'bug_report').length,
      general: all.filter(t => t.category === 'general').length,
      account: all.filter(t => t.category === 'account').length,
    };
  }

  /**
   * Get stats by priority
   */
  async getStatsByPriority(): Promise<Record<TicketPriority, number>> {
    const all = await this.ticketRepository.find({
      where: { status: Not('closed' as TicketStatus) },
    });

    return {
      critical: all.filter(t => t.priority === 'critical').length,
      high: all.filter(t => t.priority === 'high').length,
      medium: all.filter(t => t.priority === 'medium').length,
      low: all.filter(t => t.priority === 'low').length,
    };
  }
}
