/**
 * PlatformCapabilityGuard — the third platform-admin guard (ADR-0016,
 * SEC-HIGH-059).
 *
 * Runs on every request the authentication guard has already admitted. A
 * handler that carries `@RequiresCapability(...)` is allowed only when the
 * verified principal's `platformCapabilities` claim contains at least one of
 * the listed capabilities. A handler without the decorator is untouched, so
 * every admin GET stays admitted by the SUPER_ADMIN role alone (that is what
 * `platform-read-only` means).
 *
 * The guard reads the claim the authentication guard copied from the JWT; it
 * never looks anything up. Revocation is therefore the token lifecycle's job:
 * auth-service revokes the refresh tokens and advances the durable
 * invalidation epoch on every grant or revoke, so a stale claim dies with its
 * token (ADR-0016 rejects both a per-request DB hop and an unrevocable pure-JWT
 * design).
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GqlExecutionContext } from '@nestjs/graphql';
import { toPlatformCapabilities, type PlatformCapability } from '@platform/event-contracts';

import { PLATFORM_CAPABILITY_KEY } from '../decorators/requires-capability.decorator';

/** The claims the guard reads; the admin-api request user satisfies it. */
export interface CapabilityActor {
  sub?: string;
  platformCapabilities?: string[];
}

interface RequestWithActor {
  user?: CapabilityActor;
}

@Injectable()
export class PlatformCapabilityGuard implements CanActivate {
  constructor(@Inject(Reflector) private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType<string>() === 'rpc') {
      // NATS handlers are authenticated by the broker-verified client-cert CN
      // (ADR-015); there is no principal and no capability claim on that surface.
      return true;
    }
    const required = this.reflector.getAllAndOverride<PlatformCapability[] | undefined>(
      PLATFORM_CAPABILITY_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const user = this.request(context).user;
    if (!user) {
      // A capability check on an anonymous request means the authentication
      // guard did not run or did not admit; never decide authorisation here.
      throw new UnauthorizedException(
        'Capability-gated operations require an authenticated principal',
      );
    }

    const held = new Set(toPlatformCapabilities(user.platformCapabilities));
    if (required.some((capability) => held.has(capability))) return true;

    throw new ForbiddenException(
      `This operation requires the ${required.map((c) => `'${c}'`).join(' or ')} platform capability`,
    );
  }

  private request(context: ExecutionContext): RequestWithActor {
    if (context.getType<string>() === 'graphql') {
      return GqlExecutionContext.create(context).getContext<{ req: RequestWithActor }>().req;
    }
    return context.switchToHttp().getRequest<RequestWithActor>();
  }
}
