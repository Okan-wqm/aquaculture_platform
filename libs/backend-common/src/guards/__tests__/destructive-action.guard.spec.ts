import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
  type Type,
} from '@nestjs/common';
import type {
  ContextType,
  HttpArgumentsHost,
  RpcArgumentsHost,
  WsArgumentsHost,
} from '@nestjs/common/interfaces';
import { Reflector } from '@nestjs/core';

import { DESTRUCTIVE_KEY, Destructive } from '../../decorators/destructive.decorator';
import {
  DestructiveActionGuard,
  type DestructiveActor,
  type DestructiveEventSink,
} from '../destructive-action.guard';

class Controller {
  @Destructive({ reason: 'tenant erasure' })
  erase(): string {
    return 'erased';
  }

  @Destructive({ requiresFreshMfa: false })
  reversible(): string {
    return 'reversed';
  }

  plain(): string {
    return 'plain';
  }
}

/** A structural ExecutionContext for an HTTP request; unused facets throw so a test cannot lean on them silently. */
class HttpTestContext implements ExecutionContext {
  constructor(
    private readonly handler: (...args: unknown[]) => unknown,
    private readonly request: { user?: DestructiveActor; method: string; originalUrl: string },
  ) {}

  getClass<T = unknown>(): Type<T> {
    return Controller as Type<T>;
  }

  getHandler(): (...args: unknown[]) => unknown {
    return this.handler;
  }

  getType<TContext extends string = ContextType>(): TContext {
    return 'http' as TContext;
  }

  switchToHttp(): HttpArgumentsHost {
    return {
      getRequest: <T = unknown>(): T => this.request as T,
      getResponse: <T = unknown>(): T => ({}) as T,
      getNext: <T = unknown>(): T => (() => undefined) as T,
    };
  }

  getArgs<T extends unknown[] = unknown[]>(): T {
    return [this.request] as T;
  }

  getArgByIndex<T = unknown>(index: number): T {
    return this.getArgs()[index] as T;
  }

  switchToRpc(): RpcArgumentsHost {
    throw new Error('not an RPC context');
  }

  switchToWs(): WsArgumentsHost {
    throw new Error('not a WS context');
  }
}

function httpContext(
  handler: keyof Controller,
  user: DestructiveActor | undefined,
): ExecutionContext {
  return new HttpTestContext(Controller.prototype[handler], {
    user,
    method: 'DELETE',
    originalUrl: '/api/v1/tenants/t1',
  });
}

describe('DestructiveActionGuard', () => {
  const reflector = new Reflector();
  const nowSeconds = Math.floor(Date.now() / 1000);
  let sink: DestructiveEventSink & { recordDestructiveWithoutFreshMfa: jest.Mock };
  let guard: DestructiveActionGuard;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    sink = { recordDestructiveWithoutFreshMfa: jest.fn() };
    guard = new DestructiveActionGuard(reflector, sink);
    delete process.env['SUPER_ADMIN_MFA_ENFORCED_AT'];
    process.env['NODE_ENV'] = 'test';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('the decorator carries the guard and its metadata (no separate registration to forget)', () => {
    expect(reflector.get(DESTRUCTIVE_KEY, Controller.prototype.erase)).toEqual({
      requiresFreshMfa: true,
      reason: 'tenant erasure',
    });
    const guards = reflector.get<unknown[]>('__guards__', Controller.prototype.erase);
    expect(guards).toContain(DestructiveActionGuard);
  });

  it('ignores handlers that are not destructive', async () => {
    await expect(guard.canActivate(httpContext('plain', undefined))).resolves.toBe(true);
  });

  it('never lets an anonymous request through', async () => {
    await expect(guard.canActivate(httpContext('erase', undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('allows a fresh MFA claim', async () => {
    await expect(
      guard.canActivate(
        httpContext('erase', { sub: 'admin', mfaVerified: true, iat: nowSeconds - 60 }),
      ),
    ).resolves.toBe(true);
    expect(sink.recordDestructiveWithoutFreshMfa).not.toHaveBeenCalled();
  });

  it('in detective mode records a stale or absent claim and allows the operation', async () => {
    process.env['SUPER_ADMIN_MFA_ENFORCED_AT'] = 'detective';
    await expect(
      guard.canActivate(
        httpContext('erase', { sub: 'admin', mfaVerified: true, iat: nowSeconds - 3600 }),
      ),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(httpContext('erase', { sub: 'admin', iat: nowSeconds })),
    ).resolves.toBe(true);
    expect(sink.recordDestructiveWithoutFreshMfa).toHaveBeenCalledTimes(2);
    expect(sink.recordDestructiveWithoutFreshMfa).toHaveBeenLastCalledWith(
      expect.objectContaining({
        userId: 'admin',
        route: 'DELETE /api/v1/tenants/t1',
        reason: 'tenant erasure',
        enforced: false,
      }),
    );
  });

  it('once enforcement has started, refuses a stale or absent claim', async () => {
    process.env['SUPER_ADMIN_MFA_ENFORCED_AT'] = '2020-01-01T00:00:00Z';
    await expect(
      guard.canActivate(
        httpContext('erase', { sub: 'admin', mfaVerified: true, iat: nowSeconds - 3600 }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(guard.canActivate(httpContext('erase', { sub: 'admin' }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(sink.recordDestructiveWithoutFreshMfa).toHaveBeenLastCalledWith(
      expect.objectContaining({ enforced: true }),
    );
  });

  it('a destructive handler that opts out of fresh MFA still needs a principal', async () => {
    await expect(guard.canActivate(httpContext('reversible', { sub: 'admin' }))).resolves.toBe(
      true,
    );
    await expect(guard.canActivate(httpContext('reversible', undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
