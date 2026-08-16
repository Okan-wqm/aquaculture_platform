import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';

import { RecentMfaGuard, RequireRecentMfa } from '../recent-mfa.guard';

@RequireRecentMfa(600)
class ProtectedController {
  @RequireRecentMfa(300)
  protectedMutation(): string {
    return 'protected';
  }

  classPolicyMutation(): string {
    return 'class-policy';
  }
}

class OpenController {
  openRoute(): string {
    return 'open';
  }
}

function httpContext(
  controller: new () => object,
  handler: (...args: never[]) => unknown,
  user?: { sub: string; mfaVerified?: boolean; iat?: number },
): ExecutionContext {
  return new ExecutionContextHost([{ user }, {}], controller, handler);
}

describe('RecentMfaGuard', () => {
  let nowSeconds: number;
  let guard: RecentMfaGuard;

  beforeEach(() => {
    nowSeconds = 2_000_000_000;
    jest.spyOn(Date, 'now').mockReturnValue(nowSeconds * 1000);
    guard = new RecentMfaGuard(new Reflector());
  });

  afterEach(() => jest.restoreAllMocks());

  it('leaves routes without @RequireRecentMfa metadata unchanged', () => {
    expect(guard.canActivate(httpContext(OpenController, OpenController.prototype.openRoute))).toBe(
      true,
    );
  });

  it('rejects a body-independent request whose verified user lacks MFA', () => {
    const context = httpContext(
      ProtectedController,
      ProtectedController.prototype.protectedMutation,
      {
        sub: 'admin-1',
        mfaVerified: false,
        iat: nowSeconds,
      },
    );
    const request = context.switchToHttp().getRequest<{
      body?: Record<string, unknown>;
      headers?: Record<string, string>;
    }>();
    request.body = { mfaVerified: true, iat: nowSeconds };
    request.headers = {
      'x-mfa-verified': 'true',
      'x-mfa-issued-at': String(nowSeconds),
    };
    expect(() => guard.canActivate(context)).toThrow('Recent MFA verification is required');
  });

  it('uses method metadata ahead of class metadata and rejects a 301-second token', () => {
    const context = httpContext(
      ProtectedController,
      ProtectedController.prototype.protectedMutation,
      {
        sub: 'admin-1',
        mfaVerified: true,
        iat: nowSeconds - 301,
      },
    );
    expect(() => guard.canActivate(context)).toThrow('MFA verification is no longer recent');
  });

  it('uses the class policy when the method has no override', () => {
    const context = httpContext(
      ProtectedController,
      ProtectedController.prototype.classPolicyMutation,
      {
        sub: 'admin-1',
        mfaVerified: true,
        iat: nowSeconds - 301,
      },
    );
    expect(guard.canActivate(context)).toBe(true);
  });

  it('accepts a recent verified step-up token', () => {
    const context = httpContext(
      ProtectedController,
      ProtectedController.prototype.protectedMutation,
      {
        sub: 'admin-1',
        mfaVerified: true,
        iat: nowSeconds - 299,
      },
    );
    expect(guard.canActivate(context)).toBe(true);
  });

  it('fails closed when issued-at is absent or implausibly in the future', () => {
    expect(() =>
      guard.canActivate(
        httpContext(ProtectedController, ProtectedController.prototype.protectedMutation, {
          sub: 'admin-1',
          mfaVerified: true,
        }),
      ),
    ).toThrow('MFA verification age cannot be verified');

    expect(() =>
      guard.canActivate(
        httpContext(ProtectedController, ProtectedController.prototype.protectedMutation, {
          sub: 'admin-1',
          mfaVerified: true,
          iat: nowSeconds + 31,
        }),
      ),
    ).toThrow('MFA verification age cannot be verified');
  });
});
