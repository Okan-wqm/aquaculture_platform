import {
  CONFIGURATION_CATALOG_DIGEST,
  CONFIGURATION_DEFINITION_BY_ID,
  ConfigurationChangeIntentV1,
  ConfigurationKeyId,
  ConfigurationSnapshotSourceV1,
  ConfigurationSnapshotStateV1,
  canonicalConfigurationInput,
  canonicalConfigurationJson,
} from '@aquaculture/configuration-contracts';

import { ADMIN_CONFIGURATION_UI } from '../../generated/configuration-ui.generated';

export interface ConfigurationSnapshotEntryV1 {
  keyId: ConfigurationKeyId;
  state: ConfigurationSnapshotStateV1;
  source: ConfigurationSnapshotSourceV1;
  value: unknown;
  sourceTenantId: string | null;
  effectiveVersion: string | null;
  mutable: boolean;
  required: boolean;
  requiresRestart: boolean;
  fallbackSuppressed: boolean;
}

export interface ConfigurationSnapshotV1 {
  catalogDigest: string;
  tenantId: string;
  environment: string;
  scopeRevision: string;
  snapshotToken: string;
  readiness: 'READY' | 'RED';
  missingRequiredKeys: ConfigurationKeyId[];
  invalidKeys: ConfigurationKeyId[];
  catalogMismatches: string[];
  entries: ConfigurationSnapshotEntryV1[];
}

export interface ConfigurationChangeInputV1 {
  keyId: ConfigurationKeyId;
  intent: ConfigurationChangeIntentV1;
  value?: string;
}

export interface ApplyConfigurationBatchInputV1 {
  operationId: string;
  environment: 'ALL';
  catalogDigest: string;
  expectedSnapshotToken: string;
  reason: string;
  changes: ConfigurationChangeInputV1[];
}

export interface ConfigurationBatchReceiptV1 {
  operationId: string;
  catalogDigest: string;
  tenantId: string;
  environment: string;
  previousSnapshotToken: string;
  resultingSnapshotToken: string;
  scopeRevision: string;
  replayed: boolean;
  changes: Array<{
    keyId: ConfigurationKeyId;
    intent: ConfigurationChangeIntentV1;
    version: number | null;
  }>;
}

export type ConfigurationEditorValuesV1 = Record<ConfigurationKeyId, string>;

function editorString(entry: ConfigurationSnapshotEntryV1): string {
  if (
    entry.state === ConfigurationSnapshotStateV1.OPTIONAL_ABSENT ||
    entry.state === ConfigurationSnapshotStateV1.MISSING_REQUIRED ||
    entry.state === ConfigurationSnapshotStateV1.SECRET_SET
  ) {
    return '';
  }
  if (typeof entry.value === 'string') return entry.value;
  if (typeof entry.value === 'number' || typeof entry.value === 'boolean') {
    return String(entry.value);
  }
  return canonicalConfigurationJson(entry.value);
}

/** Exact-set projection: partial/stale GraphQL payloads never become editable UI state. */
export function configurationEditorValues(
  snapshot: ConfigurationSnapshotV1,
): ConfigurationEditorValuesV1 {
  if (snapshot.catalogDigest !== CONFIGURATION_CATALOG_DIGEST) {
    throw new Error('Configuration catalog changed; reload the admin application');
  }
  if (snapshot.catalogMismatches.length > 0) {
    throw new Error(
      `Configuration persistence contains unknown catalog IDs: ${snapshot.catalogMismatches.join(', ')}`,
    );
  }
  if (snapshot.invalidKeys.length > 0) {
    throw new Error(
      `Configuration persistence contains invalid values: ${snapshot.invalidKeys.join(', ')}`,
    );
  }
  const expected = new Set(ADMIN_CONFIGURATION_UI.map((descriptor) => descriptor.id));
  const entries = new Map<ConfigurationKeyId, ConfigurationSnapshotEntryV1>();
  for (const entry of snapshot.entries) {
    if (!expected.has(entry.keyId) || entries.has(entry.keyId)) {
      throw new Error(`Unexpected or duplicate configuration entry: ${entry.keyId}`);
    }
    if (
      entry.state === ConfigurationSnapshotStateV1.INVALID ||
      entry.state === ConfigurationSnapshotStateV1.CATALOG_MISMATCH
    ) {
      throw new Error(
        `Configuration entry is not editable in state ${entry.state}: ${entry.keyId}`,
      );
    }
    entries.set(entry.keyId, entry);
  }
  if (entries.size !== expected.size) {
    const missing = [...expected].filter((keyId) => !entries.has(keyId));
    throw new Error(`Configuration snapshot is incomplete: ${missing.join(', ')}`);
  }
  const values = Object.create(null) as ConfigurationEditorValuesV1;
  for (const keyId of expected) {
    const entry = entries.get(keyId);
    if (!entry) throw new Error(`Configuration snapshot lost ${keyId}`);
    values[keyId] = editorString(entry);
  }
  return values;
}

export function setConfigurationChange(
  keyId: ConfigurationKeyId,
  editorValue: string,
): ConfigurationChangeInputV1 {
  const definition = CONFIGURATION_DEFINITION_BY_ID[keyId];
  return {
    keyId,
    intent: ConfigurationChangeIntentV1.SET,
    value: canonicalConfigurationInput(definition, editorValue),
  };
}

export function clearConfigurationChange(keyId: ConfigurationKeyId): ConfigurationChangeInputV1 {
  return { keyId, intent: ConfigurationChangeIntentV1.CLEAR_OVERRIDE };
}
