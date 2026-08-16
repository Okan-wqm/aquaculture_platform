import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';

import type { JwtUser } from '../types/tenant-request.interface';

export const RECENT_MFA_MAX_AGE_SECONDS = Symbol('RECENT_MFA_MAX_AGE_SECONDS');
export const DEFAULT_RECENT_MFA_MAX_AGE_SECONDS = 300;
const MAX_FUTURE_CLOCK_SKEW_SECONDS = 30;

/** Require an MFA-bearing access token issued within the configured age. */
export function RequireRecentMfa(
  maxAgeSeconds = DEFAULT_RECENT_MFA_MAX_AGE_SECONDS,
): MethodDecorator & ClassDecorator {
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds <= 0) {
    throw new RangeError('Recent MFA maxAgeSeconds must be a positive integer');
  }
  return SetMetadata(RECENT_MFA_MAX_AGE_SECONDS, maxAgeSeconds);
}

interface MfaRequest {
  user?: JwtUser;
}

/**
 * Global metadata guard for privileged step-up operations.
 *
 * The trusted facts are only those PlatformAdminGuard (or another verified JWT
 * boundary) placed on request.user. Request bodies and headers are never read.
 * Method metadata overrides class metadata through Nest's canonical reflector
 * semantics, while an absent decorator leaves the route unchanged.
 */
@Injectable()
export class RecentMfaGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const maxAgeSeconds = this.reflector.getAllAndOverride<number | undefined>(
      RECENT_MFA_MAX_AGE_SECONDS,
      [context.getHandler(), context.getClass()],
    );
    if (maxAgeSeconds === undefined) {
      return true;
    }

    const user = this.requestOf(context).user;
    if (user?.mfaVerified !== true) {
      this.reject('MFA_STEP_UP_REQUIRED', 'Recent MFA verification is required');
    }

    const issuedAt = user.iat;
    if (typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || issuedAt <= 0) {
      this.reject('MFA_STEP_UP_AGE_UNVERIFIABLE', 'MFA verification age cannot be verified');
    }

    const ageSeconds = Math.floor(Date.now() / 1000) - issuedAt;
    if (ageSeconds < -MAX_FUTURE_CLOCK_SKEW_SECONDS) {
      this.reject('MFA_STEP_UP_AGE_UNVERIFIABLE', 'MFA verification age cannot be verified');
    }
    if (ageSeconds > maxAgeSeconds) {
      this.reject('MFA_STEP_UP_EXPIRED', 'MFA verification is no longer recent');
    }
    return true;
  }

  private requestOf(context: ExecutionContext): MfaRequest {
    if (context.getType<string>() === 'graphql') {
      return GqlExecutionContext.create(context).getContext<{ req: MfaRequest }>().req;
    }
    return context.switchToHttp().getRequest<MfaRequest>();
  }

  private reject(code: string, message: string): never {
    throw new ForbiddenException({ code, message });
  }
}
