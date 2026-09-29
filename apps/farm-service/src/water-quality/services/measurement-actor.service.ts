import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import { Role, roleHasPermission } from '@aquaculture/backend-common/decorators';
import {
  AUTH_USER_QUERY_SUBJECTS,
  type ValidateTenantMembershipQuery,
  type ValidateTenantMembershipResult,
} from '@platform/event-contracts';

/** DI token of the farm-service NATS client used for auth-service queries. */
export const FARM_AUTH_NATS_CLIENT = 'FARM_AUTH_NATS_CLIENT';

const MEMBERSHIP_TIMEOUT_MS = 2500;

/** The authenticated caller, as the resolver threads it from the JWT. */
export interface MeasurementCaller {
  sub: string;
  roles: Role[];
}

/**
 * Who recorded a water-quality measurement (V-S1b-5).
 *
 * WHY: the `measuredBy` input was trusted verbatim, and it became the actor of
 * the life-safety `WaterQualityCritical` event, so any user could pin a
 * critical reading on somebody else. The event actor is now always the
 * authenticated caller (the resolver's `caller.sub`); `measuredBy` stays a data
 * field ("the reading was taken by …") that a supervisor may set for a
 * colleague.
 *
 * WHAT: no `measuredBy`, or the caller's own id → the caller. Any other id →
 * only MODULE_MANAGER+ may set it, and it must name an ACTIVE user of this
 * tenant, checked with auth-service (the user directory's owner) over the
 * cert-identified NATS membership query. Fail-closed: an unreachable directory
 * refuses the override instead of storing an unverified name.
 */
@Injectable()
export class MeasurementActorService {
  private readonly logger = new Logger(MeasurementActorService.name);

  constructor(
    @Inject(FARM_AUTH_NATS_CLIENT)
    private readonly natsClient: Pick<ClientProxy, 'send'>,
  ) {}

  async resolveMeasuredBy(
    tenantId: string,
    measuredBy: string | undefined,
    caller: MeasurementCaller,
  ): Promise<string> {
    if (measuredBy === undefined || measuredBy === caller.sub) {
      return caller.sub;
    }
    if (!caller.roles.some((role) => roleHasPermission(role, Role.MODULE_MANAGER))) {
      throw new ForbiddenException('Only a module manager can record a reading for another user');
    }

    const query: ValidateTenantMembershipQuery = {
      tenantId,
      userIds: [measuredBy],
      requireActive: true,
    };
    let result: ValidateTenantMembershipResult;
    try {
      result = await firstValueFrom(
        this.natsClient
          .send<
            ValidateTenantMembershipResult,
            ValidateTenantMembershipQuery
          >(AUTH_USER_QUERY_SUBJECTS.VALIDATE_TENANT_MEMBERSHIP, query)
          .pipe(timeout(MEMBERSHIP_TIMEOUT_MS)),
      );
    } catch (error) {
      this.logger.warn(
        `measuredBy membership check unavailable for tenant=${tenantId.substring(0, 8)}...: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException('Unable to verify measuredBy');
    }
    if (!result.success) {
      throw new ServiceUnavailableException('Unable to verify measuredBy');
    }
    if (!result.allValid) {
      throw new BadRequestException('measuredBy must name an active user of this tenant');
    }
    return measuredBy;
  }
}
