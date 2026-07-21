import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  AUTH_ADMIN_COMMAND_SUBJECTS,
  type AdminCheckUserLimitQuery,
  type AdminCheckUserLimitResult,
  type AdminInviteUserCommand,
  type AdminInviteUserResult,
  type InvitableRoleCode,
} from '@platform/event-contracts';
import { catchError, firstValueFrom, throwError, timeout } from 'rxjs';

/**
 * Default NATS request timeout when AUTH_NATS_TIMEOUT_MS is not configured.
 * 15s matches the messaging-admin NATS client and leaves headroom for
 * the auth-service `adminInviteUser` transaction (multi-row write +
 * tenant counter increment).
 */
const DEFAULT_AUTH_NATS_TIMEOUT_MS = 15_000;

export interface UserLimitCheckResult {
  canCreate: boolean;
  currentCount: number;
  limit: number;
  remaining: number;
  message?: string;
}

export interface InviteUserDto {
  tenantId: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role: InvitableRoleCode;
  moduleIds?: string[];
  primaryModuleId?: string;
  invitedBy: string;
  message?: string;
  sendInvitation?: boolean;
}

export interface InviteUserResult {
  success: boolean;
  userId?: string;
  invitationId?: string;
  deliveryStatus?: 'queued';
  error?: string;
}

@Injectable()
export class UserProvisioningService {
  private readonly logger = new Logger(UserProvisioningService.name);

  private readonly authNatsTimeoutMs: number;

  constructor(
    @Inject('AUTH_NATS_CLIENT')
    private readonly authNatsClient: ClientProxy,
  ) {
    const configured = parseInt(process.env['AUTH_NATS_TIMEOUT_MS'] ?? '', 10);
    this.authNatsTimeoutMs = Number.isFinite(configured) && configured > 0
      ? configured
      : DEFAULT_AUTH_NATS_TIMEOUT_MS;
  }

  /**
   * Check if a tenant can add more users.
   *
   * Delegates to auth-service over NATS (see AuthAdminNatsHandler). The
   * previous raw-SQL path read `auth.tenants.user_count` directly and a
   * stale `t.limits->>'maxUsers'` JSON path that no longer matches the
   * Tenant entity (the entity exposes `maxUsers` as a top-level int
   * column). admin-api now never names the columns; auth-service computes
   * the snapshot from the authoritative User row count, so the
   * denormalised counter cannot drift.
   *
   * CRITICAL-005 (docs/reviews/code-reviewer/2026-04-21-raw-sql-audit.md
   * finding #4) — service-boundary violation + JSON-path drift, fixed
   * here together with `inviteUser`.
   */
  async checkUserLimit(tenantId: string): Promise<UserLimitCheckResult> {
    const query: AdminCheckUserLimitQuery = { tenantId };
    const result = await this.sendAuthCommand<
      AdminCheckUserLimitQuery,
      AdminCheckUserLimitResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.CHECK_USER_LIMIT, query);

    if (!result.success) {
      // The REST controller treats "tenant not found" as a non-throwing
      // soft-fail (returns canCreate:false with a message), matching the
      // pre-existing contract. Other errors propagate as HTTP exceptions.
      if (result.errorCode === 'TENANT_NOT_FOUND') {
        return {
          canCreate: false,
          currentCount: 0,
          limit: 0,
          remaining: 0,
          message: result.error ?? 'Tenant not found',
        };
      }
      throw this.mapCheckUserLimitError(result);
    }

    return {
      canCreate: result.canCreate ?? false,
      currentCount: result.currentCount ?? 0,
      limit: result.limit ?? 0,
      remaining: result.remaining ?? 0,
      message: result.message,
    };
  }

  /**
   * Invite a new user to a tenant.
   *
   * Delegates to auth-service over NATS. The previous raw-SQL path:
   *   - Mutated the auth user table with snake-case fields such as
   *     first_name, is_active, and invitation_token — every snake-case
   *     column name DRIFTED from the User entity, which uses default
   *     camelCase column names. This was the same drift class that
   *     CRITICAL-001 fixed for `passwordHash`/`password`.
   *   - Mutated the auth user-module assignment table with permission columns
   *     such as can_read/can_write/can_delete/can_manage — those columns DO NOT
   *     EXIST on the entity at all (the entity has `permissions` jsonb
   *     + `isPrimaryManager`). Code path would crash at runtime.
   *   - Did three independent INSERTs + an UPDATE in a transaction, but
   *     across services without authoritative ownership.
   *
   * The NATS delegation centralises every write on the schema-owning
   * service (auth-service) where the entities ARE the contract. Drift
   * in this class of bug is now structurally impossible — admin-api
   * never names a column, and auth-service writes via repository.save()
   * which uses the entity's own column metadata.
   */
  async inviteUser(dto: InviteUserDto): Promise<InviteUserResult> {
    const command: AdminInviteUserCommand = {
      tenantId: dto.tenantId,
      email: dto.email,
      ...(dto.firstName !== undefined && { firstName: dto.firstName }),
      ...(dto.lastName !== undefined && { lastName: dto.lastName }),
      role: dto.role,
      ...(dto.moduleIds !== undefined && { moduleIds: dto.moduleIds }),
      ...(dto.primaryModuleId !== undefined && {
        primaryModuleId: dto.primaryModuleId,
      }),
      invitedBy: dto.invitedBy,
      ...(dto.message !== undefined && { message: dto.message }),
      sendInvitation: dto.sendInvitation !== false,
    };

    const result = await this.sendAuthCommand<
      AdminInviteUserCommand,
      AdminInviteUserResult
    >(AUTH_ADMIN_COMMAND_SUBJECTS.INVITE_USER, command);

    if (!result.success) {
      // The REST contract this service exposes returns
      // `{ success: false, error }` for domain failures rather than
      // throwing, so the controller layer can render them inline.
      // Infrastructure-class errors (timeout / unavailable) DO throw —
      // they are handled by sendAuthCommand directly.
      return {
        success: false,
        error: this.formatInviteError(result),
      };
    }

    // SECURITY: log user ID + tenant ID, never email (PII).
    this.logger.log(
      `User invited userId=${result.userId} tenantId=${dto.tenantId}`,
    );
    return {
      success: true,
      userId: result.userId,
      invitationId: result.invitationId,
      deliveryStatus: result.deliveryStatus,
    };
  }

  // ==========================================================================
  // NATS delegation helpers
  // ==========================================================================

  /**
   * Send a request-reply to auth-service via the shared NATS client.
   * Mirrors the error-translation pattern in `UsersService.sendAuthCommand`
   * (timeouts → 504, connection issues → 503).
   */
  private async sendAuthCommand<TCommand, TResult>(
    subject: string,
    command: TCommand,
  ): Promise<TResult> {
    try {
      return await firstValueFrom(
        this.authNatsClient.send<TResult, TCommand>(subject, command).pipe(
          timeout(this.authNatsTimeoutMs),
          catchError((err: Error) => {
            this.logger.error(
              `NATS request failed: subject=${subject}, error=${err.message}`,
            );
            return throwError(() => err);
          }),
        ),
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('Timeout')) {
        throw new HttpException(
          `Auth service did not respond within ${this.authNatsTimeoutMs}ms`,
          HttpStatus.GATEWAY_TIMEOUT,
        );
      }
      if (message.includes('not connected') || message.includes('CONN_CLOSED')) {
        throw new ServiceUnavailableException(
          'Auth service is currently unavailable',
        );
      }
      if (err instanceof HttpException) throw err;
      throw new HttpException(
        `Auth service error: ${message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /**
   * Map an `AdminInviteUserResult` failure code into a stable, human-
   * readable string. Domain-level failures are surfaced through the
   * `{ success: false, error }` envelope this service has historically
   * returned; the controller renders the message inline.
   */
  private formatInviteError(result: AdminInviteUserResult): string {
    const fallback = result.error ?? 'Failed to invite user';
    switch (result.errorCode) {
      case 'USER_LIMIT_REACHED':
      case 'DUPLICATE_EMAIL':
      case 'ROLE_VALIDATION_FAILED':
      case 'INVALID_ROLE':
      case 'VALIDATION_ERROR':
      case 'TENANT_NOT_FOUND':
      case 'INVITER_NOT_FOUND':
        return fallback;
      case 'INTERNAL_ERROR':
      default:
        return fallback;
    }
  }

  /**
   * Translate non-soft-fail `AdminCheckUserLimitResult` failures into the
   * REST exception the controller layer expects.
   */
  private mapCheckUserLimitError(
    result: AdminCheckUserLimitResult,
  ): HttpException {
    const msg = result.error ?? 'Failed to check user limit';
    switch (result.errorCode) {
      case 'TENANT_NOT_FOUND':
        return new NotFoundException(msg);
      case 'INTERNAL_ERROR':
      default:
        return new InternalServerErrorException(msg);
    }
  }
}
