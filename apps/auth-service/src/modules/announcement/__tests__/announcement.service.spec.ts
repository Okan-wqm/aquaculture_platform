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
import { AnnouncementAcknowledgment } from '../entities/announcement-acknowledgment.entity';
import {
  Announcement,
  AnnouncementType,
  AnnouncementStatus,
  AnnouncementScope,
} from '../entities/announcement.entity';
import { AnnouncementService } from '../services/announcement.service';


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

const createMockAnnouncement = (overrides: Partial<Announcement> = {}): Announcement => {
  const announcement = new Announcement();
  Object.assign(announcement, {
    id: 'announcement-uuid-123',
    title: 'Test Announcement',
    content: 'Test content',
    type: AnnouncementType.INFO,
    status: AnnouncementStatus.PUBLISHED,
    scope: AnnouncementScope.PLATFORM,
    isGlobal: true,
    requiresAcknowledgment: false,
    viewCount: 0,
    acknowledgmentCount: 0,
    createdBy: 'admin-uuid-123',
    createdByName: 'Admin User',
    createdAt: new Date(),
    updatedAt: new Date(),
    isActive: () => true,
    ...overrides,
  });
  return announcement;
};

const createMockAcknowledgment = (
  overrides: Partial<AnnouncementAcknowledgment> = {},
): AnnouncementAcknowledgment => {
  const ack = new AnnouncementAcknowledgment();
  Object.assign(ack, {
    id: 'ack-uuid-123',
    announcementId: 'announcement-uuid-123',
    userId: 'user-uuid-123',
    userName: 'Test User',
    tenantId: 'tenant-uuid-123',
    tenantName: 'Test Tenant',
    viewedAt: new Date(),
    acknowledgedAt: null,
    createdAt: new Date(),
    hasAcknowledged: () => false,
    ...overrides,
  });
  return ack;
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
  remove: jest.fn(),
  increment: jest.fn(),
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

describe('AnnouncementService', () => {
  let service: AnnouncementService;
  let announcementRepository: jest.Mocked<Repository<Announcement>>;
  let acknowledgmentRepository: jest.Mocked<Repository<AnnouncementAcknowledgment>>;
  let userRepository: jest.Mocked<Repository<User>>;
  let tenantRepository: jest.Mocked<Repository<Tenant>>;

  beforeEach(async () => {
    const mockAnnouncementRepo = createMockRepository();
    const mockAckRepo = createMockRepository();
    const mockUserRepo = createMockRepository();
    const mockTenantRepo = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnnouncementService,
        { provide: getRepositoryToken(Announcement), useValue: mockAnnouncementRepo },
        { provide: getRepositoryToken(AnnouncementAcknowledgment), useValue: mockAckRepo },
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(Tenant), useValue: mockTenantRepo },
      ],
    }).compile();

    service = module.get<AnnouncementService>(AnnouncementService);
    announcementRepository = module.get(getRepositoryToken(Announcement));
    acknowledgmentRepository = module.get(getRepositoryToken(AnnouncementAcknowledgment));
    userRepository = module.get(getRepositoryToken(User));
    tenantRepository = module.get(getRepositoryToken(Tenant));
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // ==========================================================================
  // Get Announcements
  // ==========================================================================

  describe('getAnnouncements', () => {
    it('should return all platform announcements for SuperAdmin', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const announcements = [
        createMockAnnouncement({ id: 'ann-1', scope: AnnouncementScope.PLATFORM }),
        createMockAnnouncement({ id: 'ann-2', scope: AnnouncementScope.PLATFORM }),
      ];

      userRepository.findOne.mockResolvedValue(superAdmin);
      (announcementRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue(
        announcements,
      );

      const result = await service.getAnnouncements(superAdmin.id);

      expect(result).toHaveLength(2);
    });

    it('should return published platform announcements for TenantAdmin', async () => {
      const tenantAdmin = createMockUser({ role: Role.TENANT_ADMIN, tenantId: 'tenant-1' });
      const announcements = [
        createMockAnnouncement({
          id: 'ann-1',
          scope: AnnouncementScope.PLATFORM,
          status: AnnouncementStatus.PUBLISHED,
        }),
      ];

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      (announcementRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue(
        announcements,
      );
      acknowledgmentRepository.find.mockResolvedValue([]);

      const result = await service.getAnnouncements(tenantAdmin.id);

      expect(result).toHaveLength(1);
    });

    it('should include acknowledgment status for TenantAdmin', async () => {
      const tenantAdmin = createMockUser({ role: Role.TENANT_ADMIN, tenantId: 'tenant-1' });
      const announcement = createMockAnnouncement({ id: 'ann-1' });
      const ack = createMockAcknowledgment({
        announcementId: 'ann-1',
        acknowledgedAt: new Date(),
        hasAcknowledged: () => true,
      });

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      (announcementRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue([
        announcement,
      ]);
      acknowledgmentRepository.find.mockResolvedValue([ack]);

      const result = await service.getAnnouncements(tenantAdmin.id);

      expect(result[0].hasViewed).toBe(true);
      expect(result[0].hasAcknowledged).toBe(true);
    });
  });

  describe('getAnnouncement', () => {
    it('should return platform announcement for SuperAdmin', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const announcement = createMockAnnouncement({ scope: AnnouncementScope.PLATFORM });

      userRepository.findOne.mockResolvedValue(superAdmin);
      announcementRepository.findOne.mockResolvedValue(announcement);

      const result = await service.getAnnouncement(superAdmin.id, announcement.id);

      expect(result).toEqual(announcement);
    });

    it('should throw ForbiddenException when TenantAdmin accesses other tenant announcement', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const announcement = createMockAnnouncement({
        scope: AnnouncementScope.TENANT,
        tenantId: 'tenant-2',
      });

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      announcementRepository.findOne.mockResolvedValue(announcement);

      await expect(
        service.getAnnouncement(tenantAdmin.id, announcement.id),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  // ==========================================================================
  // Create Announcements
  // ==========================================================================

  describe('createPlatformAnnouncement', () => {
    it('should allow SuperAdmin to create platform announcement', async () => {
      const superAdmin = createMockUser({
        role: Role.SUPER_ADMIN,
        tenantId: undefined,
        firstName: 'Super',
        lastName: 'Admin',
      });
      const input = {
        title: 'Platform Update',
        content: 'New features available',
        type: AnnouncementType.INFO,
        isGlobal: true,
        requiresAcknowledgment: false,
      };

      userRepository.findOne.mockResolvedValue(superAdmin);
      announcementRepository.save.mockResolvedValue(
        createMockAnnouncement({ ...input, scope: AnnouncementScope.PLATFORM }),
      );

      await service.createPlatformAnnouncement(superAdmin.id, input);

      expect(announcementRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: AnnouncementScope.PLATFORM,
          isGlobal: true,
          createdByName: 'Super Admin',
        }),
      );
    });

    it('should throw ForbiddenException for TenantAdmin', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });

      userRepository.findOne.mockResolvedValue(tenantAdmin);

      await expect(
        service.createPlatformAnnouncement(tenantAdmin.id, {
          title: 'Test',
          content: 'Content',
          type: AnnouncementType.INFO,
          isGlobal: true,
          requiresAcknowledgment: false,
        }),
      ).rejects.toThrow(ForbiddenException);
    });

    it('should set status to SCHEDULED when publishAt is provided', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const futureDate = new Date(Date.now() + 86400000).toISOString();

      userRepository.findOne.mockResolvedValue(superAdmin);
      announcementRepository.save.mockResolvedValue(
        createMockAnnouncement({ status: AnnouncementStatus.SCHEDULED }),
      );

      await service.createPlatformAnnouncement(superAdmin.id, {
        title: 'Future Announcement',
        content: 'Coming soon',
        type: AnnouncementType.INFO,
        isGlobal: true,
        requiresAcknowledgment: false,
        publishAt: futureDate,
      });

      expect(announcementRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: AnnouncementStatus.SCHEDULED,
          publishAt: expect.any(Date),
        }),
      );
    });
  });

  describe('createTenantAnnouncement', () => {
    it('should allow TenantAdmin to create tenant announcement', async () => {
      const tenantAdmin = createMockUser({
        tenantId: 'tenant-1',
        firstName: 'Tenant',
        lastName: 'Admin',
      });
      const input = {
        title: 'Team Update',
        content: 'Important team info',
        type: AnnouncementType.INFO,
        requiresAcknowledgment: true,
      };

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      announcementRepository.save.mockResolvedValue(
        createMockAnnouncement({ ...input, scope: AnnouncementScope.TENANT }),
      );

      await service.createTenantAnnouncement(tenantAdmin.id, input);

      expect(announcementRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: AnnouncementScope.TENANT,
          tenantId: 'tenant-1',
          createdByName: 'Tenant Admin',
        }),
      );
    });

    it('should throw BadRequestException when user has no tenant', async () => {
      const user = createMockUser({ tenantId: undefined });

      userRepository.findOne.mockResolvedValue(user);

      await expect(
        service.createTenantAnnouncement(user.id, {
          title: 'Test',
          content: 'Content',
          type: AnnouncementType.INFO,
          requiresAcknowledgment: false,
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ==========================================================================
  // Manage Announcements
  // ==========================================================================

  describe('publishAnnouncement', () => {
    it('should publish draft announcement', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const announcement = createMockAnnouncement({
        status: AnnouncementStatus.DRAFT,
        scope: AnnouncementScope.PLATFORM,
      });

      userRepository.findOne.mockResolvedValue(superAdmin);
      announcementRepository.findOne.mockResolvedValue(announcement);
      announcementRepository.save.mockImplementation((a) => Promise.resolve(a as Announcement));

      const result = await service.publishAnnouncement(superAdmin.id, announcement.id);

      expect(announcementRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: AnnouncementStatus.PUBLISHED,
          publishAt: expect.any(Date),
        }),
      );
    });

    it('should throw BadRequestException for already published announcement', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const announcement = createMockAnnouncement({
        status: AnnouncementStatus.PUBLISHED,
        scope: AnnouncementScope.PLATFORM,
      });

      userRepository.findOne.mockResolvedValue(superAdmin);
      announcementRepository.findOne.mockResolvedValue(announcement);

      await expect(
        service.publishAnnouncement(superAdmin.id, announcement.id),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('cancelAnnouncement', () => {
    it('should cancel announcement', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const announcement = createMockAnnouncement({
        status: AnnouncementStatus.PUBLISHED,
        scope: AnnouncementScope.PLATFORM,
      });

      userRepository.findOne.mockResolvedValue(superAdmin);
      announcementRepository.findOne.mockResolvedValue(announcement);
      announcementRepository.save.mockImplementation((a) => Promise.resolve(a as Announcement));

      await service.cancelAnnouncement(superAdmin.id, announcement.id);

      expect(announcementRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: AnnouncementStatus.CANCELLED,
        }),
      );
    });
  });

  describe('deleteAnnouncement', () => {
    it('should delete draft announcement', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const announcement = createMockAnnouncement({
        status: AnnouncementStatus.DRAFT,
        scope: AnnouncementScope.PLATFORM,
      });

      userRepository.findOne.mockResolvedValue(superAdmin);
      announcementRepository.findOne.mockResolvedValue(announcement);
      announcementRepository.remove.mockResolvedValue(announcement);

      const result = await service.deleteAnnouncement(superAdmin.id, announcement.id);

      expect(result).toBe(true);
      expect(announcementRepository.remove).toHaveBeenCalledWith(announcement);
    });

    it('should throw BadRequestException for non-draft announcement', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const announcement = createMockAnnouncement({
        status: AnnouncementStatus.PUBLISHED,
        scope: AnnouncementScope.PLATFORM,
      });

      userRepository.findOne.mockResolvedValue(superAdmin);
      announcementRepository.findOne.mockResolvedValue(announcement);

      await expect(
        service.deleteAnnouncement(superAdmin.id, announcement.id),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ==========================================================================
  // View & Acknowledge
  // ==========================================================================

  describe('viewAnnouncement', () => {
    it('should create view record and increment count', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const tenant = createMockTenant({ id: 'tenant-1' });
      const announcement = createMockAnnouncement();

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      announcementRepository.findOne.mockResolvedValue(announcement);
      acknowledgmentRepository.findOne.mockResolvedValue(null);
      tenantRepository.findOne.mockResolvedValue(tenant);
      acknowledgmentRepository.save.mockResolvedValue(createMockAcknowledgment());
      announcementRepository.increment.mockResolvedValue({ affected: 1 } as any);

      await service.viewAnnouncement(tenantAdmin.id, announcement.id);

      expect(acknowledgmentRepository.create).toHaveBeenCalled();
      expect(announcementRepository.increment).toHaveBeenCalledWith(
        { id: announcement.id },
        'viewCount',
        1,
      );
    });

    it('should return existing acknowledgment if already viewed', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const announcement = createMockAnnouncement();
      const existingAck = createMockAcknowledgment();

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      announcementRepository.findOne.mockResolvedValue(announcement);
      acknowledgmentRepository.findOne.mockResolvedValue(existingAck);

      const result = await service.viewAnnouncement(tenantAdmin.id, announcement.id);

      expect(result).toEqual(existingAck);
      expect(acknowledgmentRepository.save).not.toHaveBeenCalled();
    });
  });

  describe('acknowledgeAnnouncement', () => {
    it('should acknowledge announcement that requires acknowledgment', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const tenant = createMockTenant({ id: 'tenant-1' });
      const announcement = createMockAnnouncement({ requiresAcknowledgment: true });
      const ack = createMockAcknowledgment({ acknowledgedAt: null });

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      announcementRepository.findOne.mockResolvedValue(announcement);
      acknowledgmentRepository.findOne.mockResolvedValueOnce(null);
      tenantRepository.findOne.mockResolvedValue(tenant);
      acknowledgmentRepository.save.mockResolvedValue(ack);
      acknowledgmentRepository.findOne.mockResolvedValueOnce(ack);
      announcementRepository.increment.mockResolvedValue({ affected: 1 } as any);

      await service.acknowledgeAnnouncement(tenantAdmin.id, announcement.id);

      expect(acknowledgmentRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          acknowledgedAt: expect.any(Date),
        }),
      );
      expect(announcementRepository.increment).toHaveBeenCalledWith(
        { id: announcement.id },
        'acknowledgmentCount',
        1,
      );
    });

    it('should throw BadRequestException if acknowledgment not required', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const announcement = createMockAnnouncement({ requiresAcknowledgment: false });

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      announcementRepository.findOne.mockResolvedValue(announcement);

      await expect(
        service.acknowledgeAnnouncement(tenantAdmin.id, announcement.id),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ==========================================================================
  // Statistics
  // ==========================================================================

  describe('getStats', () => {
    it('should return platform statistics for SuperAdmin', async () => {
      const superAdmin = createMockUser({ role: Role.SUPER_ADMIN, tenantId: undefined });
      const announcements = [
        createMockAnnouncement({
          status: AnnouncementStatus.PUBLISHED,
          viewCount: 100,
          acknowledgmentCount: 50,
        }),
        createMockAnnouncement({ status: AnnouncementStatus.DRAFT }),
        createMockAnnouncement({ status: AnnouncementStatus.SCHEDULED }),
      ];

      userRepository.findOne.mockResolvedValue(superAdmin);
      (announcementRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue(
        announcements,
      );

      const stats = await service.getStats(superAdmin.id);

      expect(stats.total).toBe(3);
      expect(stats.published).toBe(1);
      expect(stats.draft).toBe(1);
      expect(stats.scheduled).toBe(1);
      expect(stats.totalViews).toBe(100);
      expect(stats.totalAcknowledgments).toBe(50);
    });
  });
});

// ============================================================================
// Integration Tests - Announcement Flow
// ============================================================================

describe('SuperAdmin-TenantAdmin Announcement Integration', () => {
  let service: AnnouncementService;
  let announcementRepository: any;
  let acknowledgmentRepository: any;
  let userRepository: any;
  let tenantRepository: any;

  beforeEach(async () => {
    const mockAnnouncementRepo = createMockRepository();
    const mockAckRepo = createMockRepository();
    const mockUserRepo = createMockRepository();
    const mockTenantRepo = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AnnouncementService,
        { provide: getRepositoryToken(Announcement), useValue: mockAnnouncementRepo },
        { provide: getRepositoryToken(AnnouncementAcknowledgment), useValue: mockAckRepo },
        { provide: getRepositoryToken(User), useValue: mockUserRepo },
        { provide: getRepositoryToken(Tenant), useValue: mockTenantRepo },
      ],
    }).compile();

    service = module.get<AnnouncementService>(AnnouncementService);
    announcementRepository = module.get(getRepositoryToken(Announcement));
    acknowledgmentRepository = module.get(getRepositoryToken(AnnouncementAcknowledgment));
    userRepository = module.get(getRepositoryToken(User));
    tenantRepository = module.get(getRepositoryToken(Tenant));
  });

  describe('Full Announcement Flow', () => {
    it('should complete announcement creation, publishing, and acknowledgment flow', async () => {
      const superAdmin = createMockUser({
        id: 'super-admin-1',
        role: Role.SUPER_ADMIN,
        tenantId: undefined,
        firstName: 'Platform',
        lastName: 'Admin',
      });
      const tenantAdmin = createMockUser({
        id: 'tenant-admin-1',
        role: Role.TENANT_ADMIN,
        tenantId: 'tenant-1',
        firstName: 'Tenant',
        lastName: 'Admin',
      });
      const tenant = createMockTenant({ id: 'tenant-1', name: 'Farm Co' });

      // Step 1: SuperAdmin creates a platform announcement
      userRepository.findOne.mockResolvedValueOnce(superAdmin);

      const draftAnnouncement = createMockAnnouncement({
        id: 'ann-1',
        status: AnnouncementStatus.DRAFT,
        scope: AnnouncementScope.PLATFORM,
        requiresAcknowledgment: true,
      });
      announcementRepository.save.mockResolvedValueOnce(draftAnnouncement);

      await service.createPlatformAnnouncement(superAdmin.id, {
        title: 'Security Update Required',
        content: 'All users must acknowledge this security update',
        type: AnnouncementType.CRITICAL,
        isGlobal: true,
        requiresAcknowledgment: true,
      });

      expect(announcementRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: AnnouncementScope.PLATFORM,
          requiresAcknowledgment: true,
          status: AnnouncementStatus.DRAFT,
        }),
      );

      // Step 2: SuperAdmin publishes the announcement
      userRepository.findOne.mockResolvedValueOnce(superAdmin);
      announcementRepository.findOne.mockResolvedValueOnce(draftAnnouncement);
      announcementRepository.save.mockImplementation((a) => Promise.resolve(a));

      await service.publishAnnouncement(superAdmin.id, draftAnnouncement.id);

      expect(announcementRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: AnnouncementStatus.PUBLISHED,
        }),
      );

      // Step 3: TenantAdmin views announcement (creates view record)
      const publishedAnnouncement = {
        ...draftAnnouncement,
        status: AnnouncementStatus.PUBLISHED,
      };

      userRepository.findOne.mockResolvedValueOnce(tenantAdmin);
      announcementRepository.findOne.mockResolvedValueOnce(publishedAnnouncement);
      acknowledgmentRepository.findOne.mockResolvedValueOnce(null);
      tenantRepository.findOne.mockResolvedValueOnce(tenant);

      const viewAck = createMockAcknowledgment({
        announcementId: 'ann-1',
        userId: 'tenant-admin-1',
        tenantId: 'tenant-1',
        tenantName: 'Farm Co',
      });
      acknowledgmentRepository.save.mockResolvedValueOnce(viewAck);
      announcementRepository.increment.mockResolvedValue({ affected: 1 });

      await service.viewAnnouncement(tenantAdmin.id, publishedAnnouncement.id);

      expect(acknowledgmentRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          announcementId: 'ann-1',
          userId: 'tenant-admin-1',
          tenantName: 'Farm Co',
        }),
      );
      expect(announcementRepository.increment).toHaveBeenCalledWith(
        { id: 'ann-1' },
        'viewCount',
        1,
      );

      // Step 4: TenantAdmin acknowledges announcement
      userRepository.findOne.mockResolvedValueOnce(tenantAdmin);
      announcementRepository.findOne.mockResolvedValueOnce(publishedAnnouncement);
      acknowledgmentRepository.findOne.mockResolvedValueOnce(viewAck);
      acknowledgmentRepository.save.mockImplementation((a) => Promise.resolve(a));
      announcementRepository.increment.mockResolvedValue({ affected: 1 });

      await service.acknowledgeAnnouncement(tenantAdmin.id, publishedAnnouncement.id);

      expect(announcementRepository.increment).toHaveBeenCalledWith(
        { id: 'ann-1' },
        'acknowledgmentCount',
        1,
      );
    });

    it('should allow TenantAdmin to create tenant-level announcement for their users', async () => {
      const tenantAdmin = createMockUser({
        tenantId: 'tenant-1',
        firstName: 'Tenant',
        lastName: 'Admin',
      });

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      announcementRepository.save.mockResolvedValue(
        createMockAnnouncement({
          scope: AnnouncementScope.TENANT,
          tenantId: 'tenant-1',
        }),
      );

      await service.createTenantAnnouncement(tenantAdmin.id, {
        title: 'Team Meeting',
        content: 'Weekly team meeting tomorrow at 10 AM',
        type: AnnouncementType.INFO,
        requiresAcknowledgment: false,
      });

      expect(announcementRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          scope: AnnouncementScope.TENANT,
          tenantId: 'tenant-1',
        }),
      );
    });

    it('should show correct acknowledgment status to TenantAdmin', async () => {
      const tenantAdmin = createMockUser({ tenantId: 'tenant-1' });
      const announcements = [
        createMockAnnouncement({
          id: 'ann-viewed',
          requiresAcknowledgment: true,
        }),
        createMockAnnouncement({
          id: 'ann-acknowledged',
          requiresAcknowledgment: true,
        }),
        createMockAnnouncement({
          id: 'ann-new',
          requiresAcknowledgment: true,
        }),
      ];
      const acks = [
        createMockAcknowledgment({
          announcementId: 'ann-viewed',
          acknowledgedAt: null,
          hasAcknowledged: () => false,
        }),
        createMockAcknowledgment({
          announcementId: 'ann-acknowledged',
          acknowledgedAt: new Date(),
          hasAcknowledged: () => true,
        }),
      ];

      userRepository.findOne.mockResolvedValue(tenantAdmin);
      (announcementRepository.createQueryBuilder().getMany as jest.Mock).mockResolvedValue(
        announcements,
      );
      acknowledgmentRepository.find.mockResolvedValue(acks);

      const result = await service.getAnnouncements(tenantAdmin.id);

      const viewedAnn = result.find((a) => a.id === 'ann-viewed');
      expect(viewedAnn?.hasViewed).toBe(true);
      expect(viewedAnn?.hasAcknowledged).toBe(false);

      const ackAnn = result.find((a) => a.id === 'ann-acknowledged');
      expect(ackAnn?.hasViewed).toBe(true);
      expect(ackAnn?.hasAcknowledged).toBe(true);

      const newAnn = result.find((a) => a.id === 'ann-new');
      expect(newAnn?.hasViewed).toBe(false);
      expect(newAnn?.hasAcknowledged).toBe(false);
    });
  });
});
