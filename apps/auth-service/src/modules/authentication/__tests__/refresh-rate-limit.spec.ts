/**
 * SEC-MEDIUM-212 — the refresh bucket is sized for a shared address and keyed by
 * nothing the request can choose.
 *
 * Driven through the REAL guard and the real in-process store with the REAL
 * decorator metadata of `AuthResolver.refreshToken`, so the numbers asserted are
 * the numbers production enforces, not a copy of them.
 */
import 'reflect-metadata';

import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host';
import {
  RATE_LIMIT_CONFIG_KEY,
  RateLimitGuard,
  type RateLimitRouteConfig,
} from '@aquaculture/backend-common/rate-limit';

import { AuthResolver } from '../resolvers/auth.resolver';
import { REFRESH_RATE_LIMIT } from '../utils/refresh-rate-limit';

const noopHandler = (): void => undefined;

/** A GraphQL mutation as Apollo hands it to the guard: [root, args, ctx, info]. */
function refreshContext(ip: string, token: string): ExecutionContext {
  const request = { ip, headers: {}, res: { setHeader: jest.fn() } };
  const host = new ExecutionContextHost(
    [undefined, { input: { refreshToken: token } }, { req: request }, undefined],
    null,
    noopHandler,
  );
  host.setType('graphql');
  return host;
}

/** The guard, resolving the refresh route config exactly as the framework would. */
function guard(): RateLimitGuard {
  const reflector = new Reflector();
  jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(REFRESH_RATE_LIMIT);
  return new RateLimitGuard(reflector);
}

describe('the refreshToken bucket (SEC-MEDIUM-212)', () => {
  afterEach(() => jest.restoreAllMocks());

  it('is the bucket the resolver actually carries', () => {
    const descriptor = Object.getOwnPropertyDescriptor(AuthResolver.prototype, 'refreshToken');

    expect(Reflect.getMetadata(RATE_LIMIT_CONFIG_KEY, descriptor?.value as object)).toBe(
      REFRESH_RATE_LIMIT,
    );
  });

  it('carries no claimed identity: nothing the request names picks the bucket', () => {
    // A bucket keyed by the userId inside the token (or a session id) before the
    // token is verified lets an attacker spend a victim's budget by claiming the
    // victim's id. Only the address is a dimension the caller cannot choose.
    const config: RateLimitRouteConfig = REFRESH_RATE_LIMIT;

    expect(config.identifier).toBeUndefined();
  });

  it('lets a team behind ONE address through: 120 distinct sessions in the window are all served', async () => {
    const limiter = guard();

    for (let session = 0; session < REFRESH_RATE_LIMIT.limit; session++) {
      await expect(
        limiter.canActivate(refreshContext('198.51.100.20', `user-${session}:secret`)),
      ).resolves.toBe(true);
    }
  });

  it('still bounds an address: the request after the limit is refused', async () => {
    const limiter = guard();
    for (let call = 0; call < REFRESH_RATE_LIMIT.limit; call++) {
      await limiter.canActivate(refreshContext('198.51.100.21', 'a:secret'));
    }

    await expect(
      limiter.canActivate(refreshContext('198.51.100.21', 'a:secret')),
    ).rejects.toBeDefined();
  });

  it("does not let one address spend another address's budget", async () => {
    const limiter = guard();
    for (let call = 0; call < REFRESH_RATE_LIMIT.limit; call++) {
      await limiter.canActivate(refreshContext('198.51.100.22', 'a:secret'));
    }

    await expect(limiter.canActivate(refreshContext('198.51.100.23', 'a:secret'))).resolves.toBe(
      true,
    );
  });

  it('a claimed identity does not buy a fresh budget: rotating the token string stays in the same bucket', async () => {
    const limiter = guard();
    for (let call = 0; call < REFRESH_RATE_LIMIT.limit; call++) {
      await limiter.canActivate(refreshContext('198.51.100.24', `forged-${call}:secret`));
    }

    await expect(
      limiter.canActivate(refreshContext('198.51.100.24', 'someone-else:secret')),
    ).rejects.toBeDefined();
  });
});
