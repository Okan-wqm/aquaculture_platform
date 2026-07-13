import { createHash } from 'crypto';

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  ConfigRuntimeClient,
  type BillingStripeSettings,
} from '../config-client/config-runtime.client';
import { SecurityEventService } from '../security/security-event.service';

import {
  type IStripeApiClient,
  type StripeCustomer,
  type StripeIdempotencyKey,
  type StripeInvoice,
  type StripeMetadata,
  type StripeMeterEvent,
  type StripeRefund,
  type StripeSubscription,
} from './stripe-api.types';
import {
  buildClientFromDecision,
  classifyStripeSettings,
  stripeSettingsFromEnv,
  type StripeClientDecision,
  type StripeClientSettings,
} from './stripe-client.factory';

const DEFAULT_TTL_MS = 30_000;

interface StripeClientSnapshot {
  client: IStripeApiClient;
  /** Content hash of the settings that built `client` — identical config skips a rebuild. */
  contentHash: string;
  /** Wall-clock expiry; a resolve() past this refetches config. */
  expiresAt: number;
}

/**
 * DynamicStripeClientProvider — resolves the underlying IStripeApiClient from a
 * TTL-cached snapshot of config-service's effective Stripe settings, falling
 * back to the boot env when config says disabled/unreachable.
 *
 * # Precedence (config > env > mock/unconfigured)
 *   1. config `stripe_enabled=true` + secret present  → Real (sk_live_ rejected outside prod)
 *   2. config `stripe_enabled=true` + secret absent    → Unconfigured + WARN + SecurityEvent (boots)
 *   3. config `stripe_enabled=false`                   → ENV fallback (BILLING_PROVIDER/STRIPE_BILLING_ENABLED/STRIPE_SECRET_KEY)
 *   4. config unreachable                              → ENV fallback (getBillingStripeSettings fails closed to disabled)
 *   5. nothing configured                              → ENV default (mock on the droplet, else fail-closed Unconfigured)
 *
 * # Secret handling
 * The decrypted secret is held IN MEMORY ONLY, inside the built RealStripeClient
 * and transiently in the settings during a rebuild. It is NEVER written to Redis,
 * disk, or a log; the content hash stores sha256(secret), never the secret.
 *
 * # Runtime swap
 * StripeApiService caches the DynamicStripeClient injected at construction. Because
 * DynamicStripeClient is a thin delegator that calls `resolve()` per method, the
 * underlying client can swap (operator saves a key → ConfigurationChanged →
 * invalidate() → next call rebuilds) WITHOUT re-injecting anything.
 */
@Injectable()
export class DynamicStripeClientProvider {
  private readonly logger = new Logger(DynamicStripeClientProvider.name);
  private readonly ttlMs: number;
  private snapshot: StripeClientSnapshot | null = null;
  private refreshPromise: Promise<IStripeApiClient> | null = null;

  constructor(
    private readonly configRuntimeClient: ConfigRuntimeClient,
    private readonly configService: ConfigService,
    @Optional() private readonly securityEventService?: SecurityEventService,
  ) {
    const configured = Number.parseInt(process.env['BILLING_CONFIG_TTL_MS'] ?? '', 10);
    this.ttlMs = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TTL_MS;
  }

  /** Return the current underlying client, rebuilding from config when the snapshot is stale. */
  async resolve(): Promise<IStripeApiClient> {
    const now = Date.now();
    if (this.snapshot && now < this.snapshot.expiresAt) {
      return this.snapshot.client;
    }
    return this.refresh(now);
  }

  /**
   * Drop the cached snapshot so the next resolve() rebuilds immediately. Called
   * by the ConfigurationChanged handler when a `platform/billing.*` row changes.
   */
  invalidate(): void {
    this.snapshot = null;
    this.logger.log('Stripe client snapshot invalidated — next call rebuilds from config');
  }

  private async refresh(now: number): Promise<IStripeApiClient> {
    // Single-flight: concurrent resolves during a stale window share one config fetch.
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.doRefresh(now).finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async doRefresh(now: number): Promise<IStripeApiClient> {
    const { settings, source } = await this.resolveSettings();
    const contentHash = this.hashSettings(settings, source);

    // Config unchanged since last build → extend TTL, reuse the SAME client
    // (never rebuild the Stripe SDK for identical config).
    if (this.snapshot && this.snapshot.contentHash === contentHash) {
      this.snapshot = { ...this.snapshot, expiresAt: now + this.ttlMs };
      return this.snapshot.client;
    }

    let decision: StripeClientDecision;
    try {
      decision = classifyStripeSettings(settings);
    } catch (err) {
      // sk_live_ outside production — reject to a fail-closed client (never a
      // live key against a non-prod database) instead of throwing on every call.
      this.logger.error(
        `Stripe config rejected: ${err instanceof Error ? err.message : String(err)} — ` +
          'binding a fail-closed client (outbound billing will throw until corrected)',
      );
      void this.securityEventService?.publishSuspiciousActivity({
        description: 'stripe-config-rejected',
        reason: 'sk_live_-outside-production',
        source,
      });
      decision = { kind: 'unconfigured', reason: 'enabled-but-keyless' };
    }

    if (
      source === 'config' &&
      decision.kind === 'unconfigured' &&
      decision.reason === 'enabled-but-keyless'
    ) {
      // Operator enabled Stripe in the admin panel but no secret is present.
      this.logger.warn(
        'config-service reports billing.stripe_enabled=true but billing.stripe_secret_key ' +
          'is absent — binding a fail-closed Stripe client (boots; outbound billing calls ' +
          'throw StripeNotConfiguredError until the operator saves a secret key)',
      );
      void this.securityEventService?.publishSuspiciousActivity({
        description: 'stripe-enabled-but-keyless',
        reason: 'config-stripe_enabled-true-without-secret',
        source,
      });
    }

    const client = buildClientFromDecision(decision);
    this.snapshot = { client, contentHash, expiresAt: now + this.ttlMs };
    this.logger.log(
      `Stripe client rebuilt from ${source} config (decision=${decision.kind}` +
        (decision.kind === 'unconfigured' ? `/${decision.reason}` : '') +
        ')',
    );
    return client;
  }

  /**
   * Resolve the effective settings: config-service wins when it explicitly
   * enables billing; otherwise fall back to the boot env (which is mock on the
   * droplet). getBillingStripeSettings fails closed (enabled=false) on an
   * unreachable config-service, which also routes to the env fallback.
   */
  private async resolveSettings(): Promise<{
    settings: StripeClientSettings;
    source: 'config' | 'env';
  }> {
    let configSettings: BillingStripeSettings;
    try {
      configSettings = await this.configRuntimeClient.getBillingStripeSettings();
    } catch (err) {
      // getBillingStripeSettings already fails closed, but guard defensively.
      this.logger.warn(
        `config-service Stripe read failed (${err instanceof Error ? err.message : String(err)}) — env fallback`,
      );
      return { settings: stripeSettingsFromEnv(this.configService), source: 'env' };
    }

    if (configSettings.enabled) {
      // Config explicitly enables billing — config wins over env.
      return {
        settings: {
          provider: 'unset',
          billingEnabled: true,
          secretKey: configSettings.secretKey ?? undefined,
          isProduction: this.configService.get<string>('NODE_ENV') === 'production',
        },
        source: 'config',
      };
    }

    // Config disabled OR unreachable → env fallback (existing boot behaviour).
    return { settings: stripeSettingsFromEnv(this.configService), source: 'env' };
  }

  private hashSettings(settings: StripeClientSettings, source: 'config' | 'env'): string {
    // Never hash the raw secret — hash sha256(secret) so no plaintext lives in
    // the snapshot key. Includes source so a config↔env transition rebuilds.
    const secretDigest = settings.secretKey
      ? createHash('sha256').update(settings.secretKey).digest('hex')
      : '';
    return createHash('sha256')
      .update(
        [
          source,
          settings.provider,
          String(settings.billingEnabled),
          String(settings.isProduction),
          secretDigest,
        ].join('|'),
      )
      .digest('hex');
  }
}

/**
 * DynamicStripeClient — the IStripeApiClient bound to STRIPE_API_CLIENT. A thin
 * delegator: every method resolves the current underlying client and forwards.
 * StripeApiService's cached reference to THIS instance stays valid across swaps.
 */
@Injectable()
export class DynamicStripeClient implements IStripeApiClient {
  constructor(private readonly provider: DynamicStripeClientProvider) {}

  async createCustomer(args: {
    email?: string;
    name?: string;
    metadata: StripeMetadata;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeCustomer> {
    return (await this.provider.resolve()).createCustomer(args);
  }

  async createSubscription(args: {
    customerId: string;
    priceId: string;
    metadata: StripeMetadata;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeSubscription> {
    return (await this.provider.resolve()).createSubscription(args);
  }

  async updateSubscription(args: {
    subscriptionId: string;
    priceId?: string;
    metadata?: StripeMetadata;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeSubscription> {
    return (await this.provider.resolve()).updateSubscription(args);
  }

  async cancelSubscription(args: {
    subscriptionId: string;
    immediately: boolean;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeSubscription> {
    return (await this.provider.resolve()).cancelSubscription(args);
  }

  async retrieveSubscription(args: { subscriptionId: string }): Promise<StripeSubscription> {
    return (await this.provider.resolve()).retrieveSubscription(args);
  }

  async createRefund(args: {
    chargeId: string;
    amount: bigint;
    reason: 'duplicate' | 'fraudulent' | 'requested_by_customer';
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeRefund> {
    return (await this.provider.resolve()).createRefund(args);
  }

  async retrieveRefund(args: { refundId: string }): Promise<StripeRefund> {
    return (await this.provider.resolve()).retrieveRefund(args);
  }

  async finalizeInvoice(args: {
    invoiceId: string;
    idempotencyKey: StripeIdempotencyKey;
  }): Promise<StripeInvoice> {
    return (await this.provider.resolve()).finalizeInvoice(args);
  }

  async reportMeterEvent(
    args: StripeMeterEvent & { idempotencyKey: StripeIdempotencyKey },
  ): Promise<void> {
    return (await this.provider.resolve()).reportMeterEvent(args);
  }
}
