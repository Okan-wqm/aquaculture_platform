/**
 * Password Reset Controller - Security Tests
 *
 * Tests cover:
 * - DTO validation (email, password)
 * - Email enumeration prevention
 * - Auth-service delegation for reset-token/password state
 * - Canonical distributed rate-limit metadata
 * - Public decorator presence (bypass auth for these endpoints)
 */
import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import {
  RATE_LIMIT_CONFIG_KEY,
  type RateLimitRouteConfig,
} from '@aquaculture/backend-common/rate-limit';
import { Test, TestingModule } from '@nestjs/testing';
import { AUTH_PUBLIC_COMMAND_SUBJECTS } from '@platform/event-contracts';
import { of, throwError } from 'rxjs';
import request from 'supertest';

import { PasswordResetController } from '../password-reset.controller';

describe('PasswordResetController Security', () => {
  let app: INestApplication;

  type TestApp = Parameters<typeof request>[0];
  type PasswordResetResponseBody = {
    success?: boolean;
    message?: string;
  };
  type AuthNatsSend = jest.Mock<unknown, [string, unknown]>;

  const mockAuthNatsClient = {
    send: jest.fn() as AuthNatsSend,
  };

  function httpServer(): TestApp {
    return app.getHttpServer() as TestApp;
  }

  function responseBody(res: request.Response): PasswordResetResponseBody {
    return res.body as PasswordResetResponseBody;
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function authCommandAt(index: number): Record<string, unknown> {
    const call = mockAuthNatsClient.send.mock.calls[index];
    if (!call) {
      throw new Error(`Expected auth NATS command at call index ${index}`);
    }
    const payload = call[1];
    if (!isRecord(payload)) {
      throw new Error(`Expected auth NATS command payload at call index ${index}`);
    }
    return payload;
  }

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PasswordResetController],
      providers: [{ provide: 'AUTH_NATS_CLIENT', useValue: mockAuthNatsClient }],
    }).compile();

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
    mockAuthNatsClient.send.mockReturnValue(of({ success: true }));
  });

  // ========================================================================
  // 1. Forgot Password - Validation
  // ========================================================================
  describe('POST /auth/forgot-password - Validation', () => {
    it('should accept valid email', async () => {
      const res = await request(httpServer())
        .post('/auth/forgot-password')
        .send({ email: 'user@example.com' });

      expect(res.status).toBe(HttpStatus.OK);
      expect(responseBody(res).success).toBe(true);
    });

    it('should reject missing email', async () => {
      const res = await request(httpServer()).post('/auth/forgot-password').send({});

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject invalid email format', async () => {
      const res = await request(httpServer())
        .post('/auth/forgot-password')
        .send({ email: 'not-an-email' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject extra fields (forbidNonWhitelisted)', async () => {
      const res = await request(httpServer())
        .post('/auth/forgot-password')
        .send({ email: 'user@example.com', maliciousField: 'hacked' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  // ========================================================================
  // 2. Email Enumeration Prevention
  // ========================================================================
  describe('Email enumeration prevention', () => {
    it('should return success even for non-existent email', async () => {
      const res = await request(httpServer())
        .post('/auth/forgot-password')
        .send({ email: 'nonexistent@example.com' });

      expect(res.status).toBe(HttpStatus.OK);
      expect(responseBody(res).success).toBe(true);
      expect(responseBody(res).message).toContain('If an account');
    });

    it('should return same response shape for existing email', async () => {
      const res = await request(httpServer())
        .post('/auth/forgot-password')
        .send({ email: 'exists@example.com' });

      expect(res.status).toBe(HttpStatus.OK);
      expect(responseBody(res).success).toBe(true);
      expect(responseBody(res).message).toContain('If an account');
    });

    it('should return success even on internal error', async () => {
      mockAuthNatsClient.send.mockReturnValueOnce(
        throwError(() => new Error('NATS connection failed')),
      );

      const res = await request(httpServer())
        .post('/auth/forgot-password')
        .send({ email: 'user@example.com' });

      expect(res.status).toBe(HttpStatus.OK);
      expect(responseBody(res).success).toBe(true);
    });
  });

  // ========================================================================
  // 3. Token Security
  // ========================================================================
  describe('Token security', () => {
    it('should delegate forgot password to auth-service without local token storage', async () => {
      await request(httpServer()).post('/auth/forgot-password').send({ email: 'Test@Test.COM' });

      expect(mockAuthNatsClient.send).toHaveBeenCalledWith(
        AUTH_PUBLIC_COMMAND_SUBJECTS.REQUEST_PASSWORD_RESET,
        expect.objectContaining({ email: 'test@test.com' }),
      );
    });

    it('should not send raw reset URL material from admin-api', async () => {
      await request(httpServer()).post('/auth/forgot-password').send({ email: 'test@test.com' });

      const command = authCommandAt(0);

      expect(command).not.toHaveProperty('rawToken');
      expect(command).not.toHaveProperty('resetLink');
      expect(command).not.toHaveProperty('tokenHash');
    });
  });

  // ========================================================================
  // 4. Reset Password - Validation
  // ========================================================================
  describe('POST /auth/reset-password - Validation', () => {
    it('should reject missing token', async () => {
      const res = await request(httpServer())
        .post('/auth/reset-password')
        .send({ newPassword: 'ValidPass123!' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject missing password', async () => {
      const res = await request(httpServer())
        .post('/auth/reset-password')
        .send({ token: 'some-token' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject password shorter than 8 characters', async () => {
      const res = await request(httpServer())
        .post('/auth/reset-password')
        .send({ token: 'some-token', newPassword: 'short' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should reject password longer than 128 characters', async () => {
      const longPassword = 'a'.repeat(129);
      const res = await request(httpServer())
        .post('/auth/reset-password')
        .send({ token: 'some-token', newPassword: longPassword });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });

    it('should accept valid token and password', async () => {
      const res = await request(httpServer())
        .post('/auth/reset-password')
        .send({ token: 'valid-token-string', newPassword: 'ValidPass123!' });

      expect(res.status).toBe(HttpStatus.OK);
      expect(responseBody(res).success).toBe(true);
    });

    it('should reject extra fields', async () => {
      const res = await request(httpServer())
        .post('/auth/reset-password')
        .send({ token: 'tok', newPassword: 'ValidPass123!', role: 'SUPER_ADMIN' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  // ========================================================================
  // 5. Reset Password - Token Verification
  // ========================================================================
  describe('Reset password token verification', () => {
    it('should reject invalid/expired token', async () => {
      mockAuthNatsClient.send.mockReturnValueOnce(
        of({
          success: false,
          errorCode: 'INVALID_OR_EXPIRED_TOKEN',
        }),
      );

      const res = await request(httpServer())
        .post('/auth/reset-password')
        .send({ token: 'invalid-token', newPassword: 'NewPass123!' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(responseBody(res).message).toContain('Invalid or expired');
    });

    it('should delegate the new password to auth-service for hashing and persistence', async () => {
      await request(httpServer())
        .post('/auth/reset-password')
        .send({ token: 'valid-token', newPassword: 'NewSecurePass123!' });

      expect(mockAuthNatsClient.send).toHaveBeenCalledWith(
        AUTH_PUBLIC_COMMAND_SUBJECTS.RESET_PASSWORD,
        expect.objectContaining({
          token: 'valid-token',
          newPassword: 'NewSecurePass123!',
        }),
      );
    });

    it('should not issue local auth table update statements', async () => {
      await request(httpServer())
        .post('/auth/reset-password')
        .send({ token: 'valid-token', newPassword: 'NewSecurePass123!' });

      expect(mockAuthNatsClient.send).toHaveBeenCalledTimes(1);
    });
  });

  // ========================================================================
  // 6. SQL Injection Prevention
  // ========================================================================
  describe('SQL injection prevention', () => {
    it('should reject invalid email before auth-service delegation', async () => {
      await request(httpServer())
        .post('/auth/forgot-password')
        .send({ email: "test@test.com'; DROP TABLE users;--" });

      expect(mockAuthNatsClient.send).not.toHaveBeenCalled();
    });
  });

  describe('distributed rate-limit contract', () => {
    it.each(['forgotPassword', 'resetPassword'] as const)(
      '%s carries the canonical fail-closed password-reset policy',
      (method) => {
        const metadata = Reflect.getMetadata(
          RATE_LIMIT_CONFIG_KEY,
          PasswordResetController.prototype[method],
        ) as RateLimitRouteConfig | undefined;
        expect(metadata).toMatchObject({
          name: 'admin-password-reset',
          limit: 3,
          windowMs: 3_600_000,
          requiresDistributedStore: true,
        });
      },
    );
  });
});
