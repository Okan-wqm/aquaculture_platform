/**
 * AiCallerCapabilitiesService — MSGFIX-FAZ2 2.3 pins.
 *
 *   - happy path: NATS reply maps through, cached for 60s
 *   - !success / !found / !active / malformed arrays → null (fail closed)
 *   - NATS error/timeout → null, and the denial is CACHED (no per-message storm)
 *   - cache hit returns the cached shape without a NATS round-trip
 *   - cache outage falls through to NATS (cache is not the authority)
 */
import { Test, TestingModule } from '@nestjs/testing';
import { of, throwError } from 'rxjs';

import { AiCallerCapabilitiesService } from '../ai-caller-capabilities.service';
import { AUTH_USER_QUERY_SUBJECTS } from '@platform/event-contracts';

describe('AiCallerCapabilitiesService (MSGFIX-FAZ2)', () => {
  let service: AiCallerCapabilitiesService;
  let natsClient: { send: jest.Mock };
  let redis: { get: jest.Mock; setex: jest.Mock };

  const tenantId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';
  const cacheKey = `ai:caller-caps:${tenantId}:${userId}`;

  const okReply = {
    success: true,
    found: true,
    active: true,
    roles: ['MODULE_USER'],
    resourcePermissions: ['ai_assistant:use'],
  };

  beforeEach(async () => {
    natsClient = { send: jest.fn() };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      setex: jest.fn().mockResolvedValue('OK'),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AiCallerCapabilitiesService,
        { provide: 'NATS_SERVICE', useValue: natsClient },
        { provide: 'REDIS_CLIENT', useValue: redis },
      ],
    }).compile();
    service = module.get(AiCallerCapabilitiesService);
  });

  it('queries the auth-service subject and maps the reply', async () => {
    natsClient.send.mockReturnValue(of(okReply));

    const result = await service.resolve(tenantId, userId);

    expect(natsClient.send).toHaveBeenCalledWith(
      AUTH_USER_QUERY_SUBJECTS.RESOLVE_CALLER_CAPABILITIES,
      { tenantId, userId },
    );
    expect(result).toEqual({
      roles: ['MODULE_USER'],
      resourcePermissions: ['ai_assistant:use'],
    });
    expect(redis.setex).toHaveBeenCalledWith(
      cacheKey,
      60,
      JSON.stringify({ roles: ['MODULE_USER'], resourcePermissions: ['ai_assistant:use'] }),
    );
  });

  it('returns the cached capabilities WITHOUT a NATS round-trip', async () => {
    redis.get.mockResolvedValue(
      JSON.stringify({ roles: ['TENANT_ADMIN'], resourcePermissions: [] }),
    );

    const result = await service.resolve(tenantId, userId);

    expect(natsClient.send).not.toHaveBeenCalled();
    expect(result).toEqual({ roles: ['TENANT_ADMIN'], resourcePermissions: [] });
  });

  it.each([
    ['!success', { ...okReply, success: false }],
    ['!found (cross-tenant or nonexistent)', { ...okReply, found: false }],
    ['!active (deactivated)', { ...okReply, active: false }],
    ['malformed roles', { ...okReply, roles: 'MODULE_USER' }],
    ['malformed resourcePermissions', { ...okReply, resourcePermissions: [42] }],
  ])('fail-closed: %s → null + denial cached', async (_label, reply) => {
    natsClient.send.mockReturnValue(of(reply));

    const result = await service.resolve(tenantId, userId);

    expect(result).toBeNull();
    // The denial is cached so a broken responder cannot storm NATS.
    expect(redis.setex).toHaveBeenCalledWith(
      cacheKey,
      60,
      JSON.stringify({ roles: [], resourcePermissions: [] }),
    );
  });

  it('NATS transport failure → null (never a guessed role)', async () => {
    natsClient.send.mockReturnValue(throwError(() => new Error('timeout')));

    await expect(service.resolve(tenantId, userId)).resolves.toBeNull();
  });

  it('Redis outage is transparent — falls through to NATS', async () => {
    redis.get.mockRejectedValue(new Error('redis down'));
    redis.setex.mockRejectedValue(new Error('redis down'));
    natsClient.send.mockReturnValue(of(okReply));

    await expect(service.resolve(tenantId, userId)).resolves.toEqual({
      roles: ['MODULE_USER'],
      resourcePermissions: ['ai_assistant:use'],
    });
  });

  it('corrupt cache entry decodes to null (re-resolve on next turn)', async () => {
    redis.get.mockResolvedValue('{not json');
    natsClient.send.mockReturnValue(of(okReply));

    const result = await service.resolve(tenantId, userId);

    expect(natsClient.send).toHaveBeenCalled();
    expect(result).toEqual({
      roles: ['MODULE_USER'],
      resourcePermissions: ['ai_assistant:use'],
    });
  });
});
