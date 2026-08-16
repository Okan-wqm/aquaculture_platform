/**
 * Versioned authority for the deliberately open JSON leaves in admin HTTP
 * contracts. A reason is not documentation: it resolves to one immutable
 * decoder coordinate, owner and root-shape policy.
 */

export const ADMIN_JSON_DECODER_CATALOG_SCHEMA_VERSION = 'admin-json-decoder-catalog.v1' as const;
export const ADMIN_JSON_CODEC_POLICY_ID = 'admin-json-codec.v1' as const;

export const ADMIN_JSON_DECODER_ROOT_POLICIES = ['json-value', 'json-scalar'] as const;
export type AdminJsonDecoderRootPolicy = (typeof ADMIN_JSON_DECODER_ROOT_POLICIES)[number];

export interface AdminJsonDecoderDefinitionV1 {
  readonly reason: string;
  readonly decoderId: string;
  readonly decoderVersion: 1;
  readonly owner: string;
  readonly rootPolicy: AdminJsonDecoderRootPolicy;
  readonly codecPolicyId: typeof ADMIN_JSON_CODEC_POLICY_ID;
}

export interface AdminJsonDecoderCatalogV1 {
  readonly schemaVersion: typeof ADMIN_JSON_DECODER_CATALOG_SCHEMA_VERSION;
  readonly entries: readonly AdminJsonDecoderDefinitionV1[];
}

const ADMIN_JSON_DECODER_CATALOG_SEED = {
  schemaVersion: ADMIN_JSON_DECODER_CATALOG_SCHEMA_VERSION,
  entries: [
    {
      reason: 'database-record',
      decoderId: 'admin-json.database-record.v1',
      decoderVersion: 1,
      owner: 'platform.database-management',
      rootPolicy: 'json-value',
      codecPolicyId: ADMIN_JSON_CODEC_POLICY_ID,
    },
    {
      reason: 'database-scalar',
      decoderId: 'admin-json.database-scalar.v1',
      decoderVersion: 1,
      owner: 'platform.database-management',
      rootPolicy: 'json-scalar',
      codecPolicyId: ADMIN_JSON_CODEC_POLICY_ID,
    },
    {
      reason: 'debug-observation',
      decoderId: 'admin-json.debug-observation.v1',
      decoderVersion: 1,
      owner: 'platform.impersonation-debug',
      rootPolicy: 'json-value',
      codecPolicyId: ADMIN_JSON_CODEC_POLICY_ID,
    },
    {
      reason: 'extension-metadata',
      decoderId: 'admin-json.extension-metadata.v1',
      decoderVersion: 1,
      owner: 'platform.extension-metadata',
      rootPolicy: 'json-value',
      codecPolicyId: ADMIN_JSON_CODEC_POLICY_ID,
    },
    {
      reason: 'external-system-record',
      decoderId: 'admin-json.external-system-record.v1',
      decoderVersion: 1,
      owner: 'platform.external-integrations',
      rootPolicy: 'json-value',
      codecPolicyId: ADMIN_JSON_CODEC_POLICY_ID,
    },
    {
      reason: 'job-payload',
      decoderId: 'admin-json.job-payload.v1',
      decoderVersion: 1,
      owner: 'platform.job-runtime',
      rootPolicy: 'json-value',
      codecPolicyId: ADMIN_JSON_CODEC_POLICY_ID,
    },
    {
      reason: 'operator-configuration',
      decoderId: 'admin-json.operator-configuration.v1',
      decoderVersion: 1,
      owner: 'platform.operator-configuration',
      rootPolicy: 'json-value',
      codecPolicyId: ADMIN_JSON_CODEC_POLICY_ID,
    },
    {
      reason: 'report-dataset',
      decoderId: 'admin-json.report-dataset.v1',
      decoderVersion: 1,
      owner: 'platform.analytics-reporting',
      rootPolicy: 'json-value',
      codecPolicyId: ADMIN_JSON_CODEC_POLICY_ID,
    },
    {
      reason: 'security-audit-context',
      decoderId: 'admin-json.security-audit-context.v1',
      decoderVersion: 1,
      owner: 'platform.security-compliance',
      rootPolicy: 'json-value',
      codecPolicyId: ADMIN_JSON_CODEC_POLICY_ID,
    },
  ],
} as const satisfies AdminJsonDecoderCatalogV1;

export type AdminSchemalessJsonReason =
  (typeof ADMIN_JSON_DECODER_CATALOG_SEED.entries)[number]['reason'];
export type AdminJsonDecoderId =
  (typeof ADMIN_JSON_DECODER_CATALOG_SEED.entries)[number]['decoderId'];
export type AdminJsonDecoderOwner =
  (typeof ADMIN_JSON_DECODER_CATALOG_SEED.entries)[number]['owner'];

const CATALOG_KEYS = ['entries', 'schemaVersion'] as const;
const ENTRY_KEYS = [
  'codecPolicyId',
  'decoderId',
  'decoderVersion',
  'owner',
  'reason',
  'rootPolicy',
] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Reflect.ownKeys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => typeof key === 'string' && key === canonical[index])
  );
}

/** Strict candidate validator used by the runtime bootstrap and negative tests. */
export function validateAdminJsonDecoderCatalogV1(candidate: unknown): void {
  if (!isRecord(candidate) || !hasExactKeys(candidate, CATALOG_KEYS)) {
    throw new Error('admin JSON decoder catalog must have the exact V1 shape');
  }
  if (candidate.schemaVersion !== ADMIN_JSON_DECODER_CATALOG_SCHEMA_VERSION) {
    throw new Error('admin JSON decoder catalog schema version is unsupported');
  }
  if (!Array.isArray(candidate.entries) || candidate.entries.length === 0) {
    throw new Error('admin JSON decoder catalog requires at least one entry');
  }

  const reasons = new Set<string>();
  const decoderIds = new Set<string>();
  let previousReason = '';
  for (const entry of candidate.entries) {
    if (!isRecord(entry) || !hasExactKeys(entry, ENTRY_KEYS)) {
      throw new Error('admin JSON decoder entry must have the exact V1 shape');
    }
    if (typeof entry.reason !== 'string' || !/^[a-z][a-z0-9-]*$/.test(entry.reason)) {
      throw new Error('admin JSON decoder reason is invalid');
    }
    if (
      typeof entry.decoderId !== 'string' ||
      entry.decoderId !== `admin-json.${entry.reason}.v1`
    ) {
      throw new Error('admin JSON decoder ID must be derived from its reason and version');
    }
    if (entry.decoderVersion !== 1) {
      throw new Error('admin JSON decoder version is unsupported');
    }
    if (typeof entry.owner !== 'string' || !/^platform\.[a-z][a-z0-9.-]*$/.test(entry.owner)) {
      throw new Error('admin JSON decoder owner is invalid');
    }
    if (
      typeof entry.rootPolicy !== 'string' ||
      !ADMIN_JSON_DECODER_ROOT_POLICIES.includes(entry.rootPolicy as AdminJsonDecoderRootPolicy)
    ) {
      throw new Error('admin JSON decoder root policy is invalid');
    }
    if (entry.codecPolicyId !== ADMIN_JSON_CODEC_POLICY_ID) {
      throw new Error('admin JSON decoder references an unsupported structural codec policy');
    }
    if (reasons.has(entry.reason) || decoderIds.has(entry.decoderId)) {
      throw new Error('admin JSON decoder reasons and IDs must be unique');
    }
    if (previousReason !== '' && previousReason >= entry.reason) {
      throw new Error('admin JSON decoder entries must be in canonical reason order');
    }
    reasons.add(entry.reason);
    decoderIds.add(entry.decoderId);
    previousReason = entry.reason;
  }
}

function freezeCatalog<const TCatalog extends AdminJsonDecoderCatalogV1>(
  catalog: TCatalog,
): TCatalog {
  catalog.entries.forEach((entry) => Object.freeze(entry));
  Object.freeze(catalog.entries);
  return Object.freeze(catalog);
}

validateAdminJsonDecoderCatalogV1(ADMIN_JSON_DECODER_CATALOG_SEED);

export const ADMIN_JSON_DECODER_CATALOG = freezeCatalog(ADMIN_JSON_DECODER_CATALOG_SEED);

export const ADMIN_SCHEMALESS_JSON_REASONS = Object.freeze(
  ADMIN_JSON_DECODER_CATALOG.entries.map((entry) => entry.reason),
);

export function adminJsonDecoderDefinitionFor(
  reason: string,
): (typeof ADMIN_JSON_DECODER_CATALOG.entries)[number] {
  const definition = ADMIN_JSON_DECODER_CATALOG.entries.find(
    (candidate) => candidate.reason === reason,
  );
  if (definition === undefined) {
    throw new Error(`unregistered admin JSON decoder reason: ${reason}`);
  }
  return definition;
}
