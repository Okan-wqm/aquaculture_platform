/**
 * ImpersonationController Security Tests
 *
 * Enterprise-grade tests for the impersonation system's security controls.
 * Validates Sprint 4 security fixes:
 *   H26 - Session ownership verification on end/terminate
 *   C6  - JWT-based identity (no client-supplied headers)
 *   H8  - Per-route throttle on sensitive endpoints
 *
 * Uses NestJS TestingModule with mocked ImpersonationService.
 * No real database connection required.
 */

import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import {
  IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION,
  impersonationAuthorizationOperationSetDigestV1,
} from '@aquaculture/shared-contracts';

import { PlatformAdminGuard } from '../../../guards/platform-admin.guard';
import { ImpersonationController } from '../impersonation.controller';
import { ImpersonationService } from '../../services/impersonation.service';
import {
  ImpersonationReason,
  ImpersonationStatus,
} from '../../entities/impersonation-session.entity';

const AUTHENTICATED_ADMIN_ID = '11111111-1111-4111-8111-111111111111';
const TARGET_ADMIN_ID = '22222222-2222-4222-8222-222222222222';
const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const TARGET_TENANT_ID = '44444444-4444-4444-8444-444444444444';
const VALID_TOKEN = 'a'.repeat(64);
const EMPTY_SESSION_PAGE = Object.freeze({
  items: Object.freeze([]),
  total: 0,
  page: 1,
  limit: 50,
  totalPages: 1,
  hasNextPage: false,
  hasPreviousPage: false,
});

// ============================================================================
// Mock Definitions
// ============================================================================

const mockImpersonationService = {
  queryPermissions: jest.fn().mockResolvedValue({ data: [], total: 0 }),
  getImpersonationStats: jest.fn().mockResolvedValue({ totalSessions: 0 }),
  grantImpersonationPermission: jest.fn().mockResolvedValue({ id: 'perm-1' }),
  getImpersonationPermission: jest.fn().mockResolvedValue({ id: 'perm-1' }),
  revokeImpersonationPermission: jest.fn().mockResolvedValue(undefined),
  canImpersonate: jest.fn().mockResolvedValue({ allowed: true }),
  startImpersonation: jest.fn().mockResolvedValue({
    id: 'session-1',
    token: 'imp-token-xyz',
    status: ImpersonationStatus.ACTIVE,
  }),
  endImpersonation: jest.fn().mockResolvedValue({
    id: 'session-1',
    status: ImpersonationStatus.ENDED,
  }),
  terminateSession: jest.fn().mockResolvedValue({
    id: 'session-1',
    status: ImpersonationStatus.TERMINATED,
  }),
  extendSession: jest.fn().mockResolvedValue({
    id: 'session-1',
    status: ImpersonationStatus.ACTIVE,
    expiresAt: new Date(Date.now() + 3600000),
  }),
  resolveAuthorizationContext: jest.fn(),
  authorizeOperations: jest.fn(),
  getActiveSessions: jest.fn().mockResolvedValue([]),
  getActiveSessionCount: jest.fn().mockReturnValue(0),
  getSession: jest.fn().mockResolvedValue({ id: 'session-1' }),
  querySessions: jest.fn().mockResolvedValue(EMPTY_SESSION_PAGE),
  getAuditSummary: jest.fn().mockResolvedValue({ totalSessions: 0 }),
};

// ============================================================================
// Test Suite
// ============================================================================

describe('ImpersonationController', () => {
  let app: INestApplication;

  // Simulated authenticated user injected by the guard mock
  const authenticatedUser = {
    id: AUTHENTICATED_ADMIN_ID,
    email: 'admin@platform.com',
    roles: ['SUPER_ADMIN'],
    mfaVerified: true,
  };

  // Guard mock: always allow, inject req.user
  const mockGuard = {
    canActivate: jest.fn().mockImplementation((context) => {
      const req = context.switchToHttp().getRequest();
      req.user = { ...authenticatedUser };
      req.headers['user-agent'] ??= 'impersonation-controller-test/1.0';
      const effectiveTenantId = req.body?.effectiveTenantId ?? TARGET_TENANT_ID;
      req.verifiedIdentity = {
        serviceName: 'gateway-api',
        audience: 'admin-api-service',
        tenantId: effectiveTenantId,
        effectiveTenantId,
      };
      req.verifiedUserAssertion = {
        issuer: 'gateway-api',
        subject: authenticatedUser.id,
        tenantId: null,
        effectiveTenantId: null,
        mfaVerified: true,
        clientIp: '203.0.113.10',
        clientUserAgent: 'impersonation-controller-test/1.0',
      };
      return true;
    }),
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ImpersonationController],
      providers: [{ provide: ImpersonationService, useValue: mockImpersonationService }],
    })
      .overrideGuard(PlatformAdminGuard)
      .useValue(mockGuard)
      .compile();

    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Restore default guard behavior
    mockGuard.canActivate.mockImplementation((context) => {
      const req = context.switchToHttp().getRequest();
      req.user = { ...authenticatedUser };
      req.headers['user-agent'] ??= 'impersonation-controller-test/1.0';
      const effectiveTenantId = req.body?.effectiveTenantId ?? TARGET_TENANT_ID;
      req.verifiedIdentity = {
        serviceName: 'gateway-api',
        audience: 'admin-api-service',
        tenantId: effectiveTenantId,
        effectiveTenantId,
      };
      req.verifiedUserAssertion = {
        issuer: 'gateway-api',
        subject: authenticatedUser.id,
        tenantId: null,
        effectiveTenantId: null,
        mfaVerified: true,
        clientIp: '203.0.113.10',
        clientUserAgent: 'impersonation-controller-test/1.0',
      };
      return true;
    });
  });

  // ==========================================================================
  // 1. Guard Application Tests
  // ==========================================================================

  describe('PlatformAdminGuard enforcement', () => {
    it('should invoke PlatformAdminGuard on every request', async () => {
      await request(app.getHttpServer()).get('/impersonation/stats');

      expect(mockGuard.canActivate).toHaveBeenCalled();
    });

    it('should reject request when guard returns false', async () => {
      mockGuard.canActivate.mockReturnValueOnce(false);

      const res = await request(app.getHttpServer()).get('/impersonation/stats');

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });

    it('should reject request when guard throws UnauthorizedException', async () => {
      const { UnauthorizedException } = require('@nestjs/common');
      mockGuard.canActivate.mockImplementationOnce(() => {
        throw new UnauthorizedException('No authorization header provided');
      });

      const res = await request(app.getHttpServer()).get('/impersonation/stats');

      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('should reject request when guard throws ForbiddenException', async () => {
      const { ForbiddenException } = require('@nestjs/common');
      mockGuard.canActivate.mockImplementationOnce(() => {
        throw new ForbiddenException('Access denied');
      });

      const res = await request(app.getHttpServer()).get('/impersonation/permissions');

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });
  });

  // ==========================================================================
  // 2. startImpersonation -- JWT identity & validation
  // ==========================================================================

  describe('POST /impersonation/sessions/start', () => {
    // Use proper UUID v4 format (13th char = 4, 17th char = 8/9/a/b)
    const VALID_TENANT_UUID = 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5';
    const VALID_USER_UUID = 'b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6';

    const validDto = {
      targetTenantId: VALID_TENANT_UUID,
      reason: ImpersonationReason.SUPPORT_REQUEST,
    };

    it('should use JWT user.id as superAdminId, not client-supplied header', async () => {
      await request(app.getHttpServer())
        .post('/impersonation/sessions/start')
        .set('x-admin-id', 'attacker-injected-id') // header injection attempt
        .send(validDto);

      expect(mockImpersonationService.startImpersonation).toHaveBeenCalledWith(
        expect.objectContaining({
          superAdminId: authenticatedUser.id,
          superAdminEmail: authenticatedUser.email,
        }),
      );
    });

    it('should use JWT user.email as superAdminEmail', async () => {
      await request(app.getHttpServer()).post('/impersonation/sessions/start').send(validDto);

      expect(mockImpersonationService.startImpersonation).toHaveBeenCalledWith(
        expect.objectContaining({
          superAdminEmail: authenticatedUser.email,
        }),
      );
    });

    it('should return 401 Unauthorized if user is not authenticated (no user on req)', async () => {
      mockGuard.canActivate.mockImplementationOnce((context) => {
        // Guard passes but does not set req.user
        return true;
      });

      const res = await request(app.getHttpServer())
        .post('/impersonation/sessions/start')
        .send(validDto);

      // Controller should throw UnauthorizedException (not generic Error)
      // when req.user is missing -- MEDIUM-005 fix
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('should reject start when the authenticated assertion has not completed MFA', async () => {
      mockGuard.canActivate.mockImplementationOnce((context) => {
        const req = context.switchToHttp().getRequest();
        req.user = { ...authenticatedUser, mfaVerified: false };
        req.headers['user-agent'] = 'impersonation-controller-test/1.0';
        return true;
      });

      const res = await request(app.getHttpServer())
        .post('/impersonation/sessions/start')
        .send(validDto);

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
      expect(mockImpersonationService.startImpersonation).not.toHaveBeenCalled();
    });

    it('should reject client-supplied signed identity and network fields', async () => {
      const res = await request(app.getHttpServer())
        .post('/impersonation/sessions/start')
        .send({
          ...validDto,
          superAdminId: TARGET_ADMIN_ID,
          ipAddress: '203.0.113.10',
          mfaVerified: true,
        });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(mockImpersonationService.startImpersonation).not.toHaveBeenCalled();
    });

    it('uses the signed gateway user-agent instead of an unsigned request header', async () => {
      await request(app.getHttpServer())
        .post('/impersonation/sessions/start')
        .set('User-Agent', 'TestAgent/1.0')
        .send(validDto);

      expect(mockImpersonationService.startImpersonation).toHaveBeenCalledWith(
        expect.objectContaining({
          userAgent: 'impersonation-controller-test/1.0',
        }),
      );
    });

    it('should reject request with missing targetTenantId', async () => {
      const res = await request(app.getHttpServer())
        .post('/impersonation/sessions/start')
        .send({ reason: ImpersonationReason.DEBUGGING });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject request with invalid targetTenantId (not UUID)', async () => {
      const res = await request(app.getHttpServer()).post('/impersonation/sessions/start').send({
        targetTenantId: 'not-a-uuid',
        reason: ImpersonationReason.DEBUGGING,
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject request with missing reason', async () => {
      const res = await request(app.getHttpServer()).post('/impersonation/sessions/start').send({
        targetTenantId: VALID_TENANT_UUID,
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject request with invalid reason enum value', async () => {
      const res = await request(app.getHttpServer()).post('/impersonation/sessions/start').send({
        targetTenantId: VALID_TENANT_UUID,
        reason: 'invalid_reason',
      });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject durationMinutes exceeding max (480)', async () => {
      const res = await request(app.getHttpServer())
        .post('/impersonation/sessions/start')
        .send({
          ...validDto,
          durationMinutes: 481,
        });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject durationMinutes below min (1)', async () => {
      const res = await request(app.getHttpServer())
        .post('/impersonation/sessions/start')
        .send({
          ...validDto,
          durationMinutes: 0,
        });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should accept valid optional fields', async () => {
      await request(app.getHttpServer())
        .post('/impersonation/sessions/start')
        .send({
          ...validDto,
          targetTenantName: 'Test Tenant',
          targetUserId: VALID_USER_UUID,
          targetUserEmail: 'user@tenant.com',
          reasonDetails: 'Investigating billing issue',
          ticketReference: 'TICKET-123',
          durationMinutes: 60,
        });

      // Should call service (status depends on service response)
      expect(mockImpersonationService.startImpersonation).toHaveBeenCalled();
    });

    it('should reject reasonDetails exceeding maxLength (1000)', async () => {
      const res = await request(app.getHttpServer())
        .post('/impersonation/sessions/start')
        .send({
          ...validDto,
          reasonDetails: 'x'.repeat(1001),
        });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject ticketReference exceeding maxLength (100)', async () => {
      const res = await request(app.getHttpServer())
        .post('/impersonation/sessions/start')
        .send({
          ...validDto,
          ticketReference: 'T'.repeat(101),
        });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  // ==========================================================================
  // 3. endImpersonation -- Session ownership check (H26 fix)
  // ==========================================================================

  describe('POST /impersonation/sessions/:id/end', () => {
    it('should pass JWT user.id to service for ownership verification', async () => {
      await request(app.getHttpServer())
        .post(`/impersonation/sessions/${SESSION_ID}/end`)
        .send({ reason: 'Work completed' });

      expect(mockImpersonationService.endImpersonation).toHaveBeenCalledWith(
        SESSION_ID,
        'Work completed',
        authenticatedUser.id,
      );
    });

    it('should not allow client to override admin identity via headers', async () => {
      await request(app.getHttpServer())
        .post(`/impersonation/sessions/${SESSION_ID}/end`)
        .set('x-admin-id', 'attacker-injected')
        .send({ reason: 'Done' });

      // Service must receive JWT user.id, not header value
      expect(mockImpersonationService.endImpersonation).toHaveBeenCalledWith(
        SESSION_ID,
        'Done',
        authenticatedUser.id,
      );
    });

    it('should return 401 Unauthorized when user is not authenticated', async () => {
      mockGuard.canActivate.mockImplementationOnce((context) => {
        // No user set on request
        return true;
      });

      const res = await request(app.getHttpServer())
        .post(`/impersonation/sessions/${SESSION_ID}/end`)
        .send({});

      // Controller should throw UnauthorizedException (not generic Error)
      // when req.user is missing -- MEDIUM-005 fix
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('should work without a reason body', async () => {
      await request(app.getHttpServer()).post(`/impersonation/sessions/${SESSION_ID}/end`).send({});

      expect(mockImpersonationService.endImpersonation).toHaveBeenCalledWith(
        SESSION_ID,
        undefined,
        authenticatedUser.id,
      );
    });
  });

  // ==========================================================================
  // 4. terminateSession -- Only session owner can terminate
  // ==========================================================================

  describe('POST /impersonation/sessions/:id/terminate', () => {
    it('should pass JWT user.id to terminateSession for ownership check', async () => {
      await request(app.getHttpServer())
        .post(`/impersonation/sessions/${SESSION_ID}/terminate`)
        .send({ reason: 'Security incident' });

      expect(mockImpersonationService.terminateSession).toHaveBeenCalledWith(
        SESSION_ID,
        authenticatedUser.id,
        'Security incident',
      );
    });

    it('should not allow client-injected admin ID', async () => {
      await request(app.getHttpServer())
        .post(`/impersonation/sessions/${SESSION_ID}/terminate`)
        .set('x-admin-id', 'evil-admin')
        .send({ reason: 'Forced termination' });

      expect(mockImpersonationService.terminateSession).toHaveBeenCalledWith(
        SESSION_ID,
        authenticatedUser.id, // JWT identity, NOT 'evil-admin'
        'Forced termination',
      );
    });

    it('should return 401 Unauthorized when user has no ID on request', async () => {
      mockGuard.canActivate.mockImplementationOnce((context) => {
        return true;
      });

      const res = await request(app.getHttpServer())
        .post(`/impersonation/sessions/${SESSION_ID}/terminate`)
        .send({ reason: 'Something' });

      // Controller should throw UnauthorizedException (not generic Error)
      // when req.user is missing -- MEDIUM-005 fix
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  // ==========================================================================
  // 5. grantPermission -- JWT identity for grantedBy
  // ==========================================================================

  describe('POST /impersonation/permissions', () => {
    const VALID_ADMIN_UUID = 'c3d4e5f6-a7b8-4c9d-ae0f-1a2b3c4d5e6f';
    const validPermissionDto = {
      superAdminId: VALID_ADMIN_UUID,
    };

    it('should use JWT user.id as grantedBy, not client value', async () => {
      await request(app.getHttpServer())
        .post('/impersonation/permissions')
        .send(validPermissionDto);

      expect(mockImpersonationService.grantImpersonationPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          grantedBy: authenticatedUser.id,
        }),
      );
    });

    it('should reject invalid superAdminId (not UUID)', async () => {
      const res = await request(app.getHttpServer())
        .post('/impersonation/permissions')
        .send({ superAdminId: 'not-a-uuid' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject maxSessionDurationMinutes exceeding 1440', async () => {
      const res = await request(app.getHttpServer())
        .post('/impersonation/permissions')
        .send({
          ...validPermissionDto,
          maxSessionDurationMinutes: 1441,
        });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject maxConcurrentSessions exceeding 10', async () => {
      const res = await request(app.getHttpServer())
        .post('/impersonation/permissions')
        .send({
          ...validPermissionDto,
          maxConcurrentSessions: 11,
        });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should return 401 Unauthorized when user is not authenticated', async () => {
      mockGuard.canActivate.mockImplementationOnce(() => true);

      const res = await request(app.getHttpServer())
        .post('/impersonation/permissions')
        .send(validPermissionDto);

      // Controller should throw UnauthorizedException (not generic Error)
      // when req.user is missing -- MEDIUM-005 fix
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  // ==========================================================================
  // 6. Rate limiting metadata verification (@ThrottleSensitive)
  // ==========================================================================

  describe('ThrottleSensitive decorator metadata', () => {
    it('should have THROTTLE_CONFIG metadata on startImpersonation method', () => {
      const metadata = Reflect.getMetadata(
        'THROTTLE_CONFIG',
        ImpersonationController.prototype.startImpersonation,
      );
      expect(metadata).toBeDefined();
      expect(metadata.limit).toBe(3);
      expect(metadata.ttl).toBe(300);
    });

    it('should have THROTTLE_CONFIG metadata on endImpersonation method', () => {
      const metadata = Reflect.getMetadata(
        'THROTTLE_CONFIG',
        ImpersonationController.prototype.endImpersonation,
      );
      expect(metadata).toBeDefined();
      expect(metadata.limit).toBe(3);
      expect(metadata.ttl).toBe(300);
    });

    it('should have THROTTLE_CONFIG metadata on terminateSession method', () => {
      const metadata = Reflect.getMetadata(
        'THROTTLE_CONFIG',
        ImpersonationController.prototype.terminateSession,
      );
      expect(metadata).toBeDefined();
      expect(metadata.limit).toBe(3);
      expect(metadata.ttl).toBe(300);
    });
  });

  // ==========================================================================
  // 7. UseGuards decorator verification at class level
  // ==========================================================================

  describe('Class-level @UseGuards(PlatformAdminGuard)', () => {
    it('should have guards metadata on ImpersonationController class', () => {
      const guards = Reflect.getMetadata('__guards__', ImpersonationController);
      expect(guards).toBeDefined();
      expect(guards.length).toBeGreaterThan(0);
      expect(guards).toContain(PlatformAdminGuard);
    });
  });

  // ==========================================================================
  // 8. Input validation -- DTO validation rules
  // ==========================================================================

  describe('DTO input validation', () => {
    describe('QueryPermissionsDto', () => {
      it('should accept valid query parameters', async () => {
        mockImpersonationService.queryPermissions.mockResolvedValueOnce({ data: [], total: 0 });

        const res = await request(app.getHttpServer()).get('/impersonation/permissions').query({
          tenantId: 'd4e5f6a7-b8c9-4d0e-af1a-2b3c4d5e6f7a',
          isActive: 'true',
          page: 1,
          limit: 10,
        });

        expect(res.status).toBe(HttpStatus.OK);
      });
    });

    describe('QuerySessionsDto', () => {
      it('should accept valid session query params', async () => {
        mockImpersonationService.querySessions.mockResolvedValueOnce(EMPTY_SESSION_PAGE);

        const res = await request(app.getHttpServer()).get('/impersonation/sessions').query({
          status: ImpersonationStatus.ACTIVE,
          reason: ImpersonationReason.DEBUGGING,
          search: 'Ocean',
          page: 1,
          limit: 50,
        });

        expect(res.status).toBe(HttpStatus.OK);
        expect(mockImpersonationService.querySessions).toHaveBeenCalledWith(
          expect.objectContaining({
            status: ImpersonationStatus.ACTIVE,
            reason: ImpersonationReason.DEBUGGING,
            search: 'Ocean',
            page: 1,
            limit: 50,
          }),
        );
      });
    });
  });

  // ==========================================================================
  // 9. Error handling -- service exceptions propagation
  // ==========================================================================

  describe('Error handling', () => {
    it('should propagate NotFoundException from service', async () => {
      const { NotFoundException } = require('@nestjs/common');
      mockImpersonationService.getSession.mockRejectedValueOnce(
        new NotFoundException('Session not found'),
      );

      const res = await request(app.getHttpServer()).get(`/impersonation/sessions/${SESSION_ID}`);

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('should propagate ForbiddenException from service on end', async () => {
      const { ForbiddenException } = require('@nestjs/common');
      mockImpersonationService.endImpersonation.mockRejectedValueOnce(
        new ForbiddenException('You are not the session owner'),
      );

      const res = await request(app.getHttpServer())
        .post(`/impersonation/sessions/${SESSION_ID}/end`)
        .send({ reason: 'Attempt unauthorized end' });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });

    it('should propagate ForbiddenException from service on terminate', async () => {
      const { ForbiddenException } = require('@nestjs/common');
      mockImpersonationService.terminateSession.mockRejectedValueOnce(
        new ForbiddenException('Not authorized to terminate this session'),
      );

      const res = await request(app.getHttpServer())
        .post(`/impersonation/sessions/${SESSION_ID}/terminate`)
        .send({ reason: 'Forced' });

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });
  });

  // ==========================================================================
  // 10. extendSession -- JWT identity & validation (previously missing)
  // ==========================================================================

  describe('POST /impersonation/sessions/:id/extend', () => {
    it('should pass JWT user.id to extendSession for ownership check', async () => {
      mockImpersonationService.extendSession.mockResolvedValueOnce({
        id: SESSION_ID,
        status: ImpersonationStatus.ACTIVE,
        expiresAt: new Date(Date.now() + 7200000),
      });

      await request(app.getHttpServer())
        .post(`/impersonation/sessions/${SESSION_ID}/extend`)
        .send({ additionalMinutes: 30 });

      expect(mockImpersonationService.extendSession).toHaveBeenCalledWith(
        SESSION_ID,
        30,
        authenticatedUser.id,
      );
    });

    it('should not allow client-injected admin ID on extend', async () => {
      mockImpersonationService.extendSession.mockResolvedValueOnce({
        id: SESSION_ID,
        status: ImpersonationStatus.ACTIVE,
      });

      await request(app.getHttpServer())
        .post(`/impersonation/sessions/${SESSION_ID}/extend`)
        .set('x-admin-id', 'evil-admin')
        .send({ additionalMinutes: 60 });

      expect(mockImpersonationService.extendSession).toHaveBeenCalledWith(
        SESSION_ID,
        60,
        authenticatedUser.id, // JWT identity, NOT 'evil-admin'
      );
    });

    it('should return 401 Unauthorized when user is not authenticated on extend', async () => {
      mockGuard.canActivate.mockImplementationOnce(() => true);

      const res = await request(app.getHttpServer())
        .post(`/impersonation/sessions/${SESSION_ID}/extend`)
        .send({ additionalMinutes: 30 });

      // Controller should throw UnauthorizedException when req.user is missing
      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('should reject additionalMinutes below minimum (5)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/impersonation/sessions/${SESSION_ID}/extend`)
        .send({ additionalMinutes: 3 });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject additionalMinutes above maximum (120)', async () => {
      const res = await request(app.getHttpServer())
        .post(`/impersonation/sessions/${SESSION_ID}/extend`)
        .send({ additionalMinutes: 121 });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject request with missing additionalMinutes', async () => {
      const res = await request(app.getHttpServer())
        .post(`/impersonation/sessions/${SESSION_ID}/extend`)
        .send({});

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should have THROTTLE_CONFIG metadata on extendSession method', () => {
      const metadata = Reflect.getMetadata(
        'THROTTLE_CONFIG',
        ImpersonationController.prototype.extendSession,
      );
      expect(metadata).toBeDefined();
      expect(metadata.limit).toBe(3);
      expect(metadata.ttl).toBe(300);
    });
  });

  // ==========================================================================
  // 11. gateway-only exact authorization protocol
  // ==========================================================================

  describe('gateway-only authorization endpoints', () => {
    const coordinate = {
      schemaVersion: IMPERSONATION_AUTHORIZATION_RECEIPT_VERSION,
      authorizationReceiptId: '55555555-5555-4555-8555-555555555555',
      sessionId: SESSION_ID,
      effectiveTenantId: TARGET_TENANT_ID,
      method: 'POST',
      normalizedPath: '/graphql',
      normalizedQueryHash: 'b'.repeat(64),
      bodyHash: 'c'.repeat(64),
      requestDigest: 'd'.repeat(64),
    } as const;
    const context = {
      sessionId: SESSION_ID,
      superAdminId: AUTHENTICATED_ADMIN_ID,
      targetTenantId: TARGET_TENANT_ID,
      permissions: {
        canViewData: true,
        canModifyData: false,
        canAccessSettings: false,
        canManageUsers: false,
        canViewBilling: false,
        canExportData: false,
      },
      expiresAt: new Date(Date.now() + 60_000),
      isActive: true,
    };
    const operations = [
      { authority: 'data.read', module: 'farm', operation: 'Query.farms' },
    ] as const;

    it('resolves read-only context from signed gateway identity without client-authored actor fields', async () => {
      mockImpersonationService.resolveAuthorizationContext.mockResolvedValueOnce(context);

      const res = await request(app.getHttpServer())
        .post('/impersonation/sessions/authorization-context')
        .set('x-impersonation-token', VALID_TOKEN)
        .send(coordinate);

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.context.sessionId).toBe(SESSION_ID);
      expect(mockImpersonationService.resolveAuthorizationContext).toHaveBeenCalledWith(
        expect.objectContaining({
          credential: VALID_TOKEN,
          actorId: AUTHENTICATED_ADMIN_ID,
          effectiveTenantId: TARGET_TENANT_ID,
          clientIp: '203.0.113.10',
          clientUserAgent: 'impersonation-controller-test/1.0',
        }),
      );
    });

    it('commits only a canonical exact operation set', async () => {
      const operationSetDigest = impersonationAuthorizationOperationSetDigestV1(operations);
      mockImpersonationService.authorizeOperations.mockResolvedValueOnce({
        authorizationReceiptId: coordinate.authorizationReceiptId,
        requestDigest: coordinate.requestDigest,
        replayed: false,
        context,
      });

      const res = await request(app.getHttpServer())
        .post('/impersonation/sessions/authorization-receipts')
        .set('x-impersonation-token', VALID_TOKEN)
        .send({ ...coordinate, operations, operationSetDigest });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.authorizationReceiptId).toBe(coordinate.authorizationReceiptId);
      expect(mockImpersonationService.authorizeOperations).toHaveBeenCalledWith(
        expect.objectContaining({ operations, operationSetDigest }),
      );
    });

    it('rejects an operation-set digest mismatch before the service', async () => {
      const res = await request(app.getHttpServer())
        .post('/impersonation/sessions/authorization-receipts')
        .set('x-impersonation-token', VALID_TOKEN)
        .send({ ...coordinate, operations, operationSetDigest: 'e'.repeat(64) });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(mockImpersonationService.authorizeOperations).not.toHaveBeenCalled();
    });

    it('rejects unsigned callers and client-authored identity/network fields', async () => {
      mockGuard.canActivate.mockImplementationOnce((executionContext) => {
        const req = executionContext.switchToHttp().getRequest();
        req.user = { ...authenticatedUser };
        return true;
      });
      const unsigned = await request(app.getHttpServer())
        .post('/impersonation/sessions/authorization-context')
        .set('x-impersonation-token', VALID_TOKEN)
        .send(coordinate);
      expect(unsigned.status).toBe(HttpStatus.FORBIDDEN);

      const clientAuthored = await request(app.getHttpServer())
        .post('/impersonation/sessions/authorization-context')
        .set('x-impersonation-token', VALID_TOKEN)
        .send({
          ...coordinate,
          actorId: TARGET_ADMIN_ID,
          mfaVerified: true,
          clientIp: '198.51.100.8',
          clientUserAgent: 'spoofed',
        });
      expect(clientAuthored.status).toBe(HttpStatus.BAD_REQUEST);
      expect(mockImpersonationService.resolveAuthorizationContext).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 12. revokePermission -- permission revocation (previously missing)
  // ==========================================================================

  describe('POST /impersonation/permissions/:superAdminId/revoke', () => {
    it('should call revokeImpersonationPermission with the correct superAdminId', async () => {
      const res = await request(app.getHttpServer()).post(
        `/impersonation/permissions/${TARGET_ADMIN_ID}/revoke`,
      );

      expect(res.status).toBe(HttpStatus.NO_CONTENT);
      expect(mockImpersonationService.revokeImpersonationPermission).toHaveBeenCalledWith(
        TARGET_ADMIN_ID,
        AUTHENTICATED_ADMIN_ID,
      );
    });

    it('should propagate NotFoundException when permission does not exist', async () => {
      const { NotFoundException } = require('@nestjs/common');
      mockImpersonationService.revokeImpersonationPermission.mockRejectedValueOnce(
        new NotFoundException('Permission not found'),
      );

      const res = await request(app.getHttpServer()).post(
        `/impersonation/permissions/${TARGET_ADMIN_ID}/revoke`,
      );

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('should invoke PlatformAdminGuard', async () => {
      await request(app.getHttpServer()).post(
        `/impersonation/permissions/${TARGET_ADMIN_ID}/revoke`,
      );

      expect(mockGuard.canActivate).toHaveBeenCalled();
    });

    it('should reject an upper-case UUID path spelling', async () => {
      const res = await request(app.getHttpServer()).post(
        '/impersonation/permissions/A1B2C3D4-E5F6-4A7B-8C9D-E0F1A2B3C4D5/revoke',
      );

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(mockImpersonationService.revokeImpersonationPermission).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 13. checkPermission -- permission check (previously missing)
  // ==========================================================================

  describe('GET /impersonation/permissions/:superAdminId/check/:tenantId', () => {
    it('should call canImpersonate with correct superAdminId and tenantId', async () => {
      mockImpersonationService.canImpersonate.mockResolvedValueOnce({
        allowed: true,
        permission: { id: 'perm-1' },
      });

      const res = await request(app.getHttpServer()).get(
        `/impersonation/permissions/${TARGET_ADMIN_ID}/check/${TARGET_TENANT_ID}`,
      );

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.allowed).toBe(true);
      expect(mockImpersonationService.canImpersonate).toHaveBeenCalledWith(
        TARGET_ADMIN_ID,
        TARGET_TENANT_ID,
      );
    });

    it('should return allowed=false when permission is denied', async () => {
      mockImpersonationService.canImpersonate.mockResolvedValueOnce({
        allowed: false,
        reason: 'No impersonation permission granted',
      });

      const res = await request(app.getHttpServer()).get(
        `/impersonation/permissions/${TARGET_ADMIN_ID}/check/${TARGET_TENANT_ID}`,
      );

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.allowed).toBe(false);
      expect(res.body.reason).toBe('No impersonation permission granted');
    });

    it('should invoke PlatformAdminGuard', async () => {
      await request(app.getHttpServer()).get(
        `/impersonation/permissions/${TARGET_ADMIN_ID}/check/${TARGET_TENANT_ID}`,
      );

      expect(mockGuard.canActivate).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 15. getAuditSummary -- audit summary endpoint (previously missing)
  // ==========================================================================

  describe('GET /impersonation/audit/summary', () => {
    it('should return audit summary without date filters', async () => {
      mockImpersonationService.getAuditSummary.mockResolvedValueOnce({
        totalSessions: 10,
        activeSessions: 2,
        sessionsByReason: {},
        topImpersonators: [],
        topTargetTenants: [],
        recentSessions: [],
      });

      const res = await request(app.getHttpServer()).get('/impersonation/audit/summary');

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.totalSessions).toBe(10);
      expect(res.body.activeSessions).toBe(2);
      expect(mockImpersonationService.getAuditSummary).toHaveBeenCalledWith(undefined, undefined);
    });

    it('should pass date filters to service when provided', async () => {
      mockImpersonationService.getAuditSummary.mockResolvedValueOnce({
        totalSessions: 5,
        activeSessions: 0,
        sessionsByReason: {},
        topImpersonators: [],
        topTargetTenants: [],
        recentSessions: [],
      });

      const res = await request(app.getHttpServer()).get('/impersonation/audit/summary').query({
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-03-14T00:00:00.000Z',
      });

      expect(res.status).toBe(HttpStatus.OK);
      expect(mockImpersonationService.getAuditSummary).toHaveBeenCalledWith(
        expect.any(Date),
        expect.any(Date),
      );
    });

    it.each([
      {
        startDate: '2026-01-01',
        endDate: '2026-03-14T00:00:00.000Z',
      },
      {
        startDate: '2026-03-14T00:00:00.000Z',
        endDate: '2026-01-01T00:00:00.000Z',
      },
    ])('should reject non-canonical or reversed audit ranges', async (query) => {
      const res = await request(app.getHttpServer())
        .get('/impersonation/audit/summary')
        .query(query);

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(mockImpersonationService.getAuditSummary).not.toHaveBeenCalled();
    });

    it('should invoke PlatformAdminGuard', async () => {
      mockImpersonationService.getAuditSummary.mockResolvedValueOnce({ totalSessions: 0 });

      await request(app.getHttpServer()).get('/impersonation/audit/summary');

      expect(mockGuard.canActivate).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 16. Read-only endpoints -- no identity override possible
  // ==========================================================================

  describe('Read-only endpoints', () => {
    it('GET /impersonation/stats should return stats', async () => {
      mockImpersonationService.getImpersonationStats.mockResolvedValueOnce({
        totalSessions: 5,
        activeSessions: 1,
      });

      const res = await request(app.getHttpServer()).get('/impersonation/stats');

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.totalSessions).toBe(5);
    });

    it('GET /impersonation/sessions/active should return active sessions', async () => {
      mockImpersonationService.getActiveSessions.mockResolvedValueOnce([
        { id: 'session-1', status: 'active' },
      ]);

      const res = await request(app.getHttpServer()).get('/impersonation/sessions/active');

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).toHaveLength(1);
    });

    it('GET /impersonation/sessions/active/count should return count', async () => {
      mockImpersonationService.getActiveSessionCount.mockReturnValueOnce(3);

      const res = await request(app.getHttpServer()).get('/impersonation/sessions/active/count');

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.count).toBe(3);
    });
  });
});
