import {
  signedFetch,
  signedFetchJson,
  type HttpFailureClass,
} from '@aquaculture/backend-common/http';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import {
  alertRecipientQueryPath,
  checkAlertRecipientResult,
  type AlertRecipientQuery,
  type AlertRecipientResult,
} from '@platform/event-contracts';
import { Repository } from 'typeorm';

import { DeviceToken } from '../entities/device-token.entity';

/**
 * A directory lookup that failed, carrying whether a retry can help — the
 * event-bus `outcomeForError` believes a declared `failureClass`, so a caller
 * that rethrows this gets retry-vs-dead-letter right without re-deriving it.
 */
export class UserContactLookupError extends Error {
  constructor(
    message: string,
    readonly failureClass: HttpFailureClass,
  ) {
    super(message);
    this.name = 'UserContactLookupError';
  }
}

/**
 * The ONE place notification-service turns a tenant user id into something it
 * can deliver to (ALERT-CRITICAL-004).
 *
 * WHY: notification-service owns no user directory and must not grow one.
 * Push reachability is its own `device_tokens` (the AquaMobil registration it
 * owns); e-mail addresses and role/site membership belong to auth-service and
 * are read through auth's signed internal endpoints, bound to the tenant. The
 * command handler and the alarm handler both resolve through here, so the two
 * paths cannot drift on how a user is reached.
 */
@Injectable()
export class UserContactDirectory {
  private readonly authServiceUrl: string;

  constructor(
    @InjectRepository(DeviceToken)
    private readonly deviceTokenRepository: Repository<DeviceToken>,
    configService: ConfigService,
  ) {
    this.authServiceUrl = configService
      .get<string>('AUTH_SERVICE_INTERNAL_URL', 'http://auth-service:3000')
      .replace(/\/+$/, '');
  }

  /** The user's most recently seen device token in this tenant, or null. */
  async latestPushToken(tenantId: string, userId: string): Promise<string | null> {
    const deviceToken = await this.deviceTokenRepository.findOne({
      where: { tenantId, userId },
      order: { lastSeenAt: 'DESC', createdAt: 'DESC' },
    });
    return deviceToken ? deviceToken.token : null;
  }

  /** The user's e-mail from auth-service (tenant-bound PII endpoint). */
  async email(tenantId: string, userId: string): Promise<string> {
    const response = await signedFetch(
      `${this.authServiceUrl}/api/v1/internal/users/${encodeURIComponent(userId)}/pii`,
      {
        method: 'GET',
        serviceName: 'notification-service',
        tenantId,
        audience: 'auth-service',
        headers: { 'content-type': 'application/json' },
      },
    );
    if (!response.ok) {
      throw new UserContactLookupError(
        `Unable to resolve user email recipient: HTTP ${response.status}`,
        response.status >= 500 ? 'transient' : 'permanent',
      );
    }
    const body = (await response.json()) as { email?: string };
    if (!body.email) {
      throw new UserContactLookupError('Resolved user recipient has no email', 'permanent');
    }
    return body.email;
  }

  /**
   * Expand an alarm's role/site/user targets into active tenant user ids via
   * auth-service. The reply is validated against the shared contract schema —
   * anything but ids is refused, so PII cannot leak in through this surface.
   */
  async alertRecipients(
    tenantId: string,
    query: AlertRecipientQuery,
  ): Promise<AlertRecipientResult> {
    const result = await signedFetchJson<unknown>(
      `${this.authServiceUrl}${alertRecipientQueryPath(tenantId)}`,
      {
        method: 'POST',
        serviceName: 'notification-service',
        tenantId,
        audience: 'auth-service',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(query),
      },
    );
    if (!result.ok) {
      throw new UserContactLookupError(
        `Alert recipient expansion failed: ${result.error}`,
        result.failureClass,
      );
    }
    const checked = checkAlertRecipientResult(result.body);
    if (!checked.ok) {
      throw new UserContactLookupError(
        `Alert recipient expansion returned an invalid body: ${checked.reason}`,
        'permanent',
      );
    }
    return checked.value;
  }
}
