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

import {
  PLATFORM_CAPABILITY_KEY,
  RequiresCapability,
} from '../../decorators/requires-capability.decorator';
import { PlatformCapabilityGuard, type CapabilityActor } from '../platform-capability.guard';

class Controller {
  @RequiresCapability('billing-ops')
  refund(): string {
    return 'refunded';
  }

  @RequiresCapability('support-ops', 'security-ops')
  reassign(): string {
    return 'reassigned';
  }

  list(): string {
    return 'listed';
  }
}

class HttpTestContext implements ExecutionContext {
  constructor(
    private readonly handler: (...args: unknown[]) => unknown,
    private readonly request: { user?: CapabilityActor },
    private readonly type = 'http',
  ) {}

  getClass<T = unknown>(): Type<T> {
    return Controller as Type<T>;
  }

  getHandler(): (...args: unknown[]) => unknown {
    return this.handler;
  }

  getType<TContext extends string = ContextType>(): TContext {
    return this.type as TContext;
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

function context(
  handler: keyof Controller,
  user: CapabilityActor | undefined,
  type = 'http',
): ExecutionContext {
  return new HttpTestContext(Controller.prototype[handler], { user }, type);
}

describe('PlatformCapabilityGuard', () => {
  const reflector = new Reflector();
  const guard = new PlatformCapabilityGuard(reflector);

  it('the decorator stores the closed-enum capability list as handler metadata', () => {
    expect(reflector.get(PLATFORM_CAPABILITY_KEY, Controller.prototype.reassign)).toEqual([
      'support-ops',
      'security-ops',
    ]);
  });

  it('leaves undecorated handlers to the role alone', () => {
    expect(guard.canActivate(context('list', undefined))).toBe(true);
    expect(guard.canActivate(context('list', { sub: 'admin' }))).toBe(true);
  });

  it('never decides authorisation for an anonymous request', () => {
    expect(() => guard.canActivate(context('refund', undefined))).toThrow(UnauthorizedException);
  });

  it('admits a principal holding one of the listed capabilities', () => {
    expect(
      guard.canActivate(context('refund', { sub: 'admin', platformCapabilities: ['billing-ops'] })),
    ).toBe(true);
    expect(
      guard.canActivate(
        context('reassign', { sub: 'admin', platformCapabilities: ['security-ops'] }),
      ),
    ).toBe(true);
  });

  it('refuses a SUPER_ADMIN whose claim lacks the capability, naming what is missing', () => {
    expect(() =>
      guard.canActivate(context('refund', { sub: 'admin', platformCapabilities: ['support-ops'] })),
    ).toThrow(ForbiddenException);
    expect(() => guard.canActivate(context('refund', { sub: 'admin' }))).toThrow(/billing-ops/);
  });

  it('break-glass and platform-read-only imply nothing about other capabilities', () => {
    expect(() =>
      guard.canActivate(
        context('refund', {
          sub: 'admin',
          platformCapabilities: ['break-glass', 'platform-read-only'],
        }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('drops strings outside the closed enum instead of honouring them', () => {
    expect(() =>
      guard.canActivate(
        context('refund', { sub: 'admin', platformCapabilities: ['billing-ops-legacy', '*'] }),
      ),
    ).toThrow(ForbiddenException);
  });

  it('is inert on the NATS (rpc) surface, which the broker authenticates by cert', () => {
    expect(guard.canActivate(context('refund', undefined, 'rpc'))).toBe(true);
  });
});
