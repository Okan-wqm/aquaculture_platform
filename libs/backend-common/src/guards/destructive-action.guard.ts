/**
 * DestructiveActionGuard — an irreversible operation needs a fresh MFA claim
 * (ADR-0011, SEC-CRITICAL-058). Installed by `@Destructive()`; never
 * registered by hand.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';

import {
  isMfaClaimFresh,
  readMfaFreshnessSeconds,
  readPlatformAdminMfaPolicy,
} from '../security/platform-admin-mfa-policy';

export const DESTRUCTIVE_KEY = 'aquaculture:destructive';

export interface DestructiveMetadata {
  readonly requiresFreshMfa: boolean;
  readonly reason: string | null;
}

/** The claims the guard reads; every JWT payload on the platform satisfies it. */
export interface DestructiveActor {
  sub?: string;
  id?: string;
  mfaVerified?: boolean;
  /** JWT issue time (epoch seconds) — the freshness anchor of the MFA claim. */
  iat?: number;
}

interface RequestWithActor {
  user?: DestructiveActor;
  method?: string;
  originalUrl?: string;
  url?: string;
}

/** Minimal sink for the security event the guard emits — SecurityEventService satisfies it. */
export interface DestructiveEventSink {
  recordDestructiveWithoutFreshMfa(event: {
    userId: string | null;
    route: string;
    reason: string | null;
    enforced: boolean;
  }): void | Promise<void>;
}

export const DESTRUCTIVE_EVENT_SINK = Symbol.for('aquaculture.destructive-event-sink');

@Injectable()
export class DestructiveActionGuard implements CanActivate {
  private readonly logger = new Logger(DestructiveActionGuard.name);

  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Optional() @Inject(DESTRUCTIVE_EVENT_SINK) private readonly events?: DestructiveEventSink,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const metadata = this.reflector.getAllAndOverride<DestructiveMetadata | undefined>(
      DESTRUCTIVE_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!metadata) return true;

    const request = this.request(context);
    const user = request.user;
    if (!user) {
      // A destructive operation is never anonymous; the authentication guard
      // must have run first.
      throw new UnauthorizedException('Irreversible operations require an authenticated principal');
    }
    if (!metadata.requiresFreshMfa) return true;

    const policy = readPlatformAdminMfaPolicy();
    const fresh = isMfaClaimFresh(user.mfaVerified === true, user.iat, readMfaFreshnessSeconds());
    if (fresh) return true;

    const route = `${request.method ?? ''} ${request.originalUrl ?? request.url ?? ''}`.trim();
    const userId = user.sub ?? user.id ?? null;
    await this.events?.recordDestructiveWithoutFreshMfa({
      userId,
      route,
      reason: metadata.reason,
      enforced: policy.enforced,
    });
    if (!policy.enforced) {
      this.logger.warn(
        JSON.stringify({
          event: 'destructive_without_fresh_mfa',
          mode: policy.mode,
          route,
          reason: metadata.reason,
        }),
      );
      return true;
    }
    throw new ForbiddenException(
      'This operation is irreversible and requires a fresh MFA verification (mfaStepUp) before it can proceed',
    );
  }

  private request(context: ExecutionContext): RequestWithActor {
    if (context.getType<string>() === 'graphql') {
      return GqlExecutionContext.create(context).getContext<{ req: RequestWithActor }>().req;
    }
    return context.switchToHttp().getRequest<RequestWithActor>();
  }
}
