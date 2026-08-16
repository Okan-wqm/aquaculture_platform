import {
  CONFIGURATION_CATALOG_DIGEST,
  ConfigurationKeyId,
  configurationDefinition,
} from '@aquaculture/configuration-contracts';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ClientProxy } from '@nestjs/microservices';
import {
  CONFIG_RUNTIME_SUBJECTS,
  CONFIG_RUNTIME_SYSTEM_TENANT_ID,
  CONFIG_RUNTIME_ACCESS_BY_CONSUMER,
  canonicalConfigRuntimeBody,
  parseConfigRuntimeResult,
  type ConfigRuntimeGetRequest,
  type ConfigRuntimeResult,
} from '@platform/event-contracts';
import { serviceIdentityAudienceForService } from '@platform/service-catalog';
import { catchError, firstValueFrom, throwError, timeout } from 'rxjs';

import { buildSignedInternalHeaders } from '../http/signed-http-client';

export const CONFIG_NATS_CLIENT = 'CONFIG_NATS_CLIENT';
export const CONFIG_RUNTIME_CONSUMER_SERVICE = 'CONFIG_RUNTIME_CONSUMER_SERVICE';

const DEFAULT_CONFIG_RUNTIME_TIMEOUT_MS = 5_000;
const BILLING_FIELD_IDS = {
  enabled: ConfigurationKeyId.BILLING_STRIPE_ENABLED,
  publicKey: ConfigurationKeyId.BILLING_STRIPE_PUBLIC_KEY,
  secretKey: ConfigurationKeyId.BILLING_STRIPE_SECRET_KEY,
} as const;

function assertBillingRuntimeProjection(): void {
  const access = CONFIG_RUNTIME_ACCESS_BY_CONSUMER['billing-service'];
  if (!access) throw new Error('billing-service is absent from configuration consumer SSOT');
  const expected = Object.values(BILLING_FIELD_IDS).sort();
  const registered = [...access.nonSecretKeyIds, ...access.secretKeyIds].sort();
  if (expected.join(',') !== registered.join(',')) {
    throw new Error('billing Stripe implementation and configuration SSOT diverged');
  }
}

assertBillingRuntimeProjection();

export interface ConfigRuntimeLookupV1 {
  readonly reachable: boolean;
  readonly found: boolean;
  readonly value: string | null;
}

export interface BillingStripeSettings {
  enabled: boolean;
  publicKey: string | null;
  secretKey: string | null;
  reachable: boolean;
}

/** Typed catalog-ID client. Callers cannot construct arbitrary configuration coordinates. */
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
    this.audience = serviceIdentityAudienceForService('config-service');
  }

  async get(keyId: ConfigurationKeyId): Promise<ConfigRuntimeLookupV1> {
    const definition = configurationDefinition(keyId);
    const subject =
      definition.valueType === 'SECRET'
        ? CONFIG_RUNTIME_SUBJECTS.GET_SECRET
        : CONFIG_RUNTIME_SUBJECTS.GET;
    try {
      const result = await this.send(subject, keyId);
      return { reachable: true, found: result.found, value: result.value };
    } catch (error) {
      this.logger.warn(
        `config-runtime unavailable for ${keyId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { reachable: false, found: false, value: null };
    }
  }

  async getBillingStripeSettings(): Promise<BillingStripeSettings> {
    const enabledResult = await this.get(BILLING_FIELD_IDS.enabled);
    if (!enabledResult.reachable) {
      return { enabled: false, publicKey: null, secretKey: null, reachable: false };
    }
    if (!enabledResult.found || enabledResult.value !== 'true') {
      return { enabled: false, publicKey: null, secretKey: null, reachable: true };
    }
    const [publicKey, secretKey] = await Promise.all([
      this.get(BILLING_FIELD_IDS.publicKey),
      this.get(BILLING_FIELD_IDS.secretKey),
    ]);
    return {
      enabled: true,
      publicKey: publicKey.found ? publicKey.value : null,
      secretKey: secretKey.found ? secretKey.value : null,
      reachable: publicKey.reachable && secretKey.reachable,
    };
  }

  private async send(subject: string, keyId: ConfigurationKeyId): Promise<ConfigRuntimeResult> {
    const body = canonicalConfigRuntimeBody(CONFIGURATION_CATALOG_DIGEST, keyId);
    const identity = buildSignedInternalHeaders({
      serviceName: this.consumerService,
      tenantId: CONFIG_RUNTIME_SYSTEM_TENANT_ID,
      method: 'POST',
      path: subject,
      body,
      audience: this.audience,
    });
    const payload: ConfigRuntimeGetRequest = {
      catalogDigest: CONFIGURATION_CATALOG_DIGEST,
      keyId,
      identity,
    };
    const result: unknown = await firstValueFrom(
      this.client.send<unknown, ConfigRuntimeGetRequest>(subject, payload).pipe(
        timeout(this.timeoutMs),
        catchError((error: Error) => throwError(() => error)),
      ),
    );
    const parsed = parseConfigRuntimeResult(result);
    if (!parsed) {
      throw new Error('config-runtime returned an invalid or stale-catalog response');
    }
    return parsed;
  }
}
