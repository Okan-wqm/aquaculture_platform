import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import { firstValueFrom, timeout } from 'rxjs';
import {
  AUTH_USER_QUERY_SUBJECTS,
  RESOLVE_USER_IDS_BY_EMAIL_MAX,
  validateResolveTenantUserIdsByEmailResultSchema,
  type ResolveTenantUserIdsByEmailQuery,
} from '@platform/event-contracts';

import { isUserIdRecipient } from './rule-targets';

/** DI token of alert-engine's NATS client for auth-service user queries. */
export const ALERT_AUTH_NATS_CLIENT = 'ALERT_AUTH_NATS_CLIENT';

const RESOLVE_TIMEOUT_MS = 2500;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The outcome of normalising one recipient list. */
export interface NormalizedRecipients {
  recipients: string[];
  /** Raw e-mail addresses replaced by the user id they belong to. */
  replaced: number;
}

/**
 * Normalises a sensor rule's recipients (decision 7).
 *
 * WHY: a rule names its recipients as free text — user ids OR e-mail
 * addresses. People are paged by the incident's escalation (by user id); raw
 * addresses are the rule's external targets, e-mailed from `AlertTriggered`.
 * A colleague named by e-mail would be reached TWICE — once as a user by the
 * escalation, once as an address. Storing that address as the user's id makes
 * every person a user id, so each is paged exactly once.
 *
 * WHAT: e-mail recipients that belong to an ACTIVE user of the tenant (asked
 * of auth-service, the directory's owner, over the cert-identified NATS query)
 * become that user's id; every other recipient is kept verbatim (a user id, an
 * outside address, a phone number, a webhook URL). The API and the web form
 * still accept "e-posta adresleri veya kullanıcı ID'leri" — nothing is refused.
 *
 * Fail-closed on the write path: an unreachable directory refuses the write
 * (503) rather than storing an address that may double-page someone. The
 * backfill reconcile reports and retries instead.
 */
@Injectable()
export class RuleRecipientNormalizer {
  private readonly logger = new Logger(RuleRecipientNormalizer.name);

  constructor(
    @Inject(ALERT_AUTH_NATS_CLIENT)
    private readonly natsClient: Pick<ClientProxy, 'send'>,
  ) {}

  async normalize(tenantId: string, recipients: readonly string[]): Promise<NormalizedRecipients> {
    const emails = Array.from(
      new Set(
        recipients
          .map((recipient) => recipient.trim())
          .filter((recipient) => !isUserIdRecipient(recipient) && EMAIL.test(recipient))
          .map((email) => email.toLowerCase()),
      ),
    );
    if (emails.length === 0) {
      return { recipients: [...recipients], replaced: 0 };
    }

    const userIdByEmail = new Map<string, string>();
    for (let offset = 0; offset < emails.length; offset += RESOLVE_USER_IDS_BY_EMAIL_MAX) {
      const batch = emails.slice(offset, offset + RESOLVE_USER_IDS_BY_EMAIL_MAX);
      for (const match of await this.resolve(tenantId, batch)) {
        userIdByEmail.set(match.email.toLowerCase(), match.userId);
      }
    }

    let replaced = 0;
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const recipient of recipients) {
      const trimmed = recipient.trim();
      const userId = userIdByEmail.get(trimmed.toLowerCase());
      const value = userId ?? trimmed;
      if (userId !== undefined) replaced++;
      if (seen.has(value)) continue;
      seen.add(value);
      normalized.push(value);
    }
    return { recipients: normalized, replaced };
  }

  private async resolve(
    tenantId: string,
    emails: string[],
  ): Promise<Array<{ email: string; userId: string }>> {
    const query: ResolveTenantUserIdsByEmailQuery = { tenantId, emails };
    let reply: unknown;
    try {
      reply = await firstValueFrom(
        this.natsClient
          .send<
            unknown,
            ResolveTenantUserIdsByEmailQuery
          >(AUTH_USER_QUERY_SUBJECTS.RESOLVE_TENANT_USER_IDS_BY_EMAIL, query)
          .pipe(timeout(RESOLVE_TIMEOUT_MS)),
      );
    } catch (error) {
      this.logger.warn(
        `Recipient normalisation unavailable for tenant ${tenantId.substring(0, 8)}...: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ServiceUnavailableException('Unable to resolve rule recipients');
    }
    // The reply is a trust boundary: ids only, schema-checked.
    if (!validateResolveTenantUserIdsByEmailResultSchema(reply) || !reply.success) {
      throw new ServiceUnavailableException('Unable to resolve rule recipients');
    }
    return reply.matches;
  }
}
