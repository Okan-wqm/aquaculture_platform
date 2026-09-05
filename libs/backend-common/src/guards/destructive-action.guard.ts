/**
 * DestructiveActionGuard — an irreversible operation needs a fresh MFA claim
 * (ADR-0011, SEC-CRITICAL-058) and the time-boxed `break-glass` capability
 * (ADR-0016, SEC-HIGH-059). Installed by `@Destructive()`; never registered
 * by hand.
 *
 * Both step-up controls follow the single platform switch
 * (`SUPER_ADMIN_MFA_ENFORCED_AT`): in detective mode a shortfall is recorded
 * as a security event and the operation proceeds; once the switch has passed
 * it is refused. One switch, so the operator reads one detective ledger before
 * choosing one date.
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
import { toPlatformCapabilities } from '@platform/event-contracts';

import {
  isMfaClaimFresh,
  readMfaFreshnessSeconds,
  readPlatformAdminMfaPolicy,
} from '../security/platform-admin-mfa-policy';

export const DESTRUCTIVE_KEY = 'aquaculture:destructive';

export interface DestructiveMetadata {
  readonly requiresFreshMfa: boolean;
  readonly requiresBreakGlass: boolean;
  readonly reason: string | null;
}

/** The claims the guard reads; every JWT payload on the platform satisfies it. */
export interface DestructiveActor {
  sub?: string;
  id?: string;
  mfaVerified?: boolean;
  /** JWT issue time (epoch seconds) — the freshness anchor of the MFA claim. */
  iat?: number;
  /** ADR-0016 capability claim; `break-glass` is the one an irreversible operation needs. */
  platformCapabilities?: string[];
}

interface RequestWithActor {
  user?: DestructiveActor;
  method?: string;
  originalUrl?: string;
  url?: string;
}

/** Which step-up control the principal lacked. */
export type DestructiveShortfall = 'fresh_mfa' | 'break_glass';

export interface DestructiveShortfallEvent {
  userId: string | null;
  route: string;
  reason: string | null;
  shortfall: DestructiveShortfall;
  enforced: boolean;
}

/** Minimal sink for the security event the guard emits — admin-api binds it to its audit ledger. */
export interface DestructiveEventSink {
  recordDestructiveShortfall(event: DestructiveShortfallEvent): void | Promise<void>;
}

export const DESTRUCTIVE_EVENT_SINK = Symbol.for('aquaculture.destructive-event-sink');

const SHORTFALL_MESSAGE: Record<DestructiveShortfall, string> = {
  fresh_mfa: 'a fresh MFA verification (mfaStepUp)',
  break_glass: "a live 'break-glass' capability grant",
};

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

    const shortfalls: DestructiveShortfall[] = [];
    if (
      metadata.requiresFreshMfa &&
      !isMfaClaimFresh(user.mfaVerified === true, user.iat, readMfaFreshnessSeconds())
    ) {
      shortfalls.push('fresh_mfa');
    }
    if (
      metadata.requiresBreakGlass &&
      !toPlatformCapabilities(user.platformCapabilities).includes('break-glass')
    ) {
      shortfalls.push('break_glass');
    }
    if (shortfalls.length === 0) return true;

    const policy = readPlatformAdminMfaPolicy();
    const route = `${request.method ?? ''} ${request.originalUrl ?? request.url ?? ''}`.trim();
    const userId = user.sub ?? user.id ?? null;
    for (const shortfall of shortfalls) {
      await this.events?.recordDestructiveShortfall({
        userId,
        route,
        reason: metadata.reason,
        shortfall,
        enforced: policy.enforced,
      });
    }
    if (!policy.enforced) {
      this.logger.warn(
        JSON.stringify({
          event: 'destructive_step_up_shortfall',
          mode: policy.mode,
          shortfalls,
          route,
          reason: metadata.reason,
        }),
      );
      return true;
    }
    throw new ForbiddenException(
      `This operation is irreversible and requires ${shortfalls
        .map((s) => SHORTFALL_MESSAGE[s])
        .join(' and ')} before it can proceed`,
    );
  }

  private request(context: ExecutionContext): RequestWithActor {
    if (context.getType<string>() === 'graphql') {
      return GqlExecutionContext.create(context).getContext<{ req: RequestWithActor }>().req;
    }
    return context.switchToHttp().getRequest<RequestWithActor>();
  }
}
