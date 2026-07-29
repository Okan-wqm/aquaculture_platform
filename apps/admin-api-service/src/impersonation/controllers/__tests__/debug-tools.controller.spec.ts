/**
 * DebugToolsController Security Tests
 *
 * Enterprise-grade tests for the debug tools system's security controls.
 * Validates Sprint 4 security fixes:
 *   C6  - JWT-based identity on startDebugSession, createFeatureFlagOverride, revertOverride
 *   H24 - JSON.parse sanitization on getFeatureFlagValue (prototype pollution prevention)
 *
 * Tests verify:
 *   - adminId is ALWAYS sourced from JWT (req.user.id), never from client
 *   - @UseGuards(PlatformAdminGuard) is applied at class level
 *   - JSON.parse rejects object/array default values (H24 fix)
 *   - UnauthorizedException thrown when JWT user is missing
 *
 * Uses NestJS TestingModule with mocked DebugToolsService.
 */

import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import { createStandardPaginatedResult } from '@aquaculture/backend-common/pagination';
import { Test, TestingModule } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import request from 'supertest';

import { PlatformAdminGuard } from '../../../guards/platform-admin.guard';
import { DebugToolsController } from '../debug-tools.controller';
import { DebugToolsService } from '../../services/debug-tools.service';
import { DebugSessionType, QueryLogType } from '../../entities/debug-session.entity';

// ============================================================================
// Mock Definitions
// ============================================================================

const mockDebugToolsService = {
  getDebugDashboard: jest.fn().mockResolvedValue({ sessions: 0 }),
  querySessions: jest.fn().mockResolvedValue({ items: [], total: 0, page: 1, limit: 20, totalPages: 1, hasNextPage: false, hasPreviousPage: false }),
  startDebugSession: jest.fn().mockResolvedValue({ id: 'debug-session-1', isActive: true }),
  endDebugSession: jest.fn().mockResolvedValue({ id: 'debug-session-1', isActive: false }),
  getDebugSession: jest.fn().mockResolvedValue({ id: 'debug-session-1' }),
  getActiveSessionsForTenant: jest.fn().mockResolvedValue([]),
  captureQuery: jest.fn().mockResolvedValue(undefined),
  inspectQueries: jest.fn().mockResolvedValue({ data: [], total: 0 }),
  getQueryExplainPlan: jest.fn().mockResolvedValue({}),
  getSlowQueryAnalysis: jest.fn().mockResolvedValue({}),
  captureApiCall: jest.fn().mockResolvedValue(undefined),
  inspectApiCalls: jest.fn().mockResolvedValue({ data: [], total: 0 }),
  getApiUsageSummary: jest.fn().mockResolvedValue({}),
  getApiCallDetails: jest.fn().mockResolvedValue({}),
  getCacheStats: jest.fn().mockResolvedValue({}),
  listCacheEntries: jest.fn().mockResolvedValue({
    namespace: 'admin:',
    entries: [],
    matchedCount: 0,
    truncated: false,
  }),
  getCacheEntry: jest.fn().mockResolvedValue({}),
  invalidateCachePattern: jest.fn().mockResolvedValue(5),
  invalidateCacheKey: jest.fn().mockResolvedValue(1),
  createFeatureFlagOverride: jest.fn().mockResolvedValue({ id: 'override-1' }),
  revertFeatureFlagOverride: jest.fn().mockResolvedValue({ reverted: true }),
  getActiveOverridesForTenant: jest.fn().mockResolvedValue([]),
  getFeatureOverride: jest.fn().mockResolvedValue({}),
  getFeatureFlagValue: jest.fn().mockResolvedValue('enabled'),
  queryOverrides: jest
    .fn()
    .mockResolvedValue(createStandardPaginatedResult([], 0, 1, 20)),
};

// ============================================================================
// Test Suite
// ============================================================================

describe('DebugToolsController', () => {
  let app: INestApplication;

  const authenticatedUser = {
    id: 'jwt-debug-admin-uuid',
    email: 'debugger@platform.com',
    roles: ['SUPER_ADMIN'],
  };

  const mockGuard = {
    canActivate: jest.fn().mockImplementation((context) => {
      const req = context.switchToHttp().getRequest();
      req.user = { ...authenticatedUser };
      return true;
    }),
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [DebugToolsController],
      providers: [
        { provide: DebugToolsService, useValue: mockDebugToolsService },
      ],
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
    mockGuard.canActivate.mockImplementation((context) => {
      const req = context.switchToHttp().getRequest();
      req.user = { ...authenticatedUser };
      return true;
    });
  });

  // ==========================================================================
  // 1. Class-level @UseGuards(PlatformAdminGuard) verification
  // ==========================================================================

  describe('Guard metadata verification', () => {
    it('should have PlatformAdminGuard at class level', () => {
      const guards = Reflect.getMetadata('__guards__', DebugToolsController);
      expect(guards).toBeDefined();
      expect(guards).toContain(PlatformAdminGuard);
    });

    it('should invoke guard on every request', async () => {
      await request(app.getHttpServer()).get('/debug/dashboard');

      expect(mockGuard.canActivate).toHaveBeenCalled();
    });

    it('should reject when guard denies access', async () => {
      mockGuard.canActivate.mockReturnValueOnce(false);

      const res = await request(app.getHttpServer()).get('/debug/dashboard');

      expect(res.status).toBe(HttpStatus.FORBIDDEN);
    });

    it('should reject with 401 when guard throws UnauthorizedException', async () => {
      const { UnauthorizedException } = require('@nestjs/common');
      mockGuard.canActivate.mockImplementationOnce(() => {
        throw new UnauthorizedException('No token');
      });

      const res = await request(app.getHttpServer()).get('/debug/sessions');

      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  // ==========================================================================
  // 2. startDebugSession -- JWT identity (C6 Faz 1 fix)
  // ==========================================================================

  describe('POST /debug/sessions (startDebugSession)', () => {
    const validDto = {
      tenantId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
      sessionType: DebugSessionType.QUERY_INSPECTION,
    };

    it('should reject client-supplied adminId via forbidNonWhitelisted (DTO has no adminId field)', async () => {
      const res = await request(app.getHttpServer())
        .post('/debug/sessions')
        .send({
          ...validDto,
          adminId: 'attacker-injected-admin', // forbidden by whitelist validation
        });

      // forbidNonWhitelisted rejects unknown properties with 400
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      // Service should NOT be called -- attack prevented at DTO level
      expect(mockDebugToolsService.startDebugSession).not.toHaveBeenCalled();
    });

    it('should set adminId from JWT when sending valid DTO without adminId', async () => {
      await request(app.getHttpServer())
        .post('/debug/sessions')
        .send(validDto);

      expect(mockDebugToolsService.startDebugSession).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId: authenticatedUser.id,
          tenantId: validDto.tenantId,
          sessionType: validDto.sessionType,
        }),
      );
    });

    it('should return 401 when user is not authenticated (no user on req)', async () => {
      mockGuard.canActivate.mockImplementationOnce((context) => {
        // Guard passes but no user set
        return true;
      });

      const res = await request(app.getHttpServer())
        .post('/debug/sessions')
        .send(validDto);

      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('should reject missing tenantId', async () => {
      const res = await request(app.getHttpServer())
        .post('/debug/sessions')
        .send({ sessionType: DebugSessionType.QUERY_INSPECTION });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject invalid tenantId (not UUID)', async () => {
      const res = await request(app.getHttpServer())
        .post('/debug/sessions')
        .send({ tenantId: 'not-uuid', sessionType: DebugSessionType.QUERY_INSPECTION });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject missing sessionType', async () => {
      const res = await request(app.getHttpServer())
        .post('/debug/sessions')
        .send({ tenantId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject invalid sessionType enum', async () => {
      const res = await request(app.getHttpServer())
        .post('/debug/sessions')
        .send({
          tenantId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
          sessionType: 'invalid_type',
        });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should accept valid optional fields', async () => {
      await request(app.getHttpServer())
        .post('/debug/sessions')
        .send({
          ...validDto,
          configuration: { verbose: true },
          maxResults: 500,
          durationMinutes: 60,
        });

      expect(mockDebugToolsService.startDebugSession).toHaveBeenCalledWith(
        expect.objectContaining({
          maxResults: 500,
          durationMinutes: 60,
        }),
      );
    });

    it('should reject maxResults exceeding 10000', async () => {
      const res = await request(app.getHttpServer())
        .post('/debug/sessions')
        .send({ ...validDto, maxResults: 10001 });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject durationMinutes exceeding 1440', async () => {
      const res = await request(app.getHttpServer())
        .post('/debug/sessions')
        .send({ ...validDto, durationMinutes: 1441 });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject durationMinutes below 1', async () => {
      const res = await request(app.getHttpServer())
        .post('/debug/sessions')
        .send({ ...validDto, durationMinutes: 0 });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  // ==========================================================================
  // 3. createFeatureFlagOverride -- JWT identity (C6 fix)
  // ==========================================================================

  describe('POST /debug/feature-overrides (createFeatureFlagOverride)', () => {
    const validOverrideDto = {
      tenantId: 'b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6',
      featureKey: 'new_dashboard_v2',
      originalValue: false,
      overrideValue: true,
    };

    it('should reject client-supplied adminId via forbidNonWhitelisted', async () => {
      const res = await request(app.getHttpServer())
        .post('/debug/feature-overrides')
        .send({
          ...validOverrideDto,
          adminId: 'attacker-id', // forbidden by whitelist
        });

      // forbidNonWhitelisted rejects unknown properties with 400
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(mockDebugToolsService.createFeatureFlagOverride).not.toHaveBeenCalled();
    });

    it('should set adminId from JWT when valid DTO is sent without adminId', async () => {
      await request(app.getHttpServer())
        .post('/debug/feature-overrides')
        .send(validOverrideDto);

      expect(mockDebugToolsService.createFeatureFlagOverride).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId: authenticatedUser.id,
          featureKey: 'new_dashboard_v2',
          overrideValue: true,
        }),
      );
    });

    it('should return 401 when user is not authenticated', async () => {
      mockGuard.canActivate.mockImplementationOnce(() => true);

      const res = await request(app.getHttpServer())
        .post('/debug/feature-overrides')
        .send(validOverrideDto);

      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });

    it('should reject missing featureKey', async () => {
      const res = await request(app.getHttpServer())
        .post('/debug/feature-overrides')
        .send({
          tenantId: 'b2c3d4e5-f6a7-4b8c-9d0e-f1a2b3c4d5e6',
          originalValue: false,
          overrideValue: true,
        });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject featureKey exceeding maxLength (255)', async () => {
      const res = await request(app.getHttpServer())
        .post('/debug/feature-overrides')
        .send({
          ...validOverrideDto,
          featureKey: 'k'.repeat(256),
        });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should accept optional reason and expiresAt', async () => {
      await request(app.getHttpServer())
        .post('/debug/feature-overrides')
        .send({
          ...validOverrideDto,
          reason: 'Testing new feature in production',
          expiresAt: '2026-03-20T00:00:00Z',
        });

      expect(mockDebugToolsService.createFeatureFlagOverride).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'Testing new feature in production',
          expiresAt: expect.any(Date),
        }),
      );
    });
  });

  // ==========================================================================
  // 4. revertFeatureFlagOverride -- JWT identity (C6 fix)
  // ==========================================================================

  describe('POST /debug/feature-overrides/:id/revert', () => {
    it('should use JWT user.id as revertedBy', async () => {
      await request(app.getHttpServer())
        .post('/debug/feature-overrides/override-1/revert');

      expect(mockDebugToolsService.revertFeatureFlagOverride).toHaveBeenCalledWith(
        'override-1',
        authenticatedUser.id,
      );
    });

    it('should not accept client-injected revertedBy', async () => {
      await request(app.getHttpServer())
        .post('/debug/feature-overrides/override-1/revert')
        .set('x-admin-id', 'evil-admin')
        .send({ revertedBy: 'attacker-id' });

      expect(mockDebugToolsService.revertFeatureFlagOverride).toHaveBeenCalledWith(
        'override-1',
        authenticatedUser.id,
      );
    });

    it('should return 401 when user is not authenticated', async () => {
      mockGuard.canActivate.mockImplementationOnce(() => true);

      const res = await request(app.getHttpServer())
        .post('/debug/feature-overrides/override-1/revert');

      expect(res.status).toBe(HttpStatus.UNAUTHORIZED);
    });
  });

  // ==========================================================================
  // 5. queryOverrides -- JWT identity (C6 fix)
  // ==========================================================================

  describe('GET /debug/feature-overrides (queryOverrides)', () => {
    it('should pass JWT user.id as adminId to queryOverrides', async () => {
      await request(app.getHttpServer())
        .get('/debug/feature-overrides')
        .query({ tenantId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5' });

      expect(mockDebugToolsService.queryOverrides).toHaveBeenCalledWith(
        expect.objectContaining({
          adminId: authenticatedUser.id,
        }),
      );
    });
  });

  // ==========================================================================
  // 6. JSON.parse sanitization (H24 fix)
  // ==========================================================================

  // ==========================================================================
  // 6. JSON.parse sanitization (H24 fix)
  //
  // NOTE: GET /debug/feature-overrides/value is shadowed by
  // GET /debug/feature-overrides/:id in NestJS routing (/:id registered first).
  // We test the sanitization logic directly via controller method invocation
  // to validate the H24 fix independently of routing order.
  // ==========================================================================

  describe('getFeatureFlagValue JSON.parse sanitization (H24 fix)', () => {
    let controller: DebugToolsController;

    beforeEach(() => {
      controller = app.get(DebugToolsController);
    });

    it('should accept primitive string defaultValue', async () => {
      mockDebugToolsService.getFeatureFlagValue.mockResolvedValueOnce('enabled');

      const result = await controller.getFeatureFlagValue(
        'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
        'test_feature',
        'hello',
      );

      expect(result).toEqual({ value: 'enabled' });
      expect(mockDebugToolsService.getFeatureFlagValue).toHaveBeenCalledWith(
        'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
        'test_feature',
        'hello', // not valid JSON, stays as string
      );
    });

    it('should accept primitive number defaultValue (JSON parsed)', async () => {
      mockDebugToolsService.getFeatureFlagValue.mockResolvedValueOnce(42);

      await controller.getFeatureFlagValue(
        'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
        'max_retries',
        '42',
      );

      expect(mockDebugToolsService.getFeatureFlagValue).toHaveBeenCalledWith(
        'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
        'max_retries',
        42,
      );
    });

    it('should accept boolean defaultValue (JSON parsed)', async () => {
      mockDebugToolsService.getFeatureFlagValue.mockResolvedValueOnce(true);

      await controller.getFeatureFlagValue(
        'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
        'is_enabled',
        'true',
      );

      expect(mockDebugToolsService.getFeatureFlagValue).toHaveBeenCalledWith(
        'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
        'is_enabled',
        true,
      );
    });

    it('should accept null defaultValue (JSON parsed)', async () => {
      mockDebugToolsService.getFeatureFlagValue.mockResolvedValueOnce(null);

      await controller.getFeatureFlagValue(
        'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
        'optional_feature',
        'null',
      );

      expect(mockDebugToolsService.getFeatureFlagValue).toHaveBeenCalledWith(
        'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
        'optional_feature',
        null,
      );
    });

    it('should reject object defaultValue to prevent prototype pollution', async () => {
      mockDebugToolsService.getFeatureFlagValue.mockResolvedValueOnce('safe');
      const malicious = '{"__proto__":{"polluted":"true"}}';

      await controller.getFeatureFlagValue(
        'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
        'exploit_feature',
        malicious,
      );

      // The controller should have converted the parsed object back to string
      expect(mockDebugToolsService.getFeatureFlagValue).toHaveBeenCalledWith(
        'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
        'exploit_feature',
        malicious, // Stringified back -- NOT passed as object
      );
    });

    it('should reject array defaultValue to prevent injection', async () => {
      mockDebugToolsService.getFeatureFlagValue.mockResolvedValueOnce('safe');
      const arrayPayload = '[1,2,3]';

      await controller.getFeatureFlagValue(
        'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
        'array_exploit',
        arrayPayload,
      );

      // Array typeof === 'object', so controller converts to String(defaultValue)
      expect(mockDebugToolsService.getFeatureFlagValue).toHaveBeenCalledWith(
        'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
        'array_exploit',
        arrayPayload, // Stringified back
      );
    });

    it('should handle constructor pollution attempt', async () => {
      mockDebugToolsService.getFeatureFlagValue.mockResolvedValueOnce('safe');
      const constructorPayload = '{"constructor":{"prototype":{"isAdmin":true}}}';

      await controller.getFeatureFlagValue(
        'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
        'constructor_exploit',
        constructorPayload,
      );

      // Verify it was NOT passed as an object
      const callArgs = mockDebugToolsService.getFeatureFlagValue.mock.calls[0];
      expect(typeof callArgs[2]).not.toBe('object');
    });

    it('should handle invalid JSON gracefully (fallback to raw string)', async () => {
      mockDebugToolsService.getFeatureFlagValue.mockResolvedValueOnce('default');

      await controller.getFeatureFlagValue(
        'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
        'raw_string',
        'not-valid-json{',
      );

      expect(mockDebugToolsService.getFeatureFlagValue).toHaveBeenCalledWith(
        'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
        'raw_string',
        'not-valid-json{', // Raw string fallback
      );
    });
  });

  // ==========================================================================
  // 7. Input validation -- DTO validation rules
  // ==========================================================================

  describe('DTO input validation', () => {
    describe('CaptureQueryDto', () => {
      it('should reject missing required fields', async () => {
        const res = await request(app.getHttpServer())
          .post('/debug/queries/capture')
          .send({});

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      });

      it('should reject query exceeding maxLength (50000)', async () => {
        const res = await request(app.getHttpServer())
          .post('/debug/queries/capture')
          .send({
            tenantId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
            queryType: QueryLogType.SELECT,
            query: 'x'.repeat(50001),
            durationMs: 100,
          });

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      });
    });

    describe('CaptureApiCallDto', () => {
      it('should reject method exceeding maxLength (10)', async () => {
        const res = await request(app.getHttpServer())
          .post('/debug/api-calls/capture')
          .send({
            tenantId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
            method: 'VERYLONGMETHOD',
            endpoint: '/api/test',
            responseStatus: 200,
            durationMs: 50,
          });

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      });

      it('should reject responseStatus below 100', async () => {
        const res = await request(app.getHttpServer())
          .post('/debug/api-calls/capture')
          .send({
            tenantId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
            method: 'GET',
            endpoint: '/api/test',
            responseStatus: 99,
            durationMs: 50,
          });

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      });

      it('should reject responseStatus above 599', async () => {
        const res = await request(app.getHttpServer())
          .post('/debug/api-calls/capture')
          .send({
            tenantId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
            method: 'GET',
            endpoint: '/api/test',
            responseStatus: 600,
            durationMs: 50,
          });

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      });
    });

    describe('InvalidateCachePatternDto', () => {
      it('should reject empty pattern', async () => {
        const res = await request(app.getHttpServer())
          .post('/debug/cache/invalidate')
          .send({ pattern: '' });

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      });

      it('should reject pattern exceeding maxLength (500)', async () => {
        const res = await request(app.getHttpServer())
          .post('/debug/cache/invalidate')
          .send({ pattern: 'p'.repeat(501) });

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      });
    });

    describe('CreateFeatureFlagOverrideDto', () => {
      it('should reject missing tenantId', async () => {
        const res = await request(app.getHttpServer())
          .post('/debug/feature-overrides')
          .send({
            featureKey: 'test',
            originalValue: false,
            overrideValue: true,
          });

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      });

      it('should reject reason exceeding maxLength (1000)', async () => {
        const res = await request(app.getHttpServer())
          .post('/debug/feature-overrides')
          .send({
            tenantId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
            featureKey: 'test',
            originalValue: false,
            overrideValue: true,
            reason: 'r'.repeat(1001),
          });

        expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      });
    });
  });

  // ==========================================================================
  // 8. Error handling
  // ==========================================================================

  describe('Error handling', () => {
    it('should propagate NotFoundException for unknown session', async () => {
      const { NotFoundException } = require('@nestjs/common');
      mockDebugToolsService.getDebugSession.mockRejectedValueOnce(
        new NotFoundException('Debug session not found'),
      );

      const res = await request(app.getHttpServer()).get('/debug/sessions/non-existent');

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });

    it('should handle service errors gracefully on startDebugSession', async () => {
      mockDebugToolsService.startDebugSession.mockRejectedValueOnce(
        new Error('Database connection failed'),
      );

      const res = await request(app.getHttpServer())
        .post('/debug/sessions')
        .send({
          tenantId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
          sessionType: DebugSessionType.QUERY_INSPECTION,
        });

      expect(res.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
    });
  });

  // ==========================================================================
  // 9. Read-only endpoints
  // ==========================================================================

  describe('Read-only endpoints', () => {
    it('GET /debug/dashboard should return dashboard data', async () => {
      mockDebugToolsService.getDebugDashboard.mockResolvedValueOnce({ activeSessions: 2 });

      const res = await request(app.getHttpServer()).get('/debug/dashboard');

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.activeSessions).toBe(2);
    });

    it('GET /debug/cache/stats should return cache stats', async () => {
      mockDebugToolsService.getCacheStats.mockResolvedValueOnce({
        namespace: 'admin:',
        keysInNamespace: 100,
        instance: {
          keyspaceHits: 8,
          keyspaceMisses: 2,
          hitRatePercent: 80,
          usedMemoryBytes: 1024,
          totalKeys: 250,
        },
      });

      const res = await request(app.getHttpServer()).get('/debug/cache/stats');

      expect(res.status).toBe(HttpStatus.OK);
      // The namespace figure and the instance figures stay apart on the wire.
      expect(res.body.keysInNamespace).toBe(100);
      expect(res.body.instance.hitRatePercent).toBe(80);
    });

    it('every invalidation route reports the count the service returned', async () => {
      // The contract that makes a future no-op visible. The methods these
      // replaced returned a hard-coded 0 and a 204 with no body, so a caller
      // could not tell a purge from a stub.
      const byPattern = await request(app.getHttpServer())
        .post('/debug/cache/invalidate')
        .send({ pattern: 'report:*' });
      expect(byPattern.status).toBe(HttpStatus.CREATED);
      expect(byPattern.body.invalidated).toBe(5);

      const byKey = await request(app.getHttpServer()).delete('/debug/cache/report:abc');
      expect(byKey.status).toBe(HttpStatus.OK);
      expect(byKey.body.invalidated).toBe(1);
    });

    it('POST /debug/cache/capture is gone', async () => {
      // It was the only writer of a table nothing read. Its absence is the
      // finding: a capture endpoint with no producer is a ledger nobody keeps.
      const res = await request(app.getHttpServer())
        .post('/debug/cache/capture')
        .send({ key: 'k' });

      expect(res.status).toBe(HttpStatus.NOT_FOUND);
    });
  });

  // ==========================================================================
  // 10. Filters validation in startDebugSession
  // ==========================================================================

  describe('Filters in startDebugSession', () => {
    it('should pass valid filters with date conversion', async () => {
      await request(app.getHttpServer())
        .post('/debug/sessions')
        .send({
          tenantId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
          sessionType: DebugSessionType.QUERY_INSPECTION,
          filters: {
            startTime: '2026-03-01T00:00:00Z',
            endTime: '2026-03-14T23:59:59Z',
            queryTypes: [QueryLogType.SELECT, QueryLogType.INSERT],
            minDuration: 100,
            includeErrors: true,
          },
        });

      expect(mockDebugToolsService.startDebugSession).toHaveBeenCalledWith(
        expect.objectContaining({
          filters: expect.objectContaining({
            startTime: expect.any(Date),
            endTime: expect.any(Date),
            queryTypes: [QueryLogType.SELECT, QueryLogType.INSERT],
            minDuration: 100,
            includeErrors: true,
          }),
        }),
      );
    });

    it('should reject apiEndpoints exceeding ArrayMaxSize (50)', async () => {
      const res = await request(app.getHttpServer())
        .post('/debug/sessions')
        .send({
          tenantId: 'a1b2c3d4-e5f6-4a7b-8c9d-e0f1a2b3c4d5',
          sessionType: DebugSessionType.API_LOG_VIEWING,
          filters: {
            apiEndpoints: Array.from({ length: 51 }, (_, i) => `/api/endpoint-${i}`),
          },
        });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });
});
