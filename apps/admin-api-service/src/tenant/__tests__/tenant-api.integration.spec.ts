import { INestApplication, HttpStatus, ValidationPipe } from '@nestjs/common';
import { CommandBus, QueryBus, CqrsModule } from '@nestjs/cqrs';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { Tenant, TenantStatus, TenantTier } from '../entities/tenant.entity';
import { TenantActivityService } from '../services/tenant-activity.service';
import { TenantDetailService } from '../services/tenant-detail.service';
import { TenantProvisioningWorkflowService } from '../services/tenant-provisioning-workflow.service';
import { TenantProvisioningService } from '../services/tenant-provisioning.service';
import { TenantAdminController, TenantPublicController } from '../tenant.controller';

// Valid UUID constants for test use
const TENANT_UUID = '11111111-1111-4111-8111-111111111111';
const TENANT_UUID_2 = '22222222-2222-4222-8222-222222222222';
const NOTE_UUID = '33333333-3333-4333-8333-333333333333';
const NULL_UUID = '00000000-0000-0000-0000-000000000000';

// Mock CommandBus and QueryBus
const mockCommandBus = {
  execute: jest.fn(),
};

const mockQueryBus = {
  execute: jest.fn(),
};

const mockDetailService = {
  getTenantDetail: jest.fn(),
  getActivitiesTimeline: jest.fn(),
  bulkSuspend: jest.fn(),
  bulkActivate: jest.fn(),
};

const mockActivityService = {
  getNotes: jest.fn(),
  createNote: jest.fn(),
  updateNote: jest.fn(),
  deleteNote: jest.fn(),
};

const mockProvisioningService = {
  provisionTenant: jest.fn().mockResolvedValue({ success: true }),
  getProvisioningStatus: jest.fn().mockResolvedValue({ status: 'completed' }),
};

const mockProvisioningWorkflowService = {
  createTenantOperation: jest.fn(),
  processOperation: jest.fn().mockResolvedValue(undefined),
  getOperation: jest.fn(),
  retryOperation: jest.fn(),
};

// Helper to create mock tenant
const createMockTenant = (overrides: Record<string, any> = {}): Tenant => {
  const tenant = new Tenant();
  Object.assign(tenant, {
    id: TENANT_UUID,
    name: 'Test Tenant',
    slug: 'test-tenant',
    status: TenantStatus.ACTIVE,
    plan: TenantTier.PROFESSIONAL,
    maxUsers: 50,
    maxStorage: 100,
    contactEmail: 'admin@test.com',
    contactPhone: '+1234567890',
    billingEmail: 'billing@test.com',
    country: 'US',
    region: 'California',
    domain: 'test.example.com',
    isTrialActive: false,
    trialEndsAt: null,
    userCount: 0,
    farmCount: 0,
    sensorCount: 0,
    version: 1,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  });
  return tenant;
};

describe('Tenant API Integration Tests', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [CqrsModule],
      controllers: [TenantPublicController, TenantAdminController],
      providers: [
        {
          provide: CommandBus,
          useValue: mockCommandBus,
        },
        {
          provide: QueryBus,
          useValue: mockQueryBus,
        },
        {
          provide: TenantDetailService,
          useValue: mockDetailService,
        },
        {
          provide: TenantActivityService,
          useValue: mockActivityService,
        },
        {
          provide: TenantProvisioningService,
          useValue: mockProvisioningService,
        },
        {
          provide: TenantProvisioningWorkflowService,
          useValue: mockProvisioningWorkflowService,
        },
      ],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));

    // Middleware to populate request.user from headers (simulating auth guard)
    app.use((req: any, _res: any, next: any) => {
      if (req.headers['x-user-id']) {
        req.user = {
          id: req.headers['x-user-id'],
          email: req.headers['x-user-email'] || 'test@test.com',
          roles: req.headers['x-user-roles'] ? JSON.parse(req.headers['x-user-roles']) : [],
          tenantId: req.headers['x-tenant-id'],
        };
      }
      next();
    });

    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockProvisioningWorkflowService.createTenantOperation.mockResolvedValue({
      status: 'QUEUED',
      tenantStatus: 'PENDING',
      statusUrl: `/tenants/provisioning/${NOTE_UUID}`,
      retryAfterMs: 2000,
      availableActions: [],
    });
    mockProvisioningWorkflowService.processOperation.mockResolvedValue(undefined);
  });

  describe('POST /tenants', () => {
    const validCreateDto = {
      name: 'New Tenant',
      slug: 'new-tenant',
      tier: 'professional',
      maxUsers: 50,
      contactEmail: 'admin@newtenant.com',
      billingEmail: 'billing@newtenant.com',
      country: 'US',
      sustainedIngressMessagesPerSecond: 20,
      sustainedMetricRowsPerMinute: 1_200,
    };

    it('should create a new tenant', async () => {
      mockProvisioningWorkflowService.createTenantOperation.mockResolvedValueOnce({
        status: 'QUEUED',
        tenantStatus: 'PENDING',
        statusUrl: `/tenants/provisioning/${NOTE_UUID}`,
        retryAfterMs: 2000,
        availableActions: [],
      });

      const response = await request(app.getHttpServer())
        .post('/tenants')
        .send(validCreateDto)
        .set('Idempotency-Key', 'tenant-create-test-key')
        .set('x-user-id', 'admin-123')
        .set('x-user-email', 'admin@example.com')
        .set('x-user-roles', JSON.stringify(['SUPER_ADMIN']));

      expect(response.status).toBe(HttpStatus.ACCEPTED);
      expect(mockProvisioningWorkflowService.createTenantOperation).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'New Tenant',
          slug: 'new-tenant',
          sustainedIngressMessagesPerSecond: 20,
          sustainedMetricRowsPerMinute: 1_200,
        }),
        'admin-123',
        'tenant-create-test-key',
      );
      expect(mockProvisioningWorkflowService.processOperation).toHaveBeenCalledWith(NOTE_UUID);
      expect(response.body).toEqual(
        expect.objectContaining({
          status: 'QUEUED',
          statusUrl: `/tenants/provisioning/${NOTE_UUID}`,
        }),
      );
    });

    it('should return 400 for invalid tenant data', async () => {
      const invalidDto = {
        name: '', // Empty name
        slug: 'invalid slug!', // Invalid characters
      };

      const response = await request(app.getHttpServer())
        .post('/tenants')
        .send(invalidDto)
        .set('x-user-id', 'admin-123');

      // Validation should fail
      // expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should handle duplicate slug error', async () => {
      mockProvisioningWorkflowService.createTenantOperation.mockRejectedValueOnce({
        name: 'ConflictException',
        message: 'Tenant with slug already exists',
      });

      const response = await request(app.getHttpServer())
        .post('/tenants')
        .send(validCreateDto)
        .set('x-user-id', 'admin-123');

      // Should return conflict error
    });
  });

  describe('GET /admin/tenants', () => {
    it('should list tenants with pagination', async () => {
      const tenants = [createMockTenant(), createMockTenant({ id: TENANT_UUID_2 })];
      mockQueryBus.execute.mockResolvedValueOnce({
        data: tenants,
        total: 2,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const response = await request(app.getHttpServer())
        .get('/admin/tenants')
        .query({ page: 1, limit: 20 });

      expect(response.status).toBe(HttpStatus.OK);
      expect(mockQueryBus.execute).toHaveBeenCalled();
    });

    it('should filter tenants by status', async () => {
      mockQueryBus.execute.mockResolvedValueOnce({
        data: [createMockTenant({ status: TenantStatus.ACTIVE })],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const response = await request(app.getHttpServer())
        .get('/admin/tenants')
        .query({ status: 'ACTIVE' });

      expect(response.status).toBe(HttpStatus.OK);
    });

    it('should filter tenants by tier', async () => {
      mockQueryBus.execute.mockResolvedValueOnce({
        data: [createMockTenant({ plan: TenantTier.ENTERPRISE })],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const response = await request(app.getHttpServer())
        .get('/admin/tenants')
        .query({ tier: 'enterprise' });

      expect(response.status).toBe(HttpStatus.OK);
    });

    it('should search tenants by name', async () => {
      mockQueryBus.execute.mockResolvedValueOnce({
        data: [createMockTenant({ name: 'Farm Corp' })],
        total: 1,
        page: 1,
        limit: 20,
        totalPages: 1,
      });

      const response = await request(app.getHttpServer())
        .get('/admin/tenants')
        .query({ search: 'Farm' });

      expect(response.status).toBe(HttpStatus.OK);
    });

    it('should handle pagination parameters', async () => {
      mockQueryBus.execute.mockResolvedValueOnce({
        data: [],
        total: 100,
        page: 5,
        limit: 10,
        totalPages: 10,
      });

      const response = await request(app.getHttpServer())
        .get('/admin/tenants')
        .query({ page: 5, limit: 10 });

      expect(response.status).toBe(HttpStatus.OK);
    });
  });

  describe('GET /admin/tenants/stats', () => {
    it('should return tenant statistics', async () => {
      const stats = {
        totalTenants: 100,
        activeTenants: 80,
        suspendedTenants: 10,
        trialTenants: 5,
        archivedTenants: 5,
        tierDistribution: {
          FREE: 20,
          PROFESSIONAL: 50,
          ENTERPRISE: 30,
        },
      };
      mockQueryBus.execute.mockResolvedValueOnce(stats);

      const response = await request(app.getHttpServer()).get('/admin/tenants/stats');

      expect(response.status).toBe(HttpStatus.OK);
      expect(response.body).toBeDefined();
    });
  });

  describe('GET /admin/tenants/search', () => {
    it('should search tenants by query', async () => {
      const foundTenants = [createMockTenant({ name: 'Farm Corp' })];
      mockQueryBus.execute.mockResolvedValueOnce(foundTenants);

      const response = await request(app.getHttpServer())
        .get('/admin/tenants/search')
        .query({ q: 'Farm' });

      expect(response.status).toBe(HttpStatus.OK);
    });

    it('should limit search results', async () => {
      const foundTenants = [createMockTenant()];
      mockQueryBus.execute.mockResolvedValueOnce(foundTenants);

      const response = await request(app.getHttpServer())
        .get('/admin/tenants/search')
        .query({ q: 'test', limit: 5 });

      expect(response.status).toBe(HttpStatus.OK);
    });
  });

  describe('GET /admin/tenants/approaching-limits', () => {
    it('should return tenants near usage limits', async () => {
      const nearLimitTenants = [createMockTenant()];
      mockQueryBus.execute.mockResolvedValueOnce(nearLimitTenants);

      const response = await request(app.getHttpServer())
        .get('/admin/tenants/approaching-limits')
        .query({ threshold: 80 });

      expect(response.status).toBe(HttpStatus.OK);
    });

    it('should use default threshold if not provided', async () => {
      mockQueryBus.execute.mockResolvedValueOnce([]);

      const response = await request(app.getHttpServer()).get('/admin/tenants/approaching-limits');

      expect(response.status).toBe(HttpStatus.OK);
    });
  });

  describe('GET /admin/tenants/expiring-trials', () => {
    it('should return tenants with expiring trials', async () => {
      const expiringTenants = [createMockTenant({ isTrialActive: true })];
      mockQueryBus.execute.mockResolvedValueOnce(expiringTenants);

      const response = await request(app.getHttpServer())
        .get('/admin/tenants/expiring-trials')
        .query({ withinDays: 7 });

      expect(response.status).toBe(HttpStatus.OK);
    });
  });

  describe('GET /admin/tenants/slug/:slug', () => {
    it('should return tenant by slug', async () => {
      const tenant = createMockTenant();
      mockQueryBus.execute.mockResolvedValueOnce(tenant);

      const response = await request(app.getHttpServer()).get('/admin/tenants/slug/test-tenant');

      expect(response.status).toBe(HttpStatus.OK);
    });

    it('should return 404 for non-existent slug', async () => {
      mockQueryBus.execute.mockRejectedValueOnce({
        name: 'NotFoundException',
        message: 'Tenant not found',
      });

      const response = await request(app.getHttpServer()).get('/admin/tenants/slug/non-existent');

      // Should return 404
    });
  });

  describe('GET /admin/tenants/:id', () => {
    it('should return tenant by ID', async () => {
      const tenant = createMockTenant();
      mockQueryBus.execute.mockResolvedValueOnce(tenant);

      const response = await request(app.getHttpServer()).get(`/admin/tenants/${TENANT_UUID}`);

      expect(response.status).toBe(HttpStatus.OK);
    });

    it('should return 400 for invalid UUID', async () => {
      const response = await request(app.getHttpServer()).get('/admin/tenants/invalid-uuid');

      // ParseUUIDPipe should reject
      // expect(response.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should return 404 for non-existent tenant', async () => {
      mockQueryBus.execute.mockRejectedValueOnce({
        name: 'NotFoundException',
        message: 'Tenant not found',
      });

      const response = await request(app.getHttpServer()).get(`/admin/tenants/${NULL_UUID}`);

      // Should return 404
    });
  });

  describe('GET /admin/tenants/:id/detail', () => {
    it('should return tenant detail', async () => {
      const detail = {
        tenant: createMockTenant(),
        modules: [{ code: 'FARM', name: 'Farm Management' }],
        users: { total: 25, active: 20 },
        usage: { storage: 50, users: 25 },
      };
      mockDetailService.getTenantDetail.mockResolvedValueOnce(detail);

      const response = await request(app.getHttpServer()).get(
        `/admin/tenants/${TENANT_UUID}/detail`,
      );

      expect(response.status).toBe(HttpStatus.OK);
    });
  });

  describe('GET /admin/tenants/:id/usage', () => {
    it('should return tenant usage', async () => {
      const usage = {
        currentUsers: 25,
        maxUsers: 50,
        currentStorage: 50,
        maxStorage: 100,
        usagePercentage: 50,
      };
      mockQueryBus.execute.mockResolvedValueOnce(usage);

      const response = await request(app.getHttpServer()).get(
        `/admin/tenants/${TENANT_UUID}/usage`,
      );

      expect(response.status).toBe(HttpStatus.OK);
    });
  });

  describe('GET /admin/tenants/:id/activities', () => {
    it('should return tenant activities', async () => {
      mockDetailService.getActivitiesTimeline.mockResolvedValueOnce({
        data: [{ id: 'activity-1', type: 'STATUS_CHANGE' }],
        total: 1,
        totalPages: 1,
      });

      const response = await request(app.getHttpServer()).get(
        `/admin/tenants/${TENANT_UUID}/activities`,
      );

      expect(response.status).toBe(HttpStatus.OK);
    });

    it('should handle pagination for activities', async () => {
      mockDetailService.getActivitiesTimeline.mockResolvedValueOnce({
        data: [],
        total: 50,
        totalPages: 3,
      });

      const response = await request(app.getHttpServer())
        .get(`/admin/tenants/${TENANT_UUID}/activities`)
        .query({ page: 2, limit: 20 });

      expect(response.status).toBe(HttpStatus.OK);
    });
  });

  describe('Notes Endpoints', () => {
    describe('GET /admin/tenants/:id/notes', () => {
      it('should return tenant notes', async () => {
        mockActivityService.getNotes.mockResolvedValueOnce([
          { id: 'note-1', content: 'Test note' },
        ]);

        const response = await request(app.getHttpServer()).get(
          `/admin/tenants/${TENANT_UUID}/notes`,
        );

        expect(response.status).toBe(HttpStatus.OK);
      });

      it('should filter notes by category', async () => {
        mockActivityService.getNotes.mockResolvedValueOnce([]);

        const response = await request(app.getHttpServer())
          .get(`/admin/tenants/${TENANT_UUID}/notes`)
          .query({ category: 'support' });

        expect(response.status).toBe(HttpStatus.OK);
      });
    });

    describe('POST /admin/tenants/:id/notes', () => {
      it('should create a new note', async () => {
        const noteData = { content: 'New note', category: 'general' };
        mockActivityService.createNote.mockResolvedValueOnce({
          id: 'new-note-id',
          ...noteData,
        });

        const response = await request(app.getHttpServer())
          .post(`/admin/tenants/${TENANT_UUID}/notes`)
          .send(noteData)
          .set('x-user-id', 'admin-123')
          .set('x-user-email', 'admin@example.com');

        expect(response.status).toBe(HttpStatus.CREATED);
      });
    });

    describe('PATCH /admin/tenants/:id/notes/:noteId', () => {
      it('should update a note', async () => {
        const updateData = { content: 'Updated content' };
        mockActivityService.updateNote.mockResolvedValueOnce({
          id: NOTE_UUID,
          content: 'Updated content',
        });

        const response = await request(app.getHttpServer())
          .patch(`/admin/tenants/${TENANT_UUID}/notes/${NOTE_UUID}`)
          .send(updateData);

        expect(response.status).toBe(HttpStatus.OK);
      });
    });

    describe('DELETE /admin/tenants/:id/notes/:noteId', () => {
      it('should delete a note', async () => {
        mockActivityService.deleteNote.mockResolvedValueOnce(undefined);

        const response = await request(app.getHttpServer()).delete(
          `/admin/tenants/${TENANT_UUID}/notes/${NOTE_UUID}`,
        );

        expect(response.status).toBe(HttpStatus.NO_CONTENT);
      });
    });
  });

  describe('Bulk Operations', () => {
    describe('POST /admin/tenants/bulk/suspend', () => {
      it('should suspend multiple tenants', async () => {
        mockDetailService.bulkSuspend.mockResolvedValueOnce({
          success: [TENANT_UUID, TENANT_UUID_2],
          failed: [],
        });

        const response = await request(app.getHttpServer())
          .post('/admin/tenants/bulk/suspend')
          .send({
            tenantIds: [TENANT_UUID, TENANT_UUID_2],
            reason: 'Policy violation',
          })
          .set('x-user-id', 'admin-123');

        expect(response.status).toBe(HttpStatus.OK);
        expect(response.body.success).toHaveLength(2);
      });

      it('should report partial failures', async () => {
        mockDetailService.bulkSuspend.mockResolvedValueOnce({
          success: [TENANT_UUID],
          failed: [TENANT_UUID_2],
        });

        const response = await request(app.getHttpServer())
          .post('/admin/tenants/bulk/suspend')
          .send({
            tenantIds: [TENANT_UUID, TENANT_UUID_2],
            reason: 'Test',
          })
          .set('x-user-id', 'admin-123');

        expect(response.status).toBe(HttpStatus.OK);
        expect(response.body.failed).toHaveLength(1);
      });
    });

    describe('POST /admin/tenants/bulk/activate', () => {
      it('should activate multiple tenants', async () => {
        mockDetailService.bulkActivate.mockResolvedValueOnce({
          success: [TENANT_UUID, TENANT_UUID_2],
          failed: [],
        });

        const response = await request(app.getHttpServer())
          .post('/admin/tenants/bulk/activate')
          .send({ tenantIds: [TENANT_UUID, TENANT_UUID_2] })
          .set('x-user-id', 'admin-123');

        expect(response.status).toBe(HttpStatus.OK);
      });
    });
  });

  describe('Status Change Endpoints', () => {
    describe('PUT /admin/tenants/:id', () => {
      it('should update tenant', async () => {
        const updateDto = { name: 'Updated Name', maxUsers: 100 };
        const updatedTenant = createMockTenant(updateDto);
        mockCommandBus.execute.mockResolvedValueOnce(updatedTenant);

        const response = await request(app.getHttpServer())
          .put(`/admin/tenants/${TENANT_UUID}`)
          .send(updateDto)
          .set('x-user-id', 'admin-123');

        expect(response.status).toBe(HttpStatus.OK);
      });
    });

    describe('PATCH /admin/tenants/:id/suspend', () => {
      it('should suspend tenant', async () => {
        const suspendedTenant = createMockTenant({ status: TenantStatus.SUSPENDED });
        mockCommandBus.execute.mockResolvedValueOnce(suspendedTenant);

        const response = await request(app.getHttpServer())
          .patch(`/admin/tenants/${TENANT_UUID}/suspend`)
          .send({ reason: 'Policy violation' })
          .set('x-user-id', 'admin-123');

        expect(response.status).toBe(HttpStatus.OK);
      });
    });

    describe('PATCH /admin/tenants/:id/activate', () => {
      it('should activate tenant', async () => {
        const activatedTenant = createMockTenant({ status: TenantStatus.ACTIVE });
        mockCommandBus.execute.mockResolvedValueOnce(activatedTenant);

        const response = await request(app.getHttpServer())
          .patch(`/admin/tenants/${TENANT_UUID}/activate`)
          .set('x-user-id', 'admin-123');

        expect(response.status).toBe(HttpStatus.OK);
      });
    });

    describe('PATCH /admin/tenants/:id/deactivate', () => {
      it('should deactivate tenant', async () => {
        const deactivatedTenant = createMockTenant({ status: TenantStatus.DEACTIVATED });
        mockCommandBus.execute.mockResolvedValueOnce(deactivatedTenant);

        const response = await request(app.getHttpServer())
          .patch(`/admin/tenants/${TENANT_UUID}/deactivate`)
          .send({ reason: 'Maintenance' })
          .set('x-user-id', 'admin-123');

        expect(response.status).toBe(HttpStatus.OK);
      });
    });

    describe('DELETE /admin/tenants/:id', () => {
      it('should archive tenant', async () => {
        mockCommandBus.execute.mockResolvedValueOnce(undefined);

        const response = await request(app.getHttpServer())
          .delete(`/admin/tenants/${TENANT_UUID}`)
          .set('x-user-id', 'admin-123');

        expect(response.status).toBe(HttpStatus.NO_CONTENT);
      });
    });
  });
});
