import {
  CONFIGURATION_CATALOG_DIGEST,
  ConfigurationKeyId,
} from '@aquaculture/configuration-contracts';
import {
  ConfigRuntimeClient,
  ConfigRuntimeLookupV1,
} from '@aquaculture/backend-common/config-client';
import { CONFIG_RUNTIME_ACCESS_BY_CONSUMER } from '@platform/event-contracts';

import { SmtpConfigurationProvider, SmtpConfigurationState } from '../smtp-configuration.provider';

const SMTP_ACCESS = CONFIG_RUNTIME_ACCESS_BY_CONSUMER['notification-service'];
if (!SMTP_ACCESS) throw new Error('notification-service runtime access projection is missing');
const SMTP_KEYS = [...SMTP_ACCESS.nonSecretKeyIds, ...SMTP_ACCESS.secretKeyIds];

interface Harness {
  readonly provider: SmtpConfigurationProvider;
  readonly get: jest.MockedFunction<ConfigRuntimeClient['get']>;
  readonly values: Map<ConfigurationKeyId, ConfigRuntimeLookupV1>;
}

describe('SmtpConfigurationProvider exact catalog projection', () => {
  it('loads exactly the seven registered SMTP IDs and returns a typed ready snapshot', async () => {
    const harness = buildHarness();

    await expect(harness.provider.getSnapshot()).resolves.toEqual({
      state: SmtpConfigurationState.READY,
      catalogDigest: CONFIGURATION_CATALOG_DIGEST,
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      username: 'mailer',
      password: 'smtp-secret',
      fromAddress: 'noreply@example.com',
      fromName: 'Aquaculture Control Plane',
    });
    expect(harness.get.mock.calls.map(([keyId]) => keyId)).toEqual(SMTP_KEYS);
  });

  it('distinguishes intentionally disabled SMTP from unavailable configuration authority', async () => {
    const disabled = buildHarness();
    disabled.values.set(ConfigurationKeyId.EMAIL_SMTP_HOST, lookup(false, null));
    await expect(disabled.provider.getSnapshot()).resolves.toEqual({
      state: SmtpConfigurationState.DISABLED,
    });

    const unavailable = buildHarness();
    unavailable.values.set(ConfigurationKeyId.EMAIL_FROM_NAME, lookup(false, null, false));
    await expect(unavailable.provider.getSnapshot()).resolves.toEqual({
      state: SmtpConfigurationState.UNAVAILABLE,
    });
  });

  it.each([
    [ConfigurationKeyId.EMAIL_SMTP_PORT, lookup(true, '70000')],
    [ConfigurationKeyId.EMAIL_SMTP_SECURE, lookup(true, 'not-boolean')],
    [ConfigurationKeyId.EMAIL_SMTP_PASSWORD, lookup(false, null)],
    [
      ConfigurationKeyId.EMAIL_FROM_ADDRESS,
      lookup(true, 'mail@example.com\r\nBcc: attacker@example.com'),
    ],
  ])('fails red when %s cannot form a valid atomic SMTP snapshot', async (keyId, value) => {
    const harness = buildHarness();
    harness.values.set(keyId, value);
    await expect(harness.provider.getSnapshot()).resolves.toEqual({
      state: SmtpConfigurationState.INVALID,
    });
  });

  it('caches one atomic projection and invalidates it on ConfigurationChanged', async () => {
    const harness = buildHarness();
    await harness.provider.getSnapshot();
    await harness.provider.getSnapshot();
    expect(harness.get).toHaveBeenCalledTimes(SMTP_KEYS.length);

    harness.provider.invalidate();
    await harness.provider.getSnapshot();
    expect(harness.get).toHaveBeenCalledTimes(SMTP_KEYS.length * 2);
  });
});

function buildHarness(): Harness {
  const values = new Map<ConfigurationKeyId, ConfigRuntimeLookupV1>([
    [ConfigurationKeyId.EMAIL_SMTP_HOST, lookup(true, 'smtp.example.com')],
    [ConfigurationKeyId.EMAIL_SMTP_PORT, lookup(true, '465')],
    [ConfigurationKeyId.EMAIL_SMTP_SECURE, lookup(true, 'true')],
    [ConfigurationKeyId.EMAIL_SMTP_USERNAME, lookup(true, 'mailer')],
    [ConfigurationKeyId.EMAIL_SMTP_PASSWORD, lookup(true, 'smtp-secret')],
    [ConfigurationKeyId.EMAIL_FROM_ADDRESS, lookup(true, 'noreply@example.com')],
    [ConfigurationKeyId.EMAIL_FROM_NAME, lookup(true, 'Aquaculture Control Plane')],
  ]);
  const get: jest.MockedFunction<ConfigRuntimeClient['get']> = jest.fn(
    async (keyId: ConfigurationKeyId): Promise<ConfigRuntimeLookupV1> =>
      values.get(keyId) ?? lookup(false, null),
  );
  const client: Pick<ConfigRuntimeClient, 'get'> = { get };
  return {
    provider: new SmtpConfigurationProvider(client as ConfigRuntimeClient),
    get,
    values,
  };
}

function lookup(found: boolean, value: string | null, reachable = true): ConfigRuntimeLookupV1 {
  return { reachable, found, value };
}
