import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  CONFIG_RUNTIME_KEYS,
  CONFIG_RUNTIME_SERVICE,
  CONFIG_RUNTIME_SUBJECTS,
  CONFIG_RUNTIME_SYSTEM_TENANT_ID,
  canonicalConfigRuntimeBody,
  type ConfigRuntimeGetRequest,
  type ConfigRuntimeResult,
} from '@platform/event-contracts';
import { catchError, firstValueFrom, throwError, timeout } from 'rxjs';

// Relative deep import mirrors the sibling service-identity.util / signed-http-client
// (same lib, same depth) — the service-catalog lib has zero imports of its own, so
// this adds no new cross-lib edge and cannot form a cycle.
import { serviceIdentityAudienceForService } from '../../../../platform/libs/service-catalog/src/index';
import { buildSignedInternalHeaders } from '../http/signed-http-client';

/**
 * DI token + injectable config for the config-runtime NATS ClientProxy the
 * ConfigRuntimeClient wraps.
 */
export const CONFIG_NATS_CLIENT = 'CONFIG_NATS_CLIENT';
export const CONFIG_RUNTIME_CONSUMER_SERVICE = 'CONFIG_RUNTIME_CONSUMER_SERVICE';

const DEFAULT_CONFIG_RUNTIME_TIMEOUT_MS = 5_000;

/**
 * Effective Stripe settings assembled from the three platform config rows.
 * `secretKey` is present ONLY when the operator saved a real secret AND billing
 * is enabled; it is held transiently by the caller and never persisted/logged.
 */
export interface BillingStripeSettings {
  enabled: boolean;
  publicKey: string | null;
  secretKey: string | null;
}

/**
 * ConfigRuntimeClient — the trusted read path to config-service's effective
 * configuration over core-NATS request-reply.
 *
 * Reusable primitive (first consumer: billing-service). Every request is
 * ServiceIdentity HMAC-v2 signed via the canonical `buildSignedInternalHeaders`
 * so config-service can verify the caller, bind the exact (subject, body), and
 * — for the secret path — enforce a per-caller key allowlist. The signature is
 * carried inside the NATS payload because core-NATS request-reply has no HTTP
 * header channel; the byte-stable `canonicalConfigRuntimeBody` keeps the
 * sender/receiver bodyHash in lock-step.
 */
@Injectable()
export class ConfigRuntimeClient {
  private readonly logger = new Logger(ConfigRuntimeClient.name);
  private readonly timeoutMs: number;
  private readonly audience: string | undefined;

  constructor(
    @Inject(CONFIG_NATS_CLIENT) private readonly client: ClientProxy,
    @Inject(CONFIG_RUNTIME_CONSUMER_SERVICE)
    private readonly consumerService: string,
  ) {
    const configured = Number.parseInt(process.env['CONFIG_RUNTIME_TIMEOUT_MS'] ?? '', 10);
    this.timeoutMs =
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_CONFIG_RUNTIME_TIMEOUT_MS;
    // config-service is the receiver — bind its audience into the signature so a
    // captured signature cannot be replayed at a different receiver.
    this.audience = serviceIdentityAudienceForService('config-service');
  }

  /**
   * Read a non-secret effective value. Returns `defaultValue` when the row is
   * absent (or the caller is not allowed — the reply is uniform fail-closed).
   */
  async getString(
    service: string,
    key: string,
    defaultValue: string | null = null,
  ): Promise<string | null> {
    const result = await this.request(CONFIG_RUNTIME_SUBJECTS.GET, service, key);
    return result.found ? result.value : defaultValue;
  }

  /** Read a non-secret boolean value ('true'/'1' → true). */
  async getBoolean(service: string, key: string, defaultValue: boolean): Promise<boolean> {
    const raw = await this.getString(service, key, null);
    if (raw === null) return defaultValue;
    return raw === 'true' || raw === '1';
  }

  /**
   * Read a decrypted secret over the trusted GET_SECRET subject. `found:false`
   * when the row is absent OR the caller/key is not on config-service's
   * allowlist — the two are indistinguishable by design (no oracle).
   */
  async getSecret(service: string, key: string): Promise<ConfigRuntimeResult> {
    return this.request(CONFIG_RUNTIME_SUBJECTS.GET_SECRET, service, key);
  }

  /**
   * Convenience: assemble the effective Stripe settings from the three platform
   * rows. `enabled` + `publicKey` go over the non-secret GET path; `secretKey`
   * over the trusted GET_SECRET path. Runs the three reads in parallel.
   */
  async getBillingStripeSettings(): Promise<BillingStripeSettings> {
    const [enabled, publicKey, secret] = await Promise.all([
      this.getBoolean(CONFIG_RUNTIME_SERVICE, CONFIG_RUNTIME_KEYS.STRIPE_ENABLED, false),
      this.getString(CONFIG_RUNTIME_SERVICE, CONFIG_RUNTIME_KEYS.STRIPE_PUBLIC_KEY, null),
      this.getSecret(CONFIG_RUNTIME_SERVICE, CONFIG_RUNTIME_KEYS.STRIPE_SECRET_KEY),
    ]);
    return {
      enabled,
      publicKey,
      secretKey: secret.found ? secret.value : null,
    };
  }

  private async request(
    subject: string,
    service: string,
    key: string,
  ): Promise<ConfigRuntimeResult> {
    const body = canonicalConfigRuntimeBody(service, key);
    // Sign the exact subject+body so config-service's verifier binds this
    // operation. tenantId = the system tenant that owns platform config.
    const identity = buildSignedInternalHeaders({
      serviceName: this.consumerService,
      tenantId: CONFIG_RUNTIME_SYSTEM_TENANT_ID,
      method: 'POST',
      path: subject,
      body,
      audience: this.audience,
    });
    const payload: ConfigRuntimeGetRequest = { service, key, identity };
    try {
      return await firstValueFrom(
        this.client.send<ConfigRuntimeResult, ConfigRuntimeGetRequest>(subject, payload).pipe(
          timeout(this.timeoutMs),
          catchError((err: Error) => throwError(() => err)),
        ),
      );
    } catch (err: unknown) {
      // Fail-closed: an unreachable/slow config-service yields "not found" so the
      // caller falls back to its safe default (never a crash, never a leak). The
      // key is safe to log (it is not the secret VALUE); the value never is.
      this.logger.warn(
        `config-runtime ${subject} for ${service}/${key} failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { found: false, value: null };
    }
  }
}
