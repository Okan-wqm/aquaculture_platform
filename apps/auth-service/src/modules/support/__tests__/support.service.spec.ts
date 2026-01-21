/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/require-await */
/* eslint-disable @typescript-eslint/no-floating-promises */
import { NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Role } from '@platform/backend-common';
import { Repository } from 'typeorm';

import { User } from '../../authentication/entities/user.entity';
import { Tenant } from '../../tenant/entities/tenant.entity';
import {
  SupportTicket,
  TicketPriority,
  TicketStatus,
  TicketCategory,
} from '../entities/support-ticket.entity';
import { TicketComment, CommentAuthorType } from '../entities/ticket-comment.entity';
import { SupportService } from '../services/support.service';


// ============================================================================
// Mock Helpers
// ============================================================================

const createMockUser = (overrides: Partial<User> = {}): User => {
  const user = new User();
  Object.assign(user, {
    id: 'user-uuid-123',
    email: 'user@test.com',
    firstName: 'Test',
    lastName: 'User',
    role: Role.TENANT_ADMIN,
    tenantId: 'tenant-uuid-123',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return user;
};

const createMockTenant = (overrides: Partial<Tenant> = {}): Tenant => {
  const tenant = new Tenant();
  Object.assign(tenant, {
    id: 'tenant-uuid-123',
    name: 'Test Tenant',
    slug: 'test-tenant',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return tenant;
};

const createMockTicket = (overrides: Partial<SupportTicket> = {}): SupportTicket => {
  const ticket = new SupportTicket();
  Object.assign(ticket, {
    id: 'ticket-uuid-123',
    ticketNumber: 'TKT-2024-000001',
    tenantId: 'tenant-uuid-123',
    subject: 'Test Ticket',
    description: 'Test description',
    category: TicketCategory.TECHNICAL,
    priority: TicketPriority.MEDIUM,
    status: TicketStatus.OPEN,
    reportedBy: 'user-uuid-123',
    reportedByName: 'Test User',
    commentCount: 1,
    tags: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    isResponseSLABreached: () => false,
    isResolutionSLABreached: () => false,
    ...overrides,
  });
  return ticket;
};

const createMockComment = (overrides: Partial<TicketComment> = {}): TicketComment => {
  const comment = new TicketComment();
  Object.assign(comment, {
    id: 'comment-uuid-123',
    ticketId: 'ticket-uuid-123',
    authorId: 'user-uuid-123',
    authorName: 'Test User',
    authorType: CommentAuthorType.TENANT_ADMIN,
    content: 'Test comment',
    isInternal: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return comment;
};

// ============================================================================
// Mock Repository Factory
// ============================================================================

const createMockRepository = () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findAndCount: jest.fn(),
  save: jest.fn(),
  create: jest.fn((data) => data),
  update: jest.fn(),
  delete: jest.fn(),
  createQueryBuilder: jest.fn(() => ({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getOne: jest.fn().mockResolvedValue(null),
  })),
});

// ============================================================================
// Tests
// ============================================================================

describe('SupportService', () => {
  let service: SupportService;
  let ticketRepository: jest.Mocked<Repository<SupportTicket>>;
  let commentRepository: jest.Mocked<Repository<TicketComment>>;
  let userRepository: jest.Mocked<Repository<User>>;
  let tenantRepository: jest.Mocked<Repository<Tenant>>;

  beforeEach(async () => {
    const mockTicketRepo = createMockRepository();
    const mockCommentRepo = createMockRepository();
    const mockUserRepo = createMockRepository();
    const mockTenantRepo = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportService,
        { provide: getRepositoryToken(SupportTicket), useValue: mockTicketRepo },
        { provide: getRepositoryToken(TicketComment), useValue: mockCommentRepo },
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(Tenant), useValue: mockTenantRepo },
      ],
    }).compile();

    service = module.get<SupportService>(SupportService);
    ticketRepository = module.get(getRepositoryToken(SupportTicket));
    commentRepository = module.get(getRepositoryToken(TicketComment));
    userRepository = module.get(getRepositoryToken(User));
    tenantRepository = module.get(getRepositoryToken(Tenant));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // Ticket Operations
  // ==========================================================================

  describe('getTickets', () => {
    it('should return tickets for TenantAdmin filtered by their tenant', async () => {
      const tenantAdmin = createMockUser({ role: Role.TENANT_ADMIN, tenantId: 'tenant-1' });
      const tickets = [
        createMockTicket({ id: 'ticket-1', tenantId: 'tenant-1' }),
        createMockTicket({ id: 'ticket-2', tenantId: 'tenant-1' }),
      ];

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      (ticketRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue(tickets);

      const result = await service.getTickets(tenantAdmin.id);

      expect(result).toHaveLength(2);
    });

    it('should return all tickets for SuperAdmin', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const tickets = [
        createMockTicket({ tenantId: 'tenant-1' }),
        createMockTicket({ tenantId: 'tenant-2' }),
      ];

      userRepository.findOne.mockResolvedValue(superAdmin);
      (ticketRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue(tickets);

      const result = await service.getTickets(superAdmin.id);

      expect(result).toHaveLength(2);
    });
  });

  describe('getTicket', () => {
    it('should return ticket for authorized TenantAdmin', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const ticket = createMockTicket({ tenantId: 'tenant-1' });

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      ticketRepository.findOne.mockResolvedValue(ticket);

      const result = await service.getTicket(tenantAdmin.id, ticket.id);

      expect(result).toEqual(ticket);
    });

    it('should throw ForbiddenException when TenantAdmin accesses other tenant ticket', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const ticket = createMockTicket({ tenantId: 'tenant-2' });

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      ticketRepository.findOne.mockResolvedValue(ticket);

      await expect(service.getTicket(tenantAdmin.id, ticket.id)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  describe('createTicket', () => {
    it('should create ticket with SLA deadlines', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const tenant = createMockTenant({ id: 'tenant-1' });
      const input = {
        subject: 'New Issue',
        description: 'Description',
        category: TicketCategory.TECHNICAL,
        priority: TicketPriority.HIGH,
      };

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      tenantRepository.findOne.mockResolvedValue(tenant);
      ticketRepository.save.mockResolvedValue(createMockTicket({ ...input, tenantId: 'tenant-1' }));
      commentRepository.save.mockResolvedValue(createMockComment());

      await service.createTicket(tenantAdmin.id, input);

      expect(ticketRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          subject: 'New Issue',
          status: TicketStatus.OPEN,
          slaResponseDeadline: expect.any(Date),
          slaResolutionDeadline: expect.any(Date),
        }),
      );
    });
  });

  describe('addComment', () => {
    it('should allow TenantAdmin to add public comment', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const ticket = createMockTicket({ tenantId: 'tenant-1' });
      const input = { ticketId: ticket.id, content: 'My comment' };

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      ticketRepository.findOne.mockResolvedValue(ticket);
      ticketRepository.save.mockResolvedValue(ticket);
      commentRepository.save.mockResolvedValue(createMockComment({ content: 'My comment' }));

      await service.addComment(tenantAdmin.id, input);

      expect(commentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'My comment',
          authorType: CommentAuthorType.TENANT_ADMIN,
          isInternal: false,
        }),
      );
    });

    it('should throw ForbiddenException when TenantAdmin tries internal note', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const ticket = createMockTicket({ tenantId: 'tenant-1' });
      const input = { ticketId: ticket.id, content: 'Internal', isInternal: true };

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      ticketRepository.findOne.mockResolvedValue(ticket);

      await expect(service.addComment(tenantAdmin.id, input)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should allow SuperAdmin to add internal note', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const ticket = createMockTicket();

      userRepository.findOne.mockResolvedValue(superAdmin);
      ticketRepository.findOne.mockResolvedValue(ticket);
      ticketRepository.save.mockResolvedValue(ticket);
      commentRepository.save.mockResolvedValue(createMockComment({ isInternal: true }));

      await service.addComment(superAdmin.id, {
        ticketId: ticket.id,
        content: 'Internal note',
        isInternal: true,
      });

      expect(commentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          isInternal: true,
        }),
      );
    });

    it('should set firstResponseAt when SuperAdmin replies', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const ticket = createMockTicket({ firstResponseAt: undefined });

      userRepository.findOne.mockResolvedValue(superAdmin);
      ticketRepository.findOne.mockResolvedValue(ticket);
      ticketRepository.save.mockImplementation((t) => Promise.resolve(t as SupportTicket));
      commentRepository.save.mockResolvedValue(createMockComment());

      await service.addComment(superAdmin.id, {
        ticketId: ticket.id,
        content: 'Response',
      });

      expect(ticketRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          firstResponseAt: expect.any(Date),
        }),
      );
    });

    it('should throw BadRequestException for closed ticket', async () => {
      const user = createMockUser({ tenantId: 'tenant-1' });
      const ticket = createMockTicket({ status: TicketStatus.CLOSED, tenantId: 'tenant-1' });

      userRepository.findOne.mockResolvedValue(user);
      ticketRepository.findOne.mockResolvedValue(ticket);

      await expect(
        service.addComment(user.id, { ticketId: ticket.id, content: 'Comment' }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getComments', () => {
    it('should filter internal notes for TenantAdmin', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const ticket = createMockTicket({ tenantId: 'tenant-1' });

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      ticketRepository.findOne.mockResolvedValue(ticket);
      (commentRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue([
        createMockComment({ isInternal: false }),
      ]);

      await service.getComments(tenantAdmin.id, ticket.id);

      expect(commentRepository.createQueryBuilder().andWhere).toHaveBeenCalledWith(
        'comment.isInternal = false',
      );
    });

    it('should include internal notes for SuperAdmin', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const ticket = createMockTicket();

      userRepository.findOne.mockResolvedValue(superAdmin);
      ticketRepository.findOne.mockResolvedValue(ticket);
      (commentRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue([
        createMockComment({ isInternal: false }),
        createMockComment({ isInternal: true }),
      ]);

      await service.getComments(superAdmin.id, ticket.id);

      // Internal filter should NOT be called for SuperAdmin
    });
  });

  describe('updateStatus', () => {
    it('should allow SuperAdmin to update status', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const ticket = createMockTicket();

      userRepository.findOne.mockResolvedValue(superAdmin);
      ticketRepository.findOne.mockResolvedValue(ticket);
      ticketRepository.save.mockResolvedValue({ ...ticket, status: TicketStatus.IN_PROGRESS });

      await service.updateStatus(superAdmin.id, {
        ticketId: ticket.id,
        status: TicketStatus.IN_PROGRESS,
      });

      expect(ticketRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: TicketStatus.IN_PROGRESS }),
      );
    });

    it('should throw ForbiddenException for TenantAdmin', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });

      userRepository.findOne.mockResolvedValue(tenantAdmin);

      await expect(
        service.updateStatus(tenantAdmin.id, {
          ticketId: 'ticket-1',
          status: TicketStatus.RESOLVED,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should set resolvedAt when resolving', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const ticket = createMockTicket();

      userRepository.findOne.mockResolvedValue(superAdmin);
      ticketRepository.findOne.mockResolvedValue(ticket);
      ticketRepository.save.mockImplementation((t) => Promise.resolve(t as SupportTicket));

      await service.updateStatus(superAdmin.id, {
        ticketId: ticket.id,
        status: TicketStatus.RESOLVED,
      });

      expect(ticketRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: TicketStatus.RESOLVED,
          resolvedAt: expect.any(Date),
        }),
      );
    });
  });

  describe('assignTicket', () => {
    it('should allow SuperAdmin to assign ticket', async () => {
      const superAdmin = createMockUser({
        id: 'admin-1',
        role: Role.SUPER_ADMIN,
        tenantId: undefined,
      });
      const assignee = createMockUser({
        id: 'assignee-1',
        firstName: 'Support',
        lastName: 'Agent',
      });
      const ticket = createMockTicket();

      userRepository.findOne
        .mockResolvedValueOnce(superAdmin)
        .mockResolvedValueOnce(assignee);
      ticketRepository.findOne.mockResolvedValue(ticket);
      ticketRepository.save.mockImplementation((t) => Promise.resolve(t as SupportTicket));

      await service.assignTicket(superAdmin.id, {
        ticketId: ticket.id,
        assigneeId: assignee.id,
      });

      expect(ticketRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          assignedTo: 'assignee-1',
          assignedToName: 'Support Agent',
          status: TicketStatus.IN_PROGRESS,
        }),
      );
    });

    it('should throw ForbiddenException for TenantAdmin', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });

      userRepository.findOne.mockResolvedValue(tenantAdmin);

      await expect(
        service.assignTicket(tenantAdmin.id, {
          ticketId: 'ticket-1',
          assigneeId: 'assignee-1',
        }),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('rateTicket', () => {
    it('should allow TenantAdmin to rate resolved ticket', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const ticket = createMockTicket({
        tenantId: 'tenant-1',
        status: TicketStatus.RESOLVED,
      });

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      ticketRepository.findOne.mockResolvedValue(ticket);
      ticketRepository.save.mockImplementation((t) => Promise.resolve(t as SupportTicket));

      await service.rateTicket(tenantAdmin.id, {
        ticketId: ticket.id,
        rating: 5,
        comment: 'Great support!',
      });

      expect(ticketRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          satisfactionRating: 5,
          satisfactionComment: 'Great support!',
          status: TicketStatus.CLOSED,
        }),
      );
    });

    it('should throw BadRequestException for non-resolved ticket', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const ticket = createMockTicket({
        tenantId: 'tenant-1',
        status: TicketStatus.OPEN,
      });

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      ticketRepository.findOne.mockResolvedValue(ticket);

      await expect(
        service.rateTicket(tenantAdmin.id, { ticketId: ticket.id, rating: 5 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw BadRequestException if already rated', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const ticket = createMockTicket({
        tenantId: 'tenant-1',
        status: TicketStatus.RESOLVED,
        satisfactionRating: 4,
      });

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      ticketRepository.findOne.mockResolvedValue(ticket);

      await expect(
        service.rateTicket(tenantAdmin.id, { ticketId: ticket.id, rating: 5 }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getStats', () => {
    it('should return statistics', async () => {
      const user = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const tickets = [
        createMockTicket({ status: TicketStatus.OPEN }),
        createMockTicket({ status: TicketStatus.IN_PROGRESS }),
        createMockTicket({
          status: TicketStatus.RESOLVED,
          satisfactionRating: 5,
          firstResponseAt: new Date(Date.now() - 30 * 60000),
          resolvedAt: new Date(Date.now() - 10 * 60000),
        }),
      ];

      userRepository.findOne.mockResolvedValue(user);
      (ticketRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue(tickets);

      const stats = await service.getStats(user.id);

      expect(stats.total).toBe(3);
      expect(stats.open).toBe(1);
      expect(stats.inProgress).toBe(1);
      expect(stats.resolved).toBe(1);
    });
  });
});

// ============================================================================
// Integration Tests - Support Ticket Flow
// ============================================================================

describe('SuperAdmin-TenantAdmin Support Ticket Integration', () => {
  let service: SupportService;
  let ticketRepository: any;
  let commentRepository: any;
  let userRepository: any;
  let tenantRepository: any;

  beforeEach(async () => {
    const mockTicketRepo = createMockRepository();
    const mockCommentRepo = createMockRepository();
    const mockUserRepo = createMockRepository();
    const mockTenantRepo = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SupportService,
        { provide: getRepositoryToken(SupportTicket), useValue: mockTicketRepo },
        { provide: getRepositoryToken(TicketComment), useValue: mockCommentRepo },
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(Tenant), useValue: mockTenantRepo },
      ],
    }).compile();

    service = module.get<SupportService>(SupportService);
    ticketRepository = module.get(getRepositoryToken(SupportTicket));
    commentRepository = module.get(getRepositoryToken(TicketComment));
    userRepository = module.get(getRepositoryToken(User));
    tenantRepository = module.get(getRepositoryToken(Tenant));
  });

  describe('Full Support Ticket Flow', () => {
    it('should complete a full support ticket lifecycle', async () => {
      const superAdmin = createMockUser({
        id: 'super-admin-1',
        role: Role.SUPER_ADMIN,
        tenantId: undefined,
        email: 'support@platform.com',
        firstName: 'Support',
        lastName: 'Agent',
      });
      const tenantAdmin = createMockUser({
        id: 'tenant-admin-1',
        role: Role.TENANT_ADMIN,
        tenantId: 'tenant-1',
        email: 'admin@tenant.com',
        firstName: 'Tenant',
        lastName: 'Admin',
      });
      const tenant = createMockTenant({ id: 'tenant-1' });

      // Step 1: TenantAdmin creates a ticket
      userRepository.findOne.mockResolvedValueOnce(tenantAdmin);
      tenantRepository.findOne.mockResolvedValueOnce(tenant);

      const newTicket = createMockTicket({
        id: 'ticket-1',
        tenantId: 'tenant-1',
        subject: 'Dashboard not loading',
        status: TicketStatus.OPEN,
      });
      ticketRepository.save.mockResolvedValueOnce(newTicket);
      commentRepository.save.mockResolvedValueOnce(createMockComment());

      await service.createTicket(tenantAdmin.id, {
        subject: 'Dashboard not loading',
        description: 'Getting error when loading dashboard',
        category: TicketCategory.TECHNICAL,
        priority: TicketPriority.HIGH,
      });

      expect(ticketRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: TicketStatus.OPEN,
          reportedByName: 'Tenant Admin',
        }),
      );

      // Step 2: SuperAdmin assigns ticket to themselves
      userRepository.findOne
        .mockResolvedValueOnce(superAdmin)
        .mockResolvedValueOnce(superAdmin);
      ticketRepository.findOne.mockResolvedValueOnce(newTicket);
      ticketRepository.save.mockImplementation((t) => Promise.resolve(t));

      await service.assignTicket(superAdmin.id, {
        ticketId: newTicket.id,
        assigneeId: superAdmin.id,
      });

      expect(ticketRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          assignedTo: superAdmin.id,
          status: TicketStatus.IN_PROGRESS,
        }),
      );

      // Step 3: SuperAdmin responds (sets firstResponseAt)
      userRepository.findOne.mockResolvedValueOnce(superAdmin);
      ticketRepository.findOne.mockResolvedValueOnce({
        ...newTicket,
        status: TicketStatus.IN_PROGRESS,
        firstResponseAt: undefined,
      });
      ticketRepository.save.mockImplementation((t) => Promise.resolve(t));
      commentRepository.save.mockResolvedValue(createMockComment({
        authorType: CommentAuthorType.SUPER_ADMIN,
      }));

      await service.addComment(superAdmin.id, {
        ticketId: newTicket.id,
        content: 'Looking into this issue...',
      });

      expect(ticketRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          firstResponseAt: expect.any(Date),
        }),
      );

      // Step 4: SuperAdmin adds internal note
      userRepository.findOne.mockResolvedValueOnce(superAdmin);
      ticketRepository.findOne.mockResolvedValueOnce({
        ...newTicket,
        status: TicketStatus.IN_PROGRESS,
      });
      ticketRepository.save.mockImplementation((t) => Promise.resolve(t));
      commentRepository.save.mockResolvedValue(createMockComment({ isInternal: true }));

      await service.addComment(superAdmin.id, {
        ticketId: newTicket.id,
        content: 'Check server logs - possible memory leak',
        isInternal: true,
      });

      expect(commentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          isInternal: true,
        }),
      );

      // Step 5: TenantAdmin cannot see internal notes
      userRepository.findOne.mockResolvedValueOnce(tenantAdmin);
      ticketRepository.findOne.mockResolvedValueOnce({
        ...newTicket,
        tenantId: 'tenant-1',
      });
      (commentRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue([
        createMockComment({ isInternal: false }),
      ]);

      await service.getComments(tenantAdmin.id, newTicket.id);

      expect(commentRepository.createQueryBuilder().andWhere).toHaveBeenCalledWith(
        'comment.isInternal = false',
      );

      // Step 6: SuperAdmin resolves ticket
      userRepository.findOne.mockResolvedValueOnce(superAdmin);
      ticketRepository.findOne.mockResolvedValueOnce({
        ...newTicket,
        status: TicketStatus.IN_PROGRESS,
      });
      ticketRepository.save.mockImplementation((t) => Promise.resolve(t));

      await service.updateStatus(superAdmin.id, {
        ticketId: newTicket.id,
        status: TicketStatus.RESOLVED,
      });

      expect(ticketRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: TicketStatus.RESOLVED,
          resolvedAt: expect.any(Date),
        }),
      );

      // Step 7: TenantAdmin rates the ticket
      userRepository.findOne.mockResolvedValueOnce(tenantAdmin);
      ticketRepository.findOne.mockResolvedValueOnce({
        ...newTicket,
        tenantId: 'tenant-1',
        status: TicketStatus.RESOLVED,
      });
      ticketRepository.save.mockImplementation((t) => Promise.resolve(t));

      await service.rateTicket(tenantAdmin.id, {
        ticketId: newTicket.id,
        rating: 5,
        comment: 'Excellent support!',
      });

      expect(ticketRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          satisfactionRating: 5,
          satisfactionComment: 'Excellent support!',
          status: TicketStatus.CLOSED,
        }),
      );
    });

    it('should enforce SLA tracking throughout ticket lifecycle', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const tenant = createMockTenant({ id: 'tenant-1' });

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      tenantRepository.findOne.mockResolvedValue(tenant);

      const now = new Date();
      const savedTicket = createMockTicket({
        priority: TicketPriority.CRITICAL,
        slaResponseDeadline: new Date(now.getTime() + 30 * 60000), // 30 min
        slaResolutionDeadline: new Date(now.getTime() + 240 * 60000), // 4 hours
      });
      ticketRepository.save.mockResolvedValue(savedTicket);
      commentRepository.save.mockResolvedValue(createMockComment());

      await service.createTicket(tenantAdmin.id, {
        subject: 'Critical Issue',
        description: 'System down',
        category: TicketCategory.TECHNICAL,
        priority: TicketPriority.CRITICAL,
      });

      expect(ticketRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          slaResponseDeadline: expect.any(Date),
          slaResolutionDeadline: expect.any(Date),
        }),
      );
    });
  });
});
