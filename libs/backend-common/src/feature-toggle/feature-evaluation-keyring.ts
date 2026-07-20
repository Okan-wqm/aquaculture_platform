import {
  parseServiceIdentityKeyring,
  type ServiceIdentityKeyringEntry,
} from '../utils/service-identity.util';

import { FeatureEvaluationSnapshotError } from './feature-evaluation-snapshot';

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENTRY_KEYS = new Set([
  'kid',
  'secret',
  'status',
  'callers',
  'audiences',
  'tenantScopePolicy',
]);

export interface ResolveFeatureEvaluationKeyringOptions {
  readonly rawKeyring: string | undefined;
  readonly configuredActiveKeyId: string | undefined;
  readonly developmentSecret: string | undefined;
  readonly isProduction: boolean;
}

export interface ResolvedFeatureEvaluationKeyring {
  readonly keyring: readonly ServiceIdentityKeyringEntry[];
  readonly activeKeyId: string | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failProductionKeyring(): never {
  throw new FeatureEvaluationSnapshotError(
    'Production feature evaluation keyring configuration is invalid',
  );
}

function assertOptionalStringArray(value: unknown): void {
  if (
    value !== undefined &&
    (!Array.isArray(value) ||
      value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0))
  ) {
    failProductionKeyring();
  }
}

function validateProductionKeyring(
  rawKeyring: string | undefined,
  configuredActiveKeyId: string | undefined,
): readonly ServiceIdentityKeyringEntry[] {
  if (
    !rawKeyring?.trim() ||
    !configuredActiveKeyId ||
    configuredActiveKeyId.trim() !== configuredActiveKeyId
  ) {
    failProductionKeyring();
  }

  let document: unknown;
  try {
    document = JSON.parse(rawKeyring);
  } catch {
    failProductionKeyring();
  }

  let rawEntries: unknown[];
  if (Array.isArray(document)) {
    rawEntries = document;
  } else if (
    isRecord(document) &&
    Object.keys(document).length === 1 &&
    Array.isArray(document['keys'])
  ) {
    rawEntries = document['keys'];
  } else {
    failProductionKeyring();
  }
  if (rawEntries.length === 0) failProductionKeyring();

  const seenKeyIds = new Set<string>();
  for (const entry of rawEntries) {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !ENTRY_KEYS.has(key))) {
      failProductionKeyring();
    }
    if (
      typeof entry['kid'] !== 'string' ||
      !KEY_ID_PATTERN.test(entry['kid']) ||
      seenKeyIds.has(entry['kid']) ||
      typeof entry['secret'] !== 'string' ||
      Buffer.byteLength(entry['secret'], 'utf8') < 32 ||
      (entry['status'] !== 'active' &&
        entry['status'] !== 'previous' &&
        entry['status'] !== 'disabled')
    ) {
      failProductionKeyring();
    }
    assertOptionalStringArray(entry['callers']);
    assertOptionalStringArray(entry['audiences']);
    if (
      entry['tenantScopePolicy'] !== undefined &&
      entry['tenantScopePolicy'] !== 'tenant-bound' &&
      entry['tenantScopePolicy'] !== 'all-tenants'
    ) {
      failProductionKeyring();
    }
    seenKeyIds.add(entry['kid']);
  }

  const keyring = parseServiceIdentityKeyring(rawKeyring);
  const active = keyring.filter((entry) => entry.kid === configuredActiveKeyId);
  if (active.length !== 1 || active[0]?.status !== 'active') failProductionKeyring();
  return keyring;
}

/**
 * Resolve the one key view shared by the admin signer and gateway/farm
 * verifiers. The established local signedFetch secret is represented as a
 * synthetic active key only outside production; production has no fallback.
 */
export function resolveFeatureEvaluationKeyring(
  options: ResolveFeatureEvaluationKeyringOptions,
): ResolvedFeatureEvaluationKeyring {
  const keyring = options.isProduction
    ? validateProductionKeyring(options.rawKeyring, options.configuredActiveKeyId)
    : parseServiceIdentityKeyring(options.rawKeyring);
  if (keyring.length > 0) {
    return {
      keyring,
      activeKeyId:
        options.configuredActiveKeyId ??
        (options.isProduction
          ? undefined
          : keyring.find((entry) => entry.status === 'active')?.kid),
    };
  }

  if (!options.isProduction && options.developmentSecret) {
    if (Buffer.byteLength(options.developmentSecret, 'utf8') < 32) {
      throw new FeatureEvaluationSnapshotError(
        'Development feature evaluation signing secret must contain at least 32 bytes',
      );
    }
    return {
      keyring: [
        {
          kid: 'local-dev',
          secret: options.developmentSecret,
          status: 'active',
        },
      ],
      activeKeyId: 'local-dev',
    };
  }

  return { keyring: [], activeKeyId: undefined };
}
