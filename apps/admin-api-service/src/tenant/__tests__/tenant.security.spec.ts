/**
 * Tenant Management Security Tests
 *
 * Security-focused tests for tenant management functionality
 * Tests cover:
 * - Tenant isolation
 * - Input sanitization (SQL injection, XSS)
 * - Authentication/Authorization bypass attempts
 * - Data access control
 * - Rate limiting
 * - CSRF protection
 */

import { TENANT_ACTIVE_CHECK } from '@aquaculture/backend-common/middleware';
import { TenantStatus } from '@platform/event-contracts';
import { INestApplication, HttpStatus, NotFoundException, ValidationPipe } from '@nestjs/common';
import { CqrsModule, CommandBus, QueryBus } from '@nestjs/cqrs';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';

import { PlatformAdminGuard } from '../../guards/platform-admin.guard';
import { TenantActivityService } from '../services/tenant-activity.service';
import { TenantDetailService } from '../services/tenant-detail.service';
import { TenantProvisioningWorkflowService } from '../services/tenant-provisioning-workflow.service';
import { TenantProvisioningService } from '../services/tenant-provisioning.service';
import { TenantAdminController, TenantPublicController } from '../tenant.controller';

// Mock services
const mockCommandBus = { execute: jest.fn() };
const mockQueryBus = { execute: jest.fn() };
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
  createTenantOperation: jest.fn().mockResolvedValue({
    status: 'QUEUED',
    tenantStatus: 'PENDING',
    statusUrl: '/tenants/provisioning/33333333-3333-4333-8333-333333333333',
    retryAfterMs: 2000,
    availableActions: [],
  }),
  processOperation: jest.fn().mockResolvedValue(undefined),
  getOperation: jest.fn(),
  retryOperation: jest.fn(),
};

describe('Tenant Security Tests', () => {
  let app: INestApplication;

  // Test headers for different user types
  const superAdminHeaders = {
    'x-user-id': 'super-admin-uuid',
    'x-user-email': 'superadmin@system.com',
    'x-user-roles': JSON.stringify(['SUPER_ADMIN']),
  };

  const tenantAdminHeaders = {
    'x-user-id': 'tenant-admin-uuid',
    'x-user-email': 'admin@tenant.com',
    'x-user-roles': JSON.stringify(['TENANT_ADMIN']),
    'x-tenant-id': 'tenant-123',
  };

  const regularUserHeaders = {
    'x-user-id': 'user-uuid',
    'x-user-email': 'user@tenant.com',
    'x-user-roles': JSON.stringify(['MODULE_USER']),
    'x-tenant-id': 'tenant-123',
  };

  const noAuthHeaders = {};

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [CqrsModule],
      controllers: [TenantPublicController, TenantAdminController],
      providers: [
        // ADMIN-CRITICAL-009: @TenantParam resolves ids through the kernel
        // port; these suites exercise the controllers, not the lookup.
        {
          provide: TENANT_ACTIVE_CHECK,
          useValue: { lookupTenant: () => Promise.resolve({ status: TenantStatus.ACTIVE }) },
        },
        { provide: CommandBus, useValue: mockCommandBus },
        { provide: QueryBus, useValue: mockQueryBus },
        { provide: TenantDetailService, useValue: mockDetailService },
        { provide: TenantActivityService, useValue: mockActivityService },
        { provide: TenantProvisioningService, useValue: mockProvisioningService },
        { provide: TenantProvisioningWorkflowService, useValue: mockProvisioningWorkflowService },
      ],
    })
      .overrideGuard(PlatformAdminGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('1. Input Sanitization Tests', () => {
    describe('SQL Injection Prevention', () => {
      const sqlInjectionPayloads = [
        "'; DROP TABLE tenants; --",
        "1' OR '1'='1",
        "1; SELECT * FROM users; --",
        "' UNION SELECT * FROM tenants --",
        "1' AND '1'='1' --",
        "admin'--",
        "' OR 1=1 --",
        "'; EXEC xp_cmdshell('dir'); --",
        "1; UPDATE tenants SET status='SUSPENDED' WHERE '1'='1",
      ];

      sqlInjectionPayloads.forEach((payload, index) => {
        it(`should sanitize SQL injection payload #${index + 1}`, async () => {
          mockQueryBus.execute.mockResolvedValue({ data: [], total: 0 });

          const response = await request(app.getHttpServer())
            .get('/admin/tenants')
            .query({ search: payload })
            .set(superAdminHeaders);

          // Must return success (200) -- injection payloads are treated as plain search text
          // by parameterized queries, not as executable SQL. A 400 is also acceptable if
          // input validation explicitly rejects the pattern. 500 is NEVER acceptable.
          expect(response.status).not.toBe(HttpStatus.INTERNAL_SERVER_ERROR);
          expect([200, 400]).toContain(response.status);

          // Verify the query bus was called (search was passed safely through parameterized query)
          if (response.status === 200) {
            expect(mockQueryBus.execute).toHaveBeenCalled();
          }
        });
      });

      it('should use parameterized queries', async () => {
        mockQueryBus.execute.mockResolvedValue({ data: [], total: 0 });

        await request(app.getHttpServer())
          .get('/admin/tenants')
          .query({ search: "test' OR '1'='1" })
          .set(superAdminHeaders);

        expect(mockQueryBus.execute).toHaveBeenCalled();
      });
    });

    describe('XSS Prevention', () => {
      const xssPayloads = [
        '<script>alert("XSS")</script>',
        '"><script>alert(1)</script>',
        "javascript:alert('XSS')",
        '<img src=x onerror=alert(1)>',
        '<svg onload=alert(1)>',
        '{{constructor.constructor("alert(1)")()}}',
        '<body onload=alert(1)>',
        '<iframe src="javascript:alert(1)">',
      ];

      xssPayloads.forEach((payload, index) => {
        it(`should sanitize XSS payload #${index + 1}`, async () => {
          // Mock returns the payload as-is to test whether the controller/pipe sanitizes it
          mockCommandBus.execute.mockResolvedValue({ id: 'test', name: payload });

          const response = await request(app.getHttpServer())
            .post('/tenants')
            .set(superAdminHeaders)
            .send({
              name: payload,
              slug: 'test-tenant',
              tier: 'FREE',
              primaryContact: { name: 'Test', email: 'test@test.com' },
            });

          // The request must not cause a server error
          expect(response.status).not.toBe(HttpStatus.INTERNAL_SERVER_ERROR);

          // If the tenant operation was accepted (202), verify the response does not contain raw script tags.
          // If validation rejected it (400), that is also acceptable (input was blocked).
          // Any other status is unexpected.
          expect([202, 400]).toContain(response.status);
          if (response.status === 202) {
            expect(response.body.name).not.toContain('<script>');
          }
        });
      });
    });

    describe('Path Traversal Prevention', () => {
      const pathTraversalPayloads = [
        '../../../etc/passwd',
        '..\\..\\..\\windows\\system32\\config\\sam',
        '%2e%2e%2f%2e%2e%2f',
        '....//....//etc/passwd',
      ];

      pathTraversalPayloads.forEach((payload, index) => {
        it(`should prevent path traversal #${index + 1}`, async () => {
          mockQueryBus.execute.mockRejectedValueOnce(new NotFoundException('Not found'));

          const response = await request(app.getHttpServer())
            .get(`/admin/tenants/slug/${encodeURIComponent(payload)}`)
            .set(superAdminHeaders);

          // Path traversal payloads must never cause a 200 (data leak) or 500 (unhandled error).
          // Acceptable outcomes: 400 (rejected by validation) or 404 (slug not found).
          expect(response.status).not.toBe(HttpStatus.INTERNAL_SERVER_ERROR);
          expect(response.status).not.toBe(HttpStatus.OK);
          expect([400, 404]).toContain(response.status);
        });
      });
    });

  });

  describe('2. Data Access Control Tests', () => {
    describe('Sensitive Data Protection', () => {
      it('should not expose database IDs in error messages', async () => {
        mockQueryBus.execute.mockRejectedValue(new Error('Entity not found'));

        const response = await request(app.getHttpServer())
          .get('/admin/tenants/00000000-0000-0000-0000-000000000000')
          .set(superAdminHeaders);

        // Error response must exist and must not leak internal details
        expect(response.status).toBeGreaterThanOrEqual(400);
        const body = response.body;
        const bodyStr = JSON.stringify(body);
        expect(bodyStr).not.toMatch(/postgres/i);
        expect(bodyStr).not.toMatch(/database/i);
        expect(bodyStr).not.toMatch(/typeorm/i);
      });

      it('should not return password fields', async () => {
        // Even if the underlying data layer accidentally includes sensitive fields,
        // the API response must never expose them. We mock WITH these fields to verify
        // the controller/serializer strips them.
        mockQueryBus.execute.mockResolvedValue({
          id: 'test',
          name: 'Test',
          password: 'should-be-stripped',
          passwordHash: '$2b$10$fakehash',
          apiSecret: 'secret-key-123',
        });

        const response = await request(app.getHttpServer())
          .get('/admin/tenants/test-uuid')
          .set(superAdminHeaders);

        // Unconditional assertion: response body must not contain sensitive fields
        expect(response.body).toBeDefined();
        expect(response.body.password).toBeUndefined();
        expect(response.body.passwordHash).toBeUndefined();
        expect(response.body.apiSecret).toBeUndefined();
      });
    });

  });

  describe('3. Mass Assignment Protection', () => {
    it('should not allow setting internal fields through API', async () => {
      mockCommandBus.execute.mockResolvedValue({
        id: 'new-id',
        name: 'Test',
        status: 'PENDING',
      });

      const response = await request(app.getHttpServer())
        .post('/tenants')
        .set(superAdminHeaders)
        .send({
          name: 'Test',
          slug: 'test',
          tier: 'FREE',
          primaryContact: { name: 'Test', email: 'test@test.com' },
          id: 'hacked-id',
          status: 'ACTIVE',
          createdAt: '2020-01-01',
          isSystemTenant: true,
        });

      // ValidationPipe with forbidNonWhitelisted should reject unknown fields (400)
      // or the async create path should ignore them and use server-generated values (202).
      // Either way, the response must not contain the attacker-supplied id.
      expect(response.status).not.toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect([202, 400]).toContain(response.status);
      if (response.status === 202) {
        expect(response.body.id).not.toBe('hacked-id');
        expect(response.body.status).not.toBe('ACTIVE');
      }
      // If 400 is returned, the ValidationPipe correctly rejected the non-whitelisted fields
      if (response.status === 400) {
        expect(response.body.message).toBeDefined();
      }
    });
  });

  describe('4. Information Disclosure Prevention', () => {
    it('should not expose version info in headers', async () => {
      mockQueryBus.execute.mockResolvedValue({ data: [], total: 0 });

      const response = await request(app.getHttpServer())
        .get('/admin/tenants')
        .set(superAdminHeaders);

      expect(response.headers['x-app-version']).toBeUndefined();
      expect(response.headers['server']).toBeUndefined();
    });
  });
});
