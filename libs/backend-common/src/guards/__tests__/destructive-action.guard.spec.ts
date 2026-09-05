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
  type DestructiveShortfallEvent,
} from '../destructive-action.guard';

class Controller {
  @Destructive({ reason: 'tenant erasure' })
  erase(): string {
    return 'erased';
  }

  @Destructive({ requiresFreshMfa: false, requiresBreakGlass: false })
  reversible(): string {
    return 'reversed';
  }

  @Destructive({ requiresBreakGlass: false })
  mfaOnly(): string {
    return 'mfa-only';
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
  const breakGlass = ['security-ops', 'break-glass'];
  let sink: DestructiveEventSink & { recordDestructiveShortfall: jest.Mock };
  let guard: DestructiveActionGuard;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    sink = { recordDestructiveShortfall: jest.fn() };
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
      requiresBreakGlass: true,
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

  it('allows a fresh MFA claim held together with a live break-glass grant', async () => {
    await expect(
      guard.canActivate(
        httpContext('erase', {
          sub: 'admin',
          mfaVerified: true,
          iat: nowSeconds - 60,
          platformCapabilities: breakGlass,
        }),
      ),
    ).resolves.toBe(true);
    expect(sink.recordDestructiveShortfall).not.toHaveBeenCalled();
  });

  it('in detective mode records a stale claim and a missing break-glass grant, and allows the operation', async () => {
    process.env['SUPER_ADMIN_MFA_ENFORCED_AT'] = 'detective';
    await expect(
      guard.canActivate(
        httpContext('erase', {
          sub: 'admin',
          mfaVerified: true,
          iat: nowSeconds - 3600,
          platformCapabilities: breakGlass,
        }),
      ),
    ).resolves.toBe(true);
    expect(sink.recordDestructiveShortfall).toHaveBeenLastCalledWith(
      expect.objectContaining({
        userId: 'admin',
        route: 'DELETE /api/v1/tenants/t1',
        reason: 'tenant erasure',
        shortfall: 'fresh_mfa',
        enforced: false,
      }),
    );
    await expect(
      guard.canActivate(
        httpContext('erase', {
          sub: 'admin',
          mfaVerified: true,
          iat: nowSeconds,
          platformCapabilities: ['security-ops'],
        }),
      ),
    ).resolves.toBe(true);
    expect(sink.recordDestructiveShortfall).toHaveBeenLastCalledWith(
      expect.objectContaining({ shortfall: 'break_glass', enforced: false }),
    );
    expect(sink.recordDestructiveShortfall).toHaveBeenCalledTimes(2);
  });

  it('records one event per missing control', async () => {
    process.env['SUPER_ADMIN_MFA_ENFORCED_AT'] = 'detective';
    await expect(guard.canActivate(httpContext('erase', { sub: 'admin' }))).resolves.toBe(true);
    const shortfalls = (
      sink.recordDestructiveShortfall.mock.calls as [DestructiveShortfallEvent][]
    ).map(([event]) => event.shortfall);
    expect(shortfalls).toEqual(['fresh_mfa', 'break_glass']);
  });

  it('once enforcement has started, refuses a stale claim or a missing break-glass grant', async () => {
    process.env['SUPER_ADMIN_MFA_ENFORCED_AT'] = '2020-01-01T00:00:00Z';
    await expect(
      guard.canActivate(
        httpContext('erase', {
          sub: 'admin',
          mfaVerified: true,
          iat: nowSeconds - 3600,
          platformCapabilities: breakGlass,
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      guard.canActivate(httpContext('erase', { sub: 'admin', mfaVerified: true, iat: nowSeconds })),
    ).rejects.toThrow(/break-glass/);
    expect(sink.recordDestructiveShortfall).toHaveBeenLastCalledWith(
      expect.objectContaining({ shortfall: 'break_glass', enforced: true }),
    );
  });

  it('a handler that opts out of break-glass still needs fresh MFA, and vice versa', async () => {
    process.env['SUPER_ADMIN_MFA_ENFORCED_AT'] = '2020-01-01T00:00:00Z';
    await expect(
      guard.canActivate(
        httpContext('mfaOnly', { sub: 'admin', mfaVerified: true, iat: nowSeconds }),
      ),
    ).resolves.toBe(true);
    await expect(
      guard.canActivate(httpContext('mfaOnly', { sub: 'admin', platformCapabilities: breakGlass })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('a destructive handler that opts out of both controls still needs a principal', async () => {
    await expect(guard.canActivate(httpContext('reversible', { sub: 'admin' }))).resolves.toBe(
      true,
    );
    await expect(guard.canActivate(httpContext('reversible', undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
