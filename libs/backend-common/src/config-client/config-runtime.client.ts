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
  /**
   * Whether config-service actually RESPONDED. Distinguishes "reachable +
   * deliberately disabled" (operator turned Stripe off) from "unreachable"
   * (transport failure) — the DynamicStripeClientProvider needs the difference
   * to avoid a silent warm-degradation of a live-billing tenant (ARCH-HIGH-002).
   */
  reachable: boolean;
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
    try {
      const result = await this.send(CONFIG_RUNTIME_SUBJECTS.GET, service, key);
      return result.found ? result.value : defaultValue;
    } catch {
      return defaultValue;
    }
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
   * allowlist OR config-service is unreachable — all indistinguishable by design
   * (no oracle; fail-closed).
   */
  async getSecret(service: string, key: string): Promise<ConfigRuntimeResult> {
    try {
      return await this.send(CONFIG_RUNTIME_SUBJECTS.GET_SECRET, service, key);
    } catch {
      return { found: false, value: null };
    }
  }

  /**
   * Convenience: assemble the effective Stripe settings from the three platform
   * rows, carrying whether config-service actually responded (`reachable`).
   *
   * The `enabled` read doubles as the reachability probe: a transport error
   * there marks the whole result unreachable so the provider can tell a
   * deliberate operator-disable (reachable) from an outage (unreachable) and
   * never silently downgrade a live-billing tenant.
   */
  async getBillingStripeSettings(): Promise<BillingStripeSettings> {
    let enabled = false;
    try {
      const r = await this.send(
        CONFIG_RUNTIME_SUBJECTS.GET,
        CONFIG_RUNTIME_SERVICE,
        CONFIG_RUNTIME_KEYS.STRIPE_ENABLED,
      );
      enabled = r.found && (r.value === 'true' || r.value === '1');
    } catch (err) {
      this.logger.warn(
        `config-runtime unreachable (stripe_enabled probe): ${err instanceof Error ? err.message : String(err)}`,
      );
      return { enabled: false, publicKey: null, secretKey: null, reachable: false };
    }

    // config-service responded — the remaining reads swallow (fail-closed) but
    // reachability is already established by the probe above.
    const [publicKey, secret] = await Promise.all([
      this.getString(CONFIG_RUNTIME_SERVICE, CONFIG_RUNTIME_KEYS.STRIPE_PUBLIC_KEY, null),
      this.getSecret(CONFIG_RUNTIME_SERVICE, CONFIG_RUNTIME_KEYS.STRIPE_SECRET_KEY),
    ]);
    return {
      enabled,
      publicKey,
      secretKey: secret.found ? secret.value : null,
      reachable: true,
    };
  }

  /**
   * Issue one signed request. Resolves with the handler's `{found,value}` reply
   * (including a legitimate not-found / denial); THROWS only on a transport
   * failure (timeout / no responder / connection closed) so callers can
   * distinguish "unreachable" from "handler said no".
   */
  private async send(subject: string, service: string, key: string): Promise<ConfigRuntimeResult> {
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
    return firstValueFrom(
      this.client.send<ConfigRuntimeResult, ConfigRuntimeGetRequest>(subject, payload).pipe(
        timeout(this.timeoutMs),
        catchError((err: Error) => throwError(() => err)),
      ),
    );
  }
}
