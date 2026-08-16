import {
  CONFIGURATION_CATALOG_DIGEST,
  ConfigurationChangeIntentV1,
  ConfigurationKeyId,
  ConfigurationSnapshotSourceV1,
  ConfigurationSnapshotStateV1,
} from '@aquaculture/configuration-contracts';
import { describe, expect, it } from 'vitest';

import { ADMIN_CONFIGURATION_UI } from '../../../generated/configuration-ui.generated';
import {
  clearConfigurationChange,
  configurationEditorValues,
  setConfigurationChange,
} from '../platform-configuration';
import type {
  ConfigurationSnapshotEntryV1,
  ConfigurationSnapshotV1,
} from '../platform-configuration';

describe('configuration snapshot fail-red projection', () => {
  it('accepts the exact generated key set and keeps missing required values editable', () => {
    const current = snapshot();

    expect(current.readiness).toBe('RED');
    const values = configurationEditorValues(current);
    expect(Object.keys(values).sort()).toEqual(
      ADMIN_CONFIGURATION_UI.map((descriptor) => descriptor.id).sort(),
    );
    expect(values[ConfigurationKeyId.PLATFORM_NAME]).toBe('');
    expect(values[ConfigurationKeyId.EMAIL_SMTP_HOST]).toBe('');
  });

  it('projects typed values canonically without exposing a stored secret', () => {
    const current = snapshot({
      entries: baseEntries().map((entry): ConfigurationSnapshotEntryV1 => {
        if (entry.keyId === ConfigurationKeyId.PLATFORM_NAME) {
          return valueEntry(entry, 'Aquaculture Control Plane');
        }
        if (entry.keyId === ConfigurationKeyId.EMAIL_SMTP_PORT) {
          return valueEntry(entry, 465);
        }
        if (entry.keyId === ConfigurationKeyId.EMAIL_SMTP_SECURE) {
          return valueEntry(entry, true);
        }
        if (entry.keyId === ConfigurationKeyId.MAINTENANCE_ALLOWED_IPS) {
          return valueEntry(entry, ['192.0.2.1', '198.51.100.2']);
        }
        if (entry.keyId === ConfigurationKeyId.EMAIL_SMTP_PASSWORD) {
          return {
            ...entry,
            state: ConfigurationSnapshotStateV1.SECRET_SET,
            source: ConfigurationSnapshotSourceV1.SYSTEM,
            sourceTenantId: SYSTEM_TENANT_ID,
            effectiveVersion: `${SYSTEM_TENANT_ID}:3`,
          };
        }
        return entry;
      }),
    });

    const values = configurationEditorValues(current);
    expect(values[ConfigurationKeyId.PLATFORM_NAME]).toBe('Aquaculture Control Plane');
    expect(values[ConfigurationKeyId.EMAIL_SMTP_PORT]).toBe('465');
    expect(values[ConfigurationKeyId.EMAIL_SMTP_SECURE]).toBe('true');
    expect(values[ConfigurationKeyId.MAINTENANCE_ALLOWED_IPS]).toBe('["192.0.2.1","198.51.100.2"]');
    expect(values[ConfigurationKeyId.EMAIL_SMTP_PASSWORD]).toBe('');
  });

  it('rejects stale catalog identity before constructing editor state', () => {
    expect(() => configurationEditorValues(snapshot({ catalogDigest: '0'.repeat(64) }))).toThrow(
      'Configuration catalog changed',
    );
  });

  it('rejects persistence catalog mismatches and invalid values', () => {
    expect(() =>
      configurationEditorValues(
        snapshot({
          catalogMismatches: [`${SYSTEM_TENANT_ID}:UNREGISTERED_RUNTIME_KEY`],
        }),
      ),
    ).toThrow('unknown catalog IDs');
    expect(() =>
      configurationEditorValues(snapshot({ invalidKeys: [ConfigurationKeyId.PLATFORM_NAME] })),
    ).toThrow('invalid values');
  });

  it.each([ConfigurationSnapshotStateV1.INVALID, ConfigurationSnapshotStateV1.CATALOG_MISMATCH])(
    'rejects an entry in non-editable %s state even if summary arrays drift',
    (state) => {
      expect(() =>
        configurationEditorValues(
          snapshot({
            entries: baseEntries().map((entry) =>
              entry.keyId === ConfigurationKeyId.PLATFORM_NAME ? { ...entry, state } : entry,
            ),
          }),
        ),
      ).toThrow(`not editable in state ${state}`);
    },
  );

  it('rejects incomplete and duplicate projections instead of defaulting them', () => {
    const entries = baseEntries();
    expect(() => configurationEditorValues(snapshot({ entries: entries.slice(1) }))).toThrow(
      'snapshot is incomplete',
    );
    expect(() =>
      configurationEditorValues(snapshot({ entries: [...entries, entries[0]!] })),
    ).toThrow('Unexpected or duplicate configuration entry');
  });
});

describe('typed configuration change builders', () => {
  it('canonicalizes values using the catalog-owned type and validation rules', () => {
    expect(setConfigurationChange(ConfigurationKeyId.EMAIL_SMTP_PORT, '0465')).toEqual({
      keyId: ConfigurationKeyId.EMAIL_SMTP_PORT,
      intent: ConfigurationChangeIntentV1.SET,
      value: '465',
    });
    expect(setConfigurationChange(ConfigurationKeyId.EMAIL_SMTP_SECURE, 'true')).toEqual({
      keyId: ConfigurationKeyId.EMAIL_SMTP_SECURE,
      intent: ConfigurationChangeIntentV1.SET,
      value: 'true',
    });
    expect(() => setConfigurationChange(ConfigurationKeyId.EMAIL_SMTP_PORT, 'not-a-port')).toThrow(
      'number input must be finite',
    );
  });

  it('uses the typed clear intent without a compatibility payload', () => {
    expect(clearConfigurationChange(ConfigurationKeyId.EMAIL_SMTP_HOST)).toEqual({
      keyId: ConfigurationKeyId.EMAIL_SMTP_HOST,
      intent: ConfigurationChangeIntentV1.CLEAR_OVERRIDE,
    });
  });
});

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

function snapshot(overrides: Partial<ConfigurationSnapshotV1> = {}): ConfigurationSnapshotV1 {
  const entries = overrides.entries ?? baseEntries();
  const missingRequiredKeys = entries
    .filter((entry) => entry.state === ConfigurationSnapshotStateV1.MISSING_REQUIRED)
    .map((entry) => entry.keyId);
  return {
    catalogDigest: CONFIGURATION_CATALOG_DIGEST,
    tenantId: SYSTEM_TENANT_ID,
    environment: 'all',
    scopeRevision: '0',
    snapshotToken: 'a'.repeat(64),
    readiness: missingRequiredKeys.length > 0 ? 'RED' : 'READY',
    missingRequiredKeys,
    invalidKeys: [],
    catalogMismatches: [],
    entries,
    ...overrides,
  };
}

function baseEntries(): ConfigurationSnapshotEntryV1[] {
  return ADMIN_CONFIGURATION_UI.map(
    (descriptor): ConfigurationSnapshotEntryV1 => ({
      keyId: descriptor.id,
      state: descriptor.required
        ? ConfigurationSnapshotStateV1.MISSING_REQUIRED
        : ConfigurationSnapshotStateV1.OPTIONAL_ABSENT,
      source: ConfigurationSnapshotSourceV1.NONE,
      value: null,
      sourceTenantId: null,
      effectiveVersion: null,
      mutable: descriptor.mutable,
      required: descriptor.required,
      requiresRestart: descriptor.requiresRestart,
      fallbackSuppressed: false,
    }),
  );
}

function valueEntry(
  entry: ConfigurationSnapshotEntryV1,
  value: unknown,
): ConfigurationSnapshotEntryV1 {
  return {
    ...entry,
    state: ConfigurationSnapshotStateV1.VALUE,
    source: ConfigurationSnapshotSourceV1.SYSTEM,
    value,
    sourceTenantId: SYSTEM_TENANT_ID,
    effectiveVersion: `${SYSTEM_TENANT_ID}:2`,
  };
}
