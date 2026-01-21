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
import { MessageThread, ThreadStatus } from '../entities/message-thread.entity';
import { Message, SenderType, MessageStatus } from '../entities/message.entity';
import { MessagingService } from '../services/messaging.service';


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

const createMockThread = (overrides: Partial<MessageThread> = {}): MessageThread => {
  const thread = new MessageThread();
  Object.assign(thread, {
    id: 'thread-uuid-123',
    tenantId: 'tenant-uuid-123',
    subject: 'Test Thread',
    lastMessage: 'Test message',
    lastMessageAt: new Date(),
    lastMessageBy: 'user-uuid-123',
    status: ThreadStatus.OPEN,
    messageCount: 1,
    unreadCountAdmin: 0,
    unreadCountTenant: 0,
    createdBy: 'user-uuid-123',
    createdByAdmin: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return thread;
};

const createMockMessage = (overrides: Partial<Message> = {}): Message => {
  const message = new Message();
  Object.assign(message, {
    id: 'message-uuid-123',
    threadId: 'thread-uuid-123',
    senderId: 'user-uuid-123',
    senderType: SenderType.TENANT_ADMIN,
    senderName: 'Test User',
    content: 'Test message content',
    status: MessageStatus.SENT,
    isInternal: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
  return message;
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
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  })),
});

// ============================================================================
// Tests
// ============================================================================

describe('MessagingService', () => {
  let service: MessagingService;
  let threadRepository: jest.Mocked<Repository<MessageThread>>;
  let messageRepository: jest.Mocked<Repository<Message>>;
  let userRepository: jest.Mocked<Repository<User>>;
  let tenantRepository: jest.Mocked<Repository<Tenant>>;

  beforeEach(async () => {
    const mockThreadRepo = createMockRepository();
    const mockMessageRepo = createMockRepository();
    const mockUserRepo = createMockRepository();
    const mockTenantRepo = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(MessageThread), useValue: mockThreadRepo },
        { provide: getRepositoryToken(Message), useValue: mockMessageRepo },
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(Tenant), useValue: mockTenantRepo },
      ],
    }).compile();

    service = module.get<MessagingService>(MessagingService);
    threadRepository = module.get(getRepositoryToken(MessageThread));
    messageRepository = module.get(getRepositoryToken(Message));
    userRepository = module.get(getRepositoryToken(User));
    tenantRepository = module.get(getRepositoryToken(Tenant));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // Thread Operations
  // ==========================================================================

  describe('getThreads', () => {
    it('should return threads for TenantAdmin filtered by their tenant', async () => {
      const tenantAdmin = createMockUser({ role: Role.TENANT_ADMIN, tenantId: 'tenant-1' });
      const threads = [
        createMockThread({ id: 'thread-1', tenantId: 'tenant-1' }),
        createMockThread({ id: 'thread-2', tenantId: 'tenant-1' }),
      ];

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      (threadRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue(threads);

      const result = await service.getThreads(tenantAdmin.id);

      expect(result).toHaveLength(2);
      expect(result[0].tenantId).toBe('tenant-1');
    });

    it('should return all threads for SuperAdmin', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const threads = [
        createMockThread({ id: 'thread-1', tenantId: 'tenant-1' }),
        createMockThread({ id: 'thread-2', tenantId: 'tenant-2' }),
      ];

      userRepository.findOne.mockResolvedValue(superAdmin);
      (threadRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue(threads);

      const result = await service.getThreads(superAdmin.id);

      expect(result).toHaveLength(2);
    });

    it('should throw NotFoundException when user not found', async () => {
      userRepository.findOne.mockResolvedValue(null);

      await expect(service.getThreads('invalid-user')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getThread', () => {
    it('should return thread for authorized TenantAdmin', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const thread = createMockThread({ tenantId: 'tenant-1' });

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      threadRepository.findOne.mockResolvedValue(thread);

      const result = await service.getThread(tenantAdmin.id, thread.id);

      expect(result).toEqual(thread);
    });

    it('should throw ForbiddenException when TenantAdmin accesses other tenant thread', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const thread = createMockThread({ tenantId: 'tenant-2' }); // Different tenant

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      threadRepository.findOne.mockResolvedValue(thread);

      await expect(service.getThread(tenantAdmin.id, thread.id)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should allow SuperAdmin to access any thread', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const thread = createMockThread({ tenantId: 'any-tenant' });

      userRepository.findOne.mockResolvedValue(superAdmin);
      threadRepository.findOne.mockResolvedValue(thread);

      const result = await service.getThread(superAdmin.id, thread.id);

      expect(result).toEqual(thread);
    });

    it('should throw NotFoundException when thread not found', async () => {
      const user = createMockUser();
      userRepository.findOne.mockResolvedValue(user);
      threadRepository.findOne.mockResolvedValue(null);

      await expect(service.getThread(user.id, 'invalid-thread')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('createThread', () => {
    it('should create thread by TenantAdmin for their tenant', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const tenant = createMockTenant({ id: 'tenant-1' });
      const input = { subject: 'New Thread', initialMessage: 'Hello' };

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      tenantRepository.findOne.mockResolvedValue(tenant);
      threadRepository.save.mockResolvedValue(createMockThread({ ...input, tenantId: 'tenant-1' }));
      messageRepository.save.mockResolvedValue(createMockMessage());

      const result = await service.createThread(tenantAdmin.id, input);

      expect(result.tenantId).toBe('tenant-1');
      expect(threadRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          subject: 'New Thread',
          createdByAdmin: false,
        }),
      );
    });

    it('should create thread by SuperAdmin for specified tenant', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const tenant = createMockTenant({ id: 'target-tenant' });
      const input = { subject: 'Admin Thread', initialMessage: 'Hello from admin', tenantId: 'target-tenant' };

      userRepository.findOne.mockResolvedValue(superAdmin);
      tenantRepository.findOne.mockResolvedValue(tenant);
      threadRepository.save.mockResolvedValue(createMockThread({ tenantId: 'target-tenant' }));
      messageRepository.save.mockResolvedValue(createMockMessage());

      const result = await service.createThread(superAdmin.id, input);

      expect(threadRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'target-tenant',
          createdByAdmin: true,
          unreadCountTenant: 1, // Tenant should see as unread
          unreadCountAdmin: 0,
        }),
      );
    });

    it('should throw BadRequestException when SuperAdmin does not specify tenant', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const input = { subject: 'Test', initialMessage: 'Hello' }; // No tenantId

      userRepository.findOne.mockResolvedValue(superAdmin);

      await expect(service.createThread(superAdmin.id, input)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('sendMessage', () => {
    it('should send message from TenantAdmin', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const thread = createMockThread({ tenantId: 'tenant-1' });
      const input = { threadId: thread.id, content: 'My message' };

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      threadRepository.findOne.mockResolvedValue(thread);
      threadRepository.save.mockResolvedValue({ ...thread, messageCount: 2 });
      messageRepository.save.mockResolvedValue(createMockMessage({ content: 'My message' }));

      const result = await service.sendMessage(tenantAdmin.id, input);

      expect(messageRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'My message',
          senderType: SenderType.TENANT_ADMIN,
          isInternal: false,
        }),
      );
    });

    it('should send message from SuperAdmin', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const thread = createMockThread();
      const input = { threadId: thread.id, content: 'Admin response' };

      userRepository.findOne.mockResolvedValue(superAdmin);
      threadRepository.findOne.mockResolvedValue(thread);
      threadRepository.save.mockResolvedValue(thread);
      messageRepository.save.mockResolvedValue(createMockMessage());

      await service.sendMessage(superAdmin.id, input);

      expect(messageRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          senderType: SenderType.SUPER_ADMIN,
        }),
      );
    });

    it('should allow SuperAdmin to send internal notes', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const thread = createMockThread();
      const input = { threadId: thread.id, content: 'Internal note', isInternal: true };

      userRepository.findOne.mockResolvedValue(superAdmin);
      threadRepository.findOne.mockResolvedValue(thread);
      threadRepository.save.mockResolvedValue(thread);
      messageRepository.save.mockResolvedValue(createMockMessage({ isInternal: true }));

      await service.sendMessage(superAdmin.id, input);

      expect(messageRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          isInternal: true,
        }),
      );
    });

    it('should throw ForbiddenException when TenantAdmin tries to send internal note', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const thread = createMockThread({ tenantId: 'tenant-1' });
      const input = { threadId: thread.id, content: 'Trying internal', isInternal: true };

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      threadRepository.findOne.mockResolvedValue(thread);

      await expect(service.sendMessage(tenantAdmin.id, input)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should throw BadRequestException when thread is closed', async () => {
      const user = createMockUser({ tenantId: 'tenant-1' });
      const closedThread = createMockThread({ status: ThreadStatus.CLOSED, tenantId: 'tenant-1' });
      const input = { threadId: closedThread.id, content: 'Message' };

      userRepository.findOne.mockResolvedValue(user);
      threadRepository.findOne.mockResolvedValue(closedThread);

      await expect(service.sendMessage(user.id, input)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('should increment unread count for recipient', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const thread = createMockThread({ tenantId: 'tenant-1', unreadCountAdmin: 0 });

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      threadRepository.findOne.mockResolvedValue(thread);
      threadRepository.save.mockImplementation((t) => Promise.resolve(t as MessageThread));
      messageRepository.save.mockResolvedValue(createMockMessage());

      await service.sendMessage(tenantAdmin.id, { threadId: thread.id, content: 'Hello' });

      expect(threadRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          unreadCountAdmin: 1, // Admin should see new message
        }),
      );
    });
  });

  describe('getMessages', () => {
    it('should return messages excluding internal notes for TenantAdmin', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const thread = createMockThread({ tenantId: 'tenant-1' });
      const messages = [
        createMockMessage({ isInternal: false }),
        // Internal note should not appear for TenantAdmin
      ];

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      threadRepository.findOne.mockResolvedValue(thread);
      (messageRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue(messages);
      threadRepository.update.mockResolvedValue({ affected: 1 } as any);

      const result = await service.getMessages(tenantAdmin.id, thread.id);

      // Verify internal filter was applied
      expect(messageRepository.createQueryBuilder().andWhere).toHaveBeenCalledWith(
        'message.isInternal = false',
      );
    });

    it('should return all messages including internal notes for SuperAdmin', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const thread = createMockThread();
      const messages = [
        createMockMessage({ isInternal: false }),
        createMockMessage({ isInternal: true }),
      ];

      userRepository.findOne.mockResolvedValue(superAdmin);
      threadRepository.findOne.mockResolvedValue(thread);
      (messageRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue(messages);
      threadRepository.update.mockResolvedValue({ affected: 1 } as any);

      const result = await service.getMessages(superAdmin.id, thread.id);

      // Internal filter should NOT be applied for SuperAdmin
      // The andWhere for isInternal should not be called
    });
  });

  describe('closeThread', () => {
    it('should close thread', async () => {
      const user = createMockUser({ tenantId: 'tenant-1' });
      const thread = createMockThread({ tenantId: 'tenant-1', status: ThreadStatus.OPEN });

      userRepository.findOne.mockResolvedValue(user);
      threadRepository.findOne.mockResolvedValue(thread);
      threadRepository.save.mockResolvedValue({ ...thread, status: ThreadStatus.CLOSED });

      const result = await service.closeThread(user.id, thread.id);

      expect(threadRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ThreadStatus.CLOSED }),
      );
    });
  });

  describe('reopenThread', () => {
    it('should reopen closed thread', async () => {
      const user = createMockUser({ tenantId: 'tenant-1' });
      const thread = createMockThread({ tenantId: 'tenant-1', status: ThreadStatus.CLOSED });

      userRepository.findOne.mockResolvedValue(user);
      threadRepository.findOne.mockResolvedValue(thread);
      threadRepository.save.mockResolvedValue({ ...thread, status: ThreadStatus.OPEN });

      const result = await service.reopenThread(user.id, thread.id);

      expect(threadRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ThreadStatus.OPEN }),
      );
    });
  });

  describe('archiveThread', () => {
    it('should allow SuperAdmin to archive thread', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const thread = createMockThread();

      userRepository.findOne.mockResolvedValue(superAdmin);
      threadRepository.findOne.mockResolvedValue(thread);
      threadRepository.save.mockResolvedValue({ ...thread, status: ThreadStatus.ARCHIVED });

      const result = await service.archiveThread(superAdmin.id, thread.id);

      expect(threadRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ThreadStatus.ARCHIVED }),
      );
    });

    it('should throw ForbiddenException when TenantAdmin tries to archive', async () => {
      const tenantAdmin = createMockUser({ role: Role.TENANT_ADMIN, tenantId: 'tenant-1' });

      userRepository.findOne.mockResolvedValue(tenantAdmin);

      await expect(service.archiveThread(tenantAdmin.id, 'thread-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  // ==========================================================================
  // Statistics
  // ==========================================================================

  describe('getStats', () => {
    it('should return statistics for TenantAdmin', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const threads = [
        createMockThread({ status: ThreadStatus.OPEN, unreadCountTenant: 2 }),
        createMockThread({ status: ThreadStatus.CLOSED }),
      ];

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      (threadRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue(threads);

      const stats = await service.getStats(tenantAdmin.id);

      expect(stats.totalThreads).toBe(2);
      expect(stats.activeThreads).toBe(1);
      expect(stats.closedThreads).toBe(1);
    });

    it('should return global statistics for SuperAdmin', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const threads = [
        createMockThread({ status: ThreadStatus.OPEN, unreadCountAdmin: 1, tenantId: 'tenant-1' }),
        createMockThread({ status: ThreadStatus.OPEN, unreadCountAdmin: 2, tenantId: 'tenant-2' }),
        createMockThread({ status: ThreadStatus.CLOSED, tenantId: 'tenant-3' }),
      ];

      userRepository.findOne.mockResolvedValue(superAdmin);
      (threadRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue(threads);

      const stats = await service.getStats(superAdmin.id);

      expect(stats.totalThreads).toBe(3);
      expect(stats.activeThreads).toBe(2);
      expect(stats.unreadMessages).toBe(3); // 1 + 2
    });
  });
});

// ============================================================================
// Integration Tests - Communication Flow
// ============================================================================

describe('SuperAdmin-TenantAdmin Communication Integration', () => {
  let service: MessagingService;
  let threadRepository: any;
  let messageRepository: any;
  let userRepository: any;
  let tenantRepository: any;

  beforeEach(async () => {
    const mockThreadRepo = createMockRepository();
    const mockMessageRepo = createMockRepository();
    const mockUserRepo = createMockRepository();
    const mockTenantRepo = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagingService,
        { provide: getRepositoryToken(MessageThread), useValue: mockThreadRepo },
        { provide: getRepositoryToken(Message), useValue: mockMessageRepo },
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(Tenant), useValue: mockTenantRepo },
      ],
    }).compile();

    service = module.get<MessagingService>(MessagingService);
    threadRepository = module.get(getRepositoryToken(MessageThread));
    messageRepository = module.get(getRepositoryToken(Message));
    userRepository = module.get(getRepositoryToken(User));
    tenantRepository = module.get(getRepositoryToken(Tenant));
  });

  describe('Full Communication Flow', () => {
    it('should complete a full conversation between SuperAdmin and TenantAdmin', async () => {
      // Setup users
      const superAdmin = createMockUser({
        id: 'super-admin-1',
        role: Role.SUPER_ADMIN,
        tenantId: undefined,
        email: 'admin@platform.com',
      });
      const tenantAdmin = createMockUser({
        id: 'tenant-admin-1',
        role: Role.TENANT_ADMIN,
        tenantId: 'tenant-1',
        email: 'admin@tenant.com',
      });
      const tenant = createMockTenant({ id: 'tenant-1' });

      // Step 1: TenantAdmin creates a thread
      userRepository.findOne.mockResolvedValueOnce(tenantAdmin);
      tenantRepository.findOne.mockResolvedValueOnce(tenant);

      const newThread = createMockThread({
        id: 'new-thread-1',
        tenantId: 'tenant-1',
        subject: 'Help needed',
        unreadCountAdmin: 1,
        unreadCountTenant: 0,
      });
      threadRepository.save.mockResolvedValueOnce(newThread);
      messageRepository.save.mockResolvedValueOnce(createMockMessage());

      await service.createThread(tenantAdmin.id, {
        subject: 'Help needed',
        initialMessage: 'I need help with...',
      });

      expect(threadRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          createdByAdmin: false,
          unreadCountAdmin: 1, // SuperAdmin should see unread
        }),
      );

      // Step 2: SuperAdmin reads and responds
      userRepository.findOne.mockResolvedValueOnce(superAdmin);
      threadRepository.findOne.mockResolvedValueOnce(newThread);

      const updatedThread = { ...newThread, unreadCountTenant: 1, messageCount: 2 };
      threadRepository.save.mockResolvedValueOnce(updatedThread);
      messageRepository.save.mockResolvedValueOnce(createMockMessage({
        senderType: SenderType.SUPER_ADMIN,
      }));

      await service.sendMessage(superAdmin.id, {
        threadId: newThread.id,
        content: 'I can help you with that...',
      });

      expect(messageRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          senderType: SenderType.SUPER_ADMIN,
        }),
      );

      // Step 3: SuperAdmin adds internal note (not visible to TenantAdmin)
      userRepository.findOne.mockResolvedValueOnce(superAdmin);
      threadRepository.findOne.mockResolvedValueOnce(updatedThread);
      threadRepository.save.mockResolvedValueOnce(updatedThread);
      messageRepository.save.mockResolvedValueOnce(createMockMessage({
        isInternal: true,
        content: 'Check billing status',
      }));

      await service.sendMessage(superAdmin.id, {
        threadId: newThread.id,
        content: 'Check billing status',
        isInternal: true,
      });

      expect(messageRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          isInternal: true,
        }),
      );

      // Step 4: TenantAdmin cannot see internal notes
      userRepository.findOne.mockResolvedValueOnce(tenantAdmin);
      threadRepository.findOne.mockResolvedValueOnce(updatedThread);
      (messageRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue([
        createMockMessage({ isInternal: false }),
      ]);
      threadRepository.update.mockResolvedValue({ affected: 1 });

      await service.getMessages(tenantAdmin.id, newThread.id);

      expect(messageRepository.createQueryBuilder().andWhere).toHaveBeenCalledWith(
        'message.isInternal = false',
      );
    });

    it('should track unread counts correctly throughout conversation', async () => {
      const superAdmin = createMockUser({
        id: 'super-admin-1',
        role: Role.SUPER_ADMIN,
        tenantId: undefined,
      });
      const tenantAdmin = createMockUser({
        id: 'tenant-admin-1',
        role: Role.TENANT_ADMIN,
        tenantId: 'tenant-1',
      });
      const tenant = createMockTenant({ id: 'tenant-1' });

      // TenantAdmin sends message - unreadCountAdmin should increment
      userRepository.findOne.mockResolvedValueOnce(tenantAdmin);
      tenantRepository.findOne.mockResolvedValueOnce(tenant);

      const thread = createMockThread({
        tenantId: 'tenant-1',
        unreadCountAdmin: 0,
        unreadCountTenant: 0,
      });
      threadRepository.save.mockResolvedValue(thread);
      messageRepository.save.mockResolvedValue(createMockMessage());

      await service.createThread(tenantAdmin.id, {
        subject: 'Test',
        initialMessage: 'Hello',
      });

      expect(threadRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          unreadCountAdmin: 1,
          unreadCountTenant: 0,
        }),
      );

      // SuperAdmin replies - unreadCountTenant should increment
      userRepository.findOne.mockResolvedValueOnce(superAdmin);
      threadRepository.findOne.mockResolvedValueOnce(thread);

      await service.sendMessage(superAdmin.id, {
        threadId: thread.id,
        content: 'Reply',
      });

      expect(threadRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          unreadCountTenant: 1,
        }),
      );
    });
  });
});
