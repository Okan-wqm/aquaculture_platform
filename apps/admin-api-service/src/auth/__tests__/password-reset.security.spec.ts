import { INestApplication, ValidationPipe, HttpStatus } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  AUTH_PASSWORD_RESET_SUBJECTS,
  type AuthPasswordResetCompleteResult,
  type AuthPasswordResetRequestResult,
} from '@platform/event-contracts';
import { of, throwError } from 'rxjs';
import request from 'supertest';

import { PasswordResetController } from '../password-reset.controller';

describe('PasswordResetController Security', () => {
  let app: INestApplication;

  const mockAuthNatsClient = {
    send: jest.fn(),
  };

  beforeAll(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [PasswordResetController],
      providers: [
        { provide: 'AUTH_NATS_CLIENT', useValue: mockAuthNatsClient },
      ],
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
    mockAuthNatsClient.send.mockReturnValue(
      of<AuthPasswordResetRequestResult | AuthPasswordResetCompleteResult>({
        success: true,
        message: 'ok',
      }),
    );
  });

  describe('POST /auth/forgot-password', () => {
    it('delegates to auth-service and preserves enumeration-safe response', async () => {
      mockAuthNatsClient.send.mockReturnValueOnce(
        of<AuthPasswordResetRequestResult>({
          success: true,
          message: 'If an account with that email exists, a password reset link has been sent.',
        }),
      );

      const res = await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'user@example.com' });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toContain('If an account');
      expect(mockAuthNatsClient.send).toHaveBeenCalledWith(
        AUTH_PASSWORD_RESET_SUBJECTS.REQUEST,
        expect.objectContaining({ email: 'user@example.com' }),
      );
    });

    it('rejects invalid email and extra fields before NATS delegation', async () => {
      const invalid = await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'not-an-email' });
      expect(invalid.status).toBe(HttpStatus.BAD_REQUEST);

      const extra = await request(app.getHttpServer())
        .post('/auth/forgot-password')
        .send({ email: 'user@example.com', maliciousField: 'hacked' });
      expect(extra.status).toBe(HttpStatus.BAD_REQUEST);

      expect(mockAuthNatsClient.send).not.toHaveBeenCalled();
    });
  });

  describe('POST /auth/reset-password', () => {
    it('delegates reset completion to auth-service', async () => {
      mockAuthNatsClient.send.mockReturnValueOnce(
        of<AuthPasswordResetCompleteResult>({
          success: true,
          message: 'Password has been reset successfully.',
        }),
      );

      const res = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: 'valid-token-string', newPassword: 'ValidPass123!' });

      expect(res.status).toBe(HttpStatus.OK);
      expect(res.body).toEqual({
        success: true,
        message: 'Password has been reset successfully.',
      });
      expect(mockAuthNatsClient.send).toHaveBeenCalledWith(
        AUTH_PASSWORD_RESET_SUBJECTS.COMPLETE,
        expect.objectContaining({
          token: 'valid-token-string',
          newPassword: 'ValidPass123!',
        }),
      );
    });

    it('maps auth-service invalid token response to 400', async () => {
      mockAuthNatsClient.send.mockReturnValueOnce(
        of<AuthPasswordResetCompleteResult>({
          success: false,
          message: 'Password reset failed.',
          errorCode: 'INVALID_OR_EXPIRED_TOKEN',
        }),
      );

      const res = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: 'invalid-token', newPassword: 'NewPass123!' });

      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
      expect(res.body.message).toContain('Invalid or expired');
    });

    it('rejects invalid password shape before NATS delegation', async () => {
      const missingToken = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ newPassword: 'ValidPass123!' });
      expect(missingToken.status).toBe(HttpStatus.BAD_REQUEST);

      const extra = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: 'tok', newPassword: 'ValidPass123!', role: 'SUPER_ADMIN' });
      expect(extra.status).toBe(HttpStatus.BAD_REQUEST);

      expect(mockAuthNatsClient.send).not.toHaveBeenCalled();
    });

    it('fails closed when auth-service is unavailable', async () => {
      mockAuthNatsClient.send.mockReturnValueOnce(
        throwError(() => new Error('nats down')),
      );

      const res = await request(app.getHttpServer())
        .post('/auth/reset-password')
        .send({ token: 'valid-token', newPassword: 'ValidPass123!' });

      expect(res.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    });
  });
});
