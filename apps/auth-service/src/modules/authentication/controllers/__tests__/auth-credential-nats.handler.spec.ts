import { RpcException } from '@nestjs/microservices';
import { Test } from '@nestjs/testing';
import { RedisService } from '@aquaculture/backend-common/redis';
import {
  AUTH_CREDENTIAL_SUBJECTS,
  type VerifyPasswordQuery,
  verifyPasswordQuerySchema,
} from '@platform/event-contracts';

import { AuditLogService } from '../../../../audit/audit-log.service';
import { AuthenticationService } from '../../services/authentication.service';
import { AuthCredentialNatsHandler } from '../auth-credential-nats.handler';

/**
 * request.auth.verifyPassword responder (unblocks messaging's GDPR
 * anonymizeMyData, which was broken because no responder existed).
 *
 * Pins the no-oracle posture: bare-boolean replies, fail-CLOSED on any fault
 * (RpcException, never a `false` a wrong password can't be told from a system
 * error), AJV trust-boundary rejection, and per-user rate limiting.
 */
describe('AuthCredentialNatsHandler (request.auth.verifyPassword)', () => {
  const VALID_UUID = '8025339a-e6c7-46df-b65a-dcf4f010b861';

  const confirmUserPassword = jest.fn();
  const auditLog = jest.fn().mockResolvedValue(undefined);
  const redisIncr = jest.fn();
  const redisExpire = jest.fn().mockResolvedValue(true);

  const validPayload: VerifyPasswordQuery = { userId: VALID_UUID, password: 'Voru1989**' };

  // Cast-free structural doubles via Nest DI useValue (accepts partial shapes
  // without any type assertion). `withRedis` omits the RedisService provider to
  // exercise the @Optional degrade-to-no-throttle path.
  const makeHandler = async (withRedis = true): Promise<AuthCredentialNatsHandler> => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthCredentialNatsHandler,
        { provide: AuthenticationService, useValue: { confirmUserPassword } },
        { provide: AuditLogService, useValue: { log: auditLog } },
        ...(withRedis
          ? [{ provide: RedisService, useValue: { incr: redisIncr, expire: redisExpire } }]
          : []),
      ],
    }).compile();
    return moduleRef.get(AuthCredentialNatsHandler);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    redisIncr.mockResolvedValue(1);
  });

  it('exposes the SSoT subject', () => {
    expect(AUTH_CREDENTIAL_SUBJECTS.VERIFY_PASSWORD).toBe('request.auth.verifyPassword');
  });

  it('returns true and audits SUCCESS when the password matches', async () => {
    confirmUserPassword.mockResolvedValue(true);
    const handler = await makeHandler();
    const result = await handler.verifyPassword(validPayload);
    expect(result).toBe(true);
    expect(confirmUserPassword).toHaveBeenCalledWith(VALID_UUID, 'Voru1989**');
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PASSWORD_CONFIRMATION_SUCCESS', entityId: VALID_UUID }),
    );
  });

  it('returns false and audits FAILED when the password does not match', async () => {
    confirmUserPassword.mockResolvedValue(false);
    const handler = await makeHandler();
    const result = await handler.verifyPassword(validPayload);
    expect(result).toBe(false);
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PASSWORD_CONFIRMATION_FAILED' }),
    );
  });

  it('rejects a malformed payload BEFORE touching the credential pipeline (fail closed)', async () => {
    const handler = await makeHandler();
    await expect(
      handler.verifyPassword({ userId: 'not-a-uuid', password: '' }),
    ).rejects.toBeInstanceOf(RpcException);
    expect(confirmUserPassword).not.toHaveBeenCalled();
    expect(redisIncr).not.toHaveBeenCalled();
  });

  it('AJV schema rejects extra keys (additionalProperties:false — smuggling guard)', () => {
    expect(verifyPasswordQuerySchema(validPayload)).toBe(true);
    expect(verifyPasswordQuerySchema({ ...validPayload, extra: 'x' })).toBe(false);
    expect(verifyPasswordQuerySchema({ userId: VALID_UUID })).toBe(false); // missing password
  });

  it('sets the window TTL on the first attempt and allows attempts within the limit', async () => {
    redisIncr.mockResolvedValue(1);
    confirmUserPassword.mockResolvedValue(false);
    const handler = await makeHandler();
    await handler.verifyPassword(validPayload);
    expect(redisExpire).toHaveBeenCalledWith(`auth:verify-password:${VALID_UUID}`, 15 * 60);
    expect(confirmUserPassword).toHaveBeenCalled();
  });

  it('throws (fail closed) and audits RATE_LIMITED once the per-user limit is exceeded', async () => {
    redisIncr.mockResolvedValue(6); // > VERIFY_MAX_ATTEMPTS (5)
    const handler = await makeHandler();
    await expect(handler.verifyPassword(validPayload)).rejects.toBeInstanceOf(RpcException);
    expect(confirmUserPassword).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'PASSWORD_CONFIRMATION_RATE_LIMITED' }),
    );
  });

  it('fails CLOSED (RpcException) on an internal error — never a bare false', async () => {
    confirmUserPassword.mockRejectedValue(new Error('db down'));
    const handler = await makeHandler();
    await expect(handler.verifyPassword(validPayload)).rejects.toBeInstanceOf(RpcException);
  });

  it('still answers when Redis is absent (degrades to caller-side rate limit only)', async () => {
    confirmUserPassword.mockResolvedValue(true);
    const handler = await makeHandler(false);
    const result = await handler.verifyPassword(validPayload);
    expect(result).toBe(true);
    expect(redisIncr).not.toHaveBeenCalled();
  });
});
