import {
  CONFIGURATION_CATALOG_DIGEST,
  ConfigurationKeyId,
} from '@aquaculture/configuration-contracts';
import { ConfigRuntimeClient } from '@aquaculture/backend-common/config-client';
import type { ConfigRuntimeLookupV1 } from '@aquaculture/backend-common/config-client';
import { Injectable } from '@nestjs/common';
import {
  CONFIG_RUNTIME_ACCESS_BY_CONSUMER,
  type ConfigRuntimeConsumerAccessV1,
} from '@platform/event-contracts';

export enum SmtpConfigurationState {
  READY = 'READY',
  DISABLED = 'DISABLED',
  UNAVAILABLE = 'UNAVAILABLE',
  INVALID = 'INVALID',
}

export interface ReadySmtpConfigurationV1 {
  readonly state: SmtpConfigurationState.READY;
  readonly catalogDigest: string;
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly username: string | null;
  readonly password: string | null;
  readonly fromAddress: string;
  readonly fromName: string;
}

export type SmtpConfigurationSnapshotV1 =
  | ReadySmtpConfigurationV1
  | { readonly state: Exclude<SmtpConfigurationState, SmtpConfigurationState.READY> };

const CACHE_TTL_MS = 30_000;
const SMTP_FIELD_IDS = {
  host: ConfigurationKeyId.EMAIL_SMTP_HOST,
  port: ConfigurationKeyId.EMAIL_SMTP_PORT,
  secure: ConfigurationKeyId.EMAIL_SMTP_SECURE,
  username: ConfigurationKeyId.EMAIL_SMTP_USERNAME,
  password: ConfigurationKeyId.EMAIL_SMTP_PASSWORD,
  fromAddress: ConfigurationKeyId.EMAIL_FROM_ADDRESS,
  fromName: ConfigurationKeyId.EMAIL_FROM_NAME,
} as const;
const SMTP_RUNTIME_ACCESS = requireSmtpRuntimeAccess();
export const SMTP_CONFIGURATION_IDS: readonly ConfigurationKeyId[] = [
  ...SMTP_RUNTIME_ACCESS.nonSecretKeyIds,
  ...SMTP_RUNTIME_ACCESS.secretKeyIds,
];

function requireSmtpRuntimeAccess(): ConfigRuntimeConsumerAccessV1 {
  const access = CONFIG_RUNTIME_ACCESS_BY_CONSUMER['notification-service'];
  if (!access) throw new Error('notification-service is absent from configuration consumer SSOT');
  const expected = Object.values(SMTP_FIELD_IDS).sort();
  const registered = [...access.nonSecretKeyIds, ...access.secretKeyIds].sort();
  if (expected.join(',') !== registered.join(',')) {
    throw new Error('notification-service SMTP implementation and configuration SSOT diverged');
  }
  return access;
}

/** Runtime projection of the seven catalog-owned SMTP keys; it invents no values. */
@Injectable()
export class SmtpConfigurationProvider {
  private cache: { expiresAt: number; snapshot: SmtpConfigurationSnapshotV1 } | null = null;

  constructor(private readonly configRuntime: ConfigRuntimeClient) {}

  invalidate(): void {
    this.cache = null;
  }

  async getSnapshot(): Promise<SmtpConfigurationSnapshotV1> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.snapshot;
    const snapshot = await this.loadSnapshot();
    this.cache = { expiresAt: Date.now() + CACHE_TTL_MS, snapshot };
    return snapshot;
  }

  private async loadSnapshot(): Promise<SmtpConfigurationSnapshotV1> {
    const results = new Map<ConfigurationKeyId, ConfigRuntimeLookupV1>(
      await Promise.all(
        SMTP_CONFIGURATION_IDS.map(
          async (keyId): Promise<[ConfigurationKeyId, ConfigRuntimeLookupV1]> => [
            keyId,
            await this.configRuntime.get(keyId),
          ],
        ),
      ),
    );
    const host = this.requiredLookup(results, SMTP_FIELD_IDS.host);
    const port = this.requiredLookup(results, SMTP_FIELD_IDS.port);
    const secure = this.requiredLookup(results, SMTP_FIELD_IDS.secure);
    const username = this.requiredLookup(results, SMTP_FIELD_IDS.username);
    const password = this.requiredLookup(results, SMTP_FIELD_IDS.password);
    const fromAddress = this.requiredLookup(results, SMTP_FIELD_IDS.fromAddress);
    const fromName = this.requiredLookup(results, SMTP_FIELD_IDS.fromName);
    const all = [host, port, secure, username, password, fromAddress, fromName];
    if (all.some((entry) => !entry.reachable)) {
      return { state: SmtpConfigurationState.UNAVAILABLE };
    }
    if (!host.found) return { state: SmtpConfigurationState.DISABLED };
    if (
      host.value === null ||
      !port.found ||
      port.value === null ||
      !secure.found ||
      secure.value === null ||
      !fromAddress.found ||
      fromAddress.value === null ||
      !fromName.found ||
      fromName.value === null
    ) {
      return { state: SmtpConfigurationState.INVALID };
    }
    const parsedPort = Number(port.value);
    const secureValue = secure.value === 'true' ? true : secure.value === 'false' ? false : null;
    const usernameValue = username.found ? username.value : null;
    const passwordValue = password.found ? password.value : null;
    if (
      !Number.isSafeInteger(parsedPort) ||
      parsedPort < 1 ||
      parsedPort > 65535 ||
      secureValue === null ||
      (usernameValue === null) !== (passwordValue === null) ||
      /[\r\n]/u.test(host.value) ||
      /[\r\n]/u.test(fromAddress.value) ||
      /[\r\n]/u.test(fromName.value)
    ) {
      return { state: SmtpConfigurationState.INVALID };
    }
    return {
      state: SmtpConfigurationState.READY,
      catalogDigest: CONFIGURATION_CATALOG_DIGEST,
      host: host.value,
      port: parsedPort,
      secure: secureValue,
      username: usernameValue,
      password: passwordValue,
      fromAddress: fromAddress.value,
      fromName: fromName.value,
    };
  }

  private requiredLookup(
    results: ReadonlyMap<ConfigurationKeyId, ConfigRuntimeLookupV1>,
    keyId: ConfigurationKeyId,
  ): ConfigRuntimeLookupV1 {
    const result = results.get(keyId);
    if (!result) throw new Error(`SMTP configuration projection lost ${keyId}`);
    return result;
  }
}
