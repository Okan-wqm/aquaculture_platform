import {
  canonicalWireJsonContentSha256V1,
  canonicalWireJsonStringifyV1,
} from '@aquaculture/shared-contracts';

export const REPORT_TYPES = Object.freeze([
  'tenant_overview',
  'tenant_churn',
  'financial_revenue',
  'financial_payments',
  'usage_modules',
  'usage_features',
  'system_performance',
] as const);

export type ReportType = (typeof REPORT_TYPES)[number];

export const REPORT_FORMATS = Object.freeze(['json', 'csv', 'pdf'] as const);
export type ReportFormat = (typeof REPORT_FORMATS)[number];

export const REPORT_RANGE_POLICIES = Object.freeze(['FORBIDDEN', 'REQUIRED'] as const);
export type ReportRangePolicy = (typeof REPORT_RANGE_POLICIES)[number];
export const REPORT_MAX_RANGE_SECONDS = 31_622_400;
export const REPORT_SCHEDULE_POLICIES = Object.freeze(['UNSUPPORTED'] as const);
export type ReportSchedulePolicy = (typeof REPORT_SCHEDULE_POLICIES)[number];
export const REPORT_PREVIEW_POLICIES = Object.freeze(['PERSISTED_BOUNDED_ROWS'] as const);
export type ReportPreviewPolicy = (typeof REPORT_PREVIEW_POLICIES)[number];
export const REPORT_ARTIFACT_POLICIES = Object.freeze(['MEASUREMENT_QUALIFIED_ONLY'] as const);
export type ReportArtifactPolicy = (typeof REPORT_ARTIFACT_POLICIES)[number];
export const REPORT_ARTIFACT_COMMIT_STATES = Object.freeze([
  'INTENT_CREATED',
  'BYTES_VERIFIED',
  'REFERENCE_COMMITTED',
] as const);
export type ReportArtifactCommitState = (typeof REPORT_ARTIFACT_COMMIT_STATES)[number];
export const REPORT_MEASUREMENT_STATES = Object.freeze(['BLOCKED', 'QUALIFIED'] as const);
export type ReportMeasurementState = (typeof REPORT_MEASUREMENT_STATES)[number];
export const REPORT_MAX_ARTIFACT_BYTES = 33_554_432;
export const REPORT_MAX_DATASET_ROWS = 100_000;
export const REPORT_MAX_DATASET_NODES = 1_000_000;
export const REPORT_MAX_DATASET_DEPTH = 16;

export interface ReportPortableJsonArray extends ReadonlyArray<ReportPortableJsonValue> {}

export interface ReportPortableJsonObject {
  readonly [key: string]: ReportPortableJsonValue;
}

export type ReportPortableJsonValue =
  | null
  | boolean
  | number
  | string
  | ReportPortableJsonArray
  | ReportPortableJsonObject;

export interface CompiledReportDatasetSnapshotV1 {
  readonly rows: readonly ReportPortableJsonObject[];
  readonly summary: ReportPortableJsonObject;
  readonly canonicalByteLength: number;
}

export interface QualifiedReportAdapterBindingV1 {
  readonly adapterId: string;
  readonly implementationSha256: string;
  readonly provenanceSha256: string;
}

export interface ReportMeasurementAdapterBuildAttestationV1 {
  readonly schemaVersion: 'report-measurement-adapter-build-attestation.v1';
  readonly issuer: 'admin-reporting-build-bootstrap.v1';
  readonly adapterId: string;
  readonly reportType: ReportType;
  readonly measurementAuthorityId: string;
  readonly implementationSha256: string;
  readonly provenanceSha256: string;
  readonly authorityGraphSha256: string;
  readonly attestationSha256: string;
}

export type ReportMeasurementAdapterBuildAttestationSourceV1 = Omit<
  ReportMeasurementAdapterBuildAttestationV1,
  'attestationSha256'
>;

export interface CompiledReportMeasurementAdapterBuildAttestationSetV1 {
  readonly schemaVersion: 'report-measurement-adapter-build-attestation-set.v1';
  readonly authorityGraphSha256: string;
  readonly attestations: readonly ReportMeasurementAdapterBuildAttestationV1[];
  readonly setSha256: string;
}

export interface ReportCapabilityV1 {
  readonly reportType: ReportType;
  readonly name: string;
  readonly description: string;
  readonly category: 'Tenant' | 'Financial' | 'Usage' | 'System';
  readonly measurementAuthorityId: string;
  readonly range:
    | { readonly policy: 'FORBIDDEN' }
    | {
        readonly policy: 'REQUIRED';
        readonly interval: 'UTC_HALF_OPEN';
        readonly maximumDurationSeconds: number;
        readonly futureEnd: 'FORBIDDEN';
      };
  readonly schedulePolicy: ReportSchedulePolicy;
  readonly preview: {
    readonly policy: ReportPreviewPolicy;
    readonly maximumRows: number;
  };
  readonly artifact: {
    readonly policy: ReportArtifactPolicy;
    readonly formats: readonly ReportFormat[];
    readonly maximumBytes: number;
  };
}

export interface ReportCapabilityCatalogV1 {
  readonly schemaVersion: 'report-capability-catalog.v1';
  readonly entries: readonly ReportCapabilityV1[];
}

export interface ReportMeasurementAuthorityV1 {
  readonly authorityId: string;
  readonly reportType: ReportType;
  readonly owner: string;
  readonly state: ReportMeasurementState;
  readonly requiredFacts: readonly string[];
  readonly blocker: string | null;
  readonly qualifiedAdapter: QualifiedReportAdapterBindingV1 | null;
}

export interface ReportMeasurementAuthorityCatalogV1 {
  readonly schemaVersion: 'report-measurement-authority-catalog.v1';
  readonly entries: readonly ReportMeasurementAuthorityV1[];
}

export interface ReportFactEvidenceV1 {
  readonly factId: string;
  readonly sourceCutSha256: string;
}

export interface ReportMeasurementIntentV1 {
  readonly schemaVersion: 'report-measurement-intent.v1';
  readonly reportType: ReportType;
  readonly startInclusiveUtc: string | null;
  readonly endExclusiveUtc: string | null;
  readonly filters: ReportPortableJsonObject | null;
  readonly intentSha256: string;
}

export interface ReportMeasurementProofV1 {
  readonly schemaVersion: 'report-measurement-proof.v1';
  readonly reportType: ReportType;
  readonly intentSha256: string;
  readonly capabilityCatalogSha256: string;
  readonly measurementCatalogSha256: string;
  readonly authorityGraphSha256: string;
  readonly measurementAuthorityId: string;
  readonly adapterId: string;
  readonly adapterImplementationSha256: string;
  readonly adapterProvenanceSha256: string;
  readonly measuredAt: string;
  readonly datasetSha256: string;
  readonly factEvidence: readonly ReportFactEvidenceV1[];
}

const capabilityCatalogSource: ReportCapabilityCatalogV1 = {
  schemaVersion: 'report-capability-catalog.v1',
  entries: [
    {
      reportType: 'tenant_overview',
      name: 'Tenant Overview',
      description: 'Tenant identity, lifecycle, plan, user-count and storage facts',
      category: 'Tenant',
      measurementAuthorityId: 'tenant-overview-facts.v1',
      range: { policy: 'FORBIDDEN' },
      schedulePolicy: 'UNSUPPORTED',
      preview: { policy: 'PERSISTED_BOUNDED_ROWS', maximumRows: 10 },
      artifact: {
        policy: 'MEASUREMENT_QUALIFIED_ONLY',
        formats: REPORT_FORMATS,
        maximumBytes: REPORT_MAX_ARTIFACT_BYTES,
      },
    },
    {
      reportType: 'tenant_churn',
      name: 'Churn Analysis',
      description: 'Measured tenant cancellation, reason and value facts for an exact interval',
      category: 'Tenant',
      measurementAuthorityId: 'tenant-churn-facts.v1',
      range: {
        policy: 'REQUIRED',
        interval: 'UTC_HALF_OPEN',
        maximumDurationSeconds: REPORT_MAX_RANGE_SECONDS,
        futureEnd: 'FORBIDDEN',
      },
      schedulePolicy: 'UNSUPPORTED',
      preview: { policy: 'PERSISTED_BOUNDED_ROWS', maximumRows: 10 },
      artifact: {
        policy: 'MEASUREMENT_QUALIFIED_ONLY',
        formats: REPORT_FORMATS,
        maximumBytes: REPORT_MAX_ARTIFACT_BYTES,
      },
    },
    {
      reportType: 'financial_revenue',
      name: 'Revenue Report',
      description: 'Ledger-backed revenue, subscription, adjustment and refund facts',
      category: 'Financial',
      measurementAuthorityId: 'financial-revenue-ledger.v1',
      range: {
        policy: 'REQUIRED',
        interval: 'UTC_HALF_OPEN',
        maximumDurationSeconds: REPORT_MAX_RANGE_SECONDS,
        futureEnd: 'FORBIDDEN',
      },
      schedulePolicy: 'UNSUPPORTED',
      preview: { policy: 'PERSISTED_BOUNDED_ROWS', maximumRows: 10 },
      artifact: {
        policy: 'MEASUREMENT_QUALIFIED_ONLY',
        formats: REPORT_FORMATS,
        maximumBytes: REPORT_MAX_ARTIFACT_BYTES,
      },
    },
    {
      reportType: 'financial_payments',
      name: 'Payments Report',
      description: 'Ledger-backed invoice, settlement, overdue and refund facts',
      category: 'Financial',
      measurementAuthorityId: 'financial-payment-ledger.v1',
      range: {
        policy: 'REQUIRED',
        interval: 'UTC_HALF_OPEN',
        maximumDurationSeconds: REPORT_MAX_RANGE_SECONDS,
        futureEnd: 'FORBIDDEN',
      },
      schedulePolicy: 'UNSUPPORTED',
      preview: { policy: 'PERSISTED_BOUNDED_ROWS', maximumRows: 10 },
      artifact: {
        policy: 'MEASUREMENT_QUALIFIED_ONLY',
        formats: REPORT_FORMATS,
        maximumBytes: REPORT_MAX_ARTIFACT_BYTES,
      },
    },
    {
      reportType: 'usage_modules',
      name: 'Module Usage',
      description: 'Measured module activation, session and duration facts',
      category: 'Usage',
      measurementAuthorityId: 'module-usage-facts.v1',
      range: {
        policy: 'REQUIRED',
        interval: 'UTC_HALF_OPEN',
        maximumDurationSeconds: REPORT_MAX_RANGE_SECONDS,
        futureEnd: 'FORBIDDEN',
      },
      schedulePolicy: 'UNSUPPORTED',
      preview: { policy: 'PERSISTED_BOUNDED_ROWS', maximumRows: 10 },
      artifact: {
        policy: 'MEASUREMENT_QUALIFIED_ONLY',
        formats: REPORT_FORMATS,
        maximumBytes: REPORT_MAX_ARTIFACT_BYTES,
      },
    },
    {
      reportType: 'usage_features',
      name: 'Feature Adoption',
      description: 'Measured feature adoption and usage facts',
      category: 'Usage',
      measurementAuthorityId: 'feature-usage-facts.v1',
      range: {
        policy: 'REQUIRED',
        interval: 'UTC_HALF_OPEN',
        maximumDurationSeconds: REPORT_MAX_RANGE_SECONDS,
        futureEnd: 'FORBIDDEN',
      },
      schedulePolicy: 'UNSUPPORTED',
      preview: { policy: 'PERSISTED_BOUNDED_ROWS', maximumRows: 10 },
      artifact: {
        policy: 'MEASUREMENT_QUALIFIED_ONLY',
        formats: REPORT_FORMATS,
        maximumBytes: REPORT_MAX_ARTIFACT_BYTES,
      },
    },
    {
      reportType: 'system_performance',
      name: 'System Performance',
      description: 'Telemetry-backed latency, availability, error and traffic facts',
      category: 'System',
      measurementAuthorityId: 'system-performance-telemetry.v1',
      range: {
        policy: 'REQUIRED',
        interval: 'UTC_HALF_OPEN',
        maximumDurationSeconds: REPORT_MAX_RANGE_SECONDS,
        futureEnd: 'FORBIDDEN',
      },
      schedulePolicy: 'UNSUPPORTED',
      preview: { policy: 'PERSISTED_BOUNDED_ROWS', maximumRows: 10 },
      artifact: {
        policy: 'MEASUREMENT_QUALIFIED_ONLY',
        formats: REPORT_FORMATS,
        maximumBytes: REPORT_MAX_ARTIFACT_BYTES,
      },
    },
  ],
};

const measurementCatalogSource: ReportMeasurementAuthorityCatalogV1 = {
  schemaVersion: 'report-measurement-authority-catalog.v1',
  entries: [
    {
      authorityId: 'tenant-overview-facts.v1',
      reportType: 'tenant_overview',
      owner: 'platform-data',
      state: 'BLOCKED',
      requiredFacts: [
        'auth.tenant-lifecycle',
        'auth.tenant-user-count',
        'billing.subscription-ledger',
        'storage.tenant-byte-ledger',
      ],
      blocker: 'MRR and storage are estimates; billing and storage fact authorities are not wired',
      qualifiedAdapter: null,
    },
    {
      authorityId: 'tenant-churn-facts.v1',
      reportType: 'tenant_churn',
      owner: 'platform-data',
      state: 'BLOCKED',
      requiredFacts: [
        'auth.tenant-lifecycle-events',
        'billing.subscription-ledger',
        'billing.tenant-value-ledger',
      ],
      blocker: 'Cancellation reason, recurring revenue and lifetime value are not authoritative',
      qualifiedAdapter: null,
    },
    {
      authorityId: 'financial-revenue-ledger.v1',
      reportType: 'financial_revenue',
      owner: 'billing',
      state: 'BLOCKED',
      requiredFacts: [
        'billing.invoice-line-ledger',
        'billing.refund-ledger',
        'billing.subscription-event-ledger',
      ],
      blocker: 'The billing fact ledger required for revenue qualification is not implemented',
      qualifiedAdapter: null,
    },
    {
      authorityId: 'financial-payment-ledger.v1',
      reportType: 'financial_payments',
      owner: 'billing',
      state: 'BLOCKED',
      requiredFacts: [
        'billing.invoice-ledger',
        'billing.payment-settlement-ledger',
        'billing.refund-ledger',
      ],
      blocker: 'Payment settlement and refund facts are not reconciled to one ledger',
      qualifiedAdapter: null,
    },
    {
      authorityId: 'module-usage-facts.v1',
      reportType: 'usage_modules',
      owner: 'platform-observability',
      state: 'BLOCKED',
      requiredFacts: ['telemetry.module-duration-events', 'telemetry.module-session-events'],
      blocker: 'Module session and duration measurements have no qualified source',
      qualifiedAdapter: null,
    },
    {
      authorityId: 'feature-usage-facts.v1',
      reportType: 'usage_features',
      owner: 'platform-observability',
      state: 'BLOCKED',
      requiredFacts: ['telemetry.feature-exposure-events', 'telemetry.feature-use-events'],
      blocker: 'Feature exposure and use measurements have no qualified source',
      qualifiedAdapter: null,
    },
    {
      authorityId: 'system-performance-telemetry.v1',
      reportType: 'system_performance',
      owner: 'platform-observability',
      state: 'BLOCKED',
      requiredFacts: [
        'telemetry.error-counter',
        'telemetry.http-request-histogram',
        'telemetry.service-availability-sli',
      ],
      blocker: 'Synthetic performance fallback must be replaced by telemetry measurements',
      qualifiedAdapter: null,
    },
  ],
};

export class ReportAuthorityCatalogError extends Error {
  constructor(message: string) {
    super(`report-authority-catalog: ${message}`);
    this.name = 'ReportAuthorityCatalogError';
  }
}

function assertExactReportTypeOrder(entries: readonly { readonly reportType: string }[]): void {
  if (entries.length !== REPORT_TYPES.length) {
    throw new ReportAuthorityCatalogError(
      `expected ${REPORT_TYPES.length} report entries, received ${entries.length}`,
    );
  }
  entries.forEach((entry, index) => {
    if (entry.reportType !== REPORT_TYPES[index]) {
      throw new ReportAuthorityCatalogError(
        `entry ${index} must be ${REPORT_TYPES[index]}, received ${entry.reportType}`,
      );
    }
  });
}

function assertExactKeys(value: object, expected: readonly string[], context: string): void {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new ReportAuthorityCatalogError(`${context} has a non-V1 shape`);
  }
  const actual = ownKeys.filter((key): key is string => typeof key === 'string').sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new ReportAuthorityCatalogError(`${context} has a non-V1 shape`);
  }
}

function assertCanonicalStringSet(values: readonly string[], field: string): void {
  if (values.length === 0 || new Set(values).size !== values.length) {
    throw new ReportAuthorityCatalogError(`${field} must be a non-empty unique set`);
  }
  const canonical = [...values].sort();
  if (values.some((value, index) => value !== canonical[index])) {
    throw new ReportAuthorityCatalogError(`${field} must use canonical lexical order`);
  }
}

export interface CompiledReportAuthorityGraphV1 {
  readonly schemaVersion: 'compiled-report-authority-graph.v1';
  readonly capabilityCatalog: ReportCapabilityCatalogV1;
  readonly capabilityCatalogSha256: string;
  readonly measurementCatalog: ReportMeasurementAuthorityCatalogV1;
  readonly measurementCatalogSha256: string;
  readonly graphSha256: string;
}

export function compileReportAuthorityGraph(
  capabilityCatalog: ReportCapabilityCatalogV1,
  measurementCatalog: ReportMeasurementAuthorityCatalogV1,
): CompiledReportAuthorityGraphV1 {
  if (capabilityCatalog.schemaVersion !== 'report-capability-catalog.v1') {
    throw new ReportAuthorityCatalogError('unsupported capability schema version');
  }
  if (measurementCatalog.schemaVersion !== 'report-measurement-authority-catalog.v1') {
    throw new ReportAuthorityCatalogError('unsupported measurement schema version');
  }
  assertExactKeys(capabilityCatalog, ['schemaVersion', 'entries'], 'capability catalog');
  assertExactKeys(measurementCatalog, ['schemaVersion', 'entries'], 'measurement catalog');
  assertExactReportTypeOrder(capabilityCatalog.entries);
  assertExactReportTypeOrder(measurementCatalog.entries);

  const authorityIds = new Set<string>();
  capabilityCatalog.entries.forEach((capability) => {
    assertExactKeys(
      capability,
      [
        'reportType',
        'name',
        'description',
        'category',
        'measurementAuthorityId',
        'range',
        'schedulePolicy',
        'preview',
        'artifact',
      ],
      `${capability.reportType} capability`,
    );
    assertExactKeys(
      capability.preview,
      ['policy', 'maximumRows'],
      `${capability.reportType} preview`,
    );
    assertExactKeys(
      capability.range,
      capability.range.policy === 'FORBIDDEN'
        ? ['policy']
        : ['policy', 'interval', 'maximumDurationSeconds', 'futureEnd'],
      `${capability.reportType} range`,
    );
    assertExactKeys(
      capability.artifact,
      ['policy', 'formats', 'maximumBytes'],
      `${capability.reportType} artifact`,
    );
    if (
      !REPORT_RANGE_POLICIES.includes(capability.range.policy) ||
      !REPORT_SCHEDULE_POLICIES.includes(capability.schedulePolicy) ||
      !REPORT_PREVIEW_POLICIES.includes(capability.preview.policy) ||
      !REPORT_ARTIFACT_POLICIES.includes(capability.artifact.policy)
    ) {
      throw new ReportAuthorityCatalogError(
        `${capability.reportType} contains an unsupported behavior policy`,
      );
    }
    if (
      capability.range.policy === 'REQUIRED' &&
      (capability.range.interval !== 'UTC_HALF_OPEN' ||
        capability.range.maximumDurationSeconds !== REPORT_MAX_RANGE_SECONDS ||
        capability.range.futureEnd !== 'FORBIDDEN')
    ) {
      throw new ReportAuthorityCatalogError(
        `${capability.reportType} has a non-canonical required range policy`,
      );
    }
    if (
      capability.name.trim() === '' ||
      capability.description.trim() === '' ||
      !/^[a-z][a-z0-9-]*\.v1$/.test(capability.measurementAuthorityId)
    ) {
      throw new ReportAuthorityCatalogError(
        `${capability.reportType} capability identity is invalid`,
      );
    }
    if (
      !Number.isSafeInteger(capability.preview.maximumRows) ||
      capability.preview.maximumRows < 1
    ) {
      throw new ReportAuthorityCatalogError(
        `${capability.reportType}.preview.maximumRows must be a positive safe integer`,
      );
    }
    if (
      capability.artifact.formats.length !== REPORT_FORMATS.length ||
      capability.artifact.formats.some((format, index) => format !== REPORT_FORMATS[index])
    ) {
      throw new ReportAuthorityCatalogError(
        `${capability.reportType}.artifact.formats must match REPORT_FORMATS`,
      );
    }
    if (capability.artifact.maximumBytes !== REPORT_MAX_ARTIFACT_BYTES) {
      throw new ReportAuthorityCatalogError(
        `${capability.reportType}.artifact.maximumBytes must match REPORT_MAX_ARTIFACT_BYTES`,
      );
    }
    if (authorityIds.has(capability.measurementAuthorityId)) {
      throw new ReportAuthorityCatalogError(
        `duplicate measurement authority reference ${capability.measurementAuthorityId}`,
      );
    }
    authorityIds.add(capability.measurementAuthorityId);
  });

  measurementCatalog.entries.forEach((authority, index) => {
    assertExactKeys(
      authority,
      [
        'authorityId',
        'reportType',
        'owner',
        'state',
        'requiredFacts',
        'blocker',
        'qualifiedAdapter',
      ],
      `${authority.reportType} measurement authority`,
    );
    const capability = capabilityCatalog.entries[index];
    if (!capability || capability.measurementAuthorityId !== authority.authorityId) {
      throw new ReportAuthorityCatalogError(
        `${authority.reportType} does not resolve its exact measurement authority`,
      );
    }
    assertCanonicalStringSet(authority.requiredFacts, `${authority.authorityId}.requiredFacts`);
    if (
      !REPORT_MEASUREMENT_STATES.includes(authority.state) ||
      !/^[a-z][a-z0-9-]*$/.test(authority.owner)
    ) {
      throw new ReportAuthorityCatalogError(
        `${authority.authorityId} measurement policy is invalid`,
      );
    }
    if (authority.state === 'QUALIFIED' && authority.blocker !== null) {
      throw new ReportAuthorityCatalogError(
        `${authority.authorityId} cannot be QUALIFIED with an active blocker`,
      );
    }
    if (authority.state === 'BLOCKED' && (!authority.blocker || authority.blocker.trim() === '')) {
      throw new ReportAuthorityCatalogError(
        `${authority.authorityId} must explain why measurement is blocked`,
      );
    }
    if (authority.state === 'BLOCKED' && authority.qualifiedAdapter !== null) {
      throw new ReportAuthorityCatalogError(
        `${authority.authorityId} cannot bind an adapter while measurement is blocked`,
      );
    }
    if (authority.state === 'QUALIFIED' && authority.qualifiedAdapter === null) {
      throw new ReportAuthorityCatalogError(
        `${authority.authorityId} must bind an exact qualified adapter`,
      );
    }
    if (authority.qualifiedAdapter !== null) {
      assertExactKeys(
        authority.qualifiedAdapter,
        ['adapterId', 'implementationSha256', 'provenanceSha256'],
        `${authority.authorityId} qualified adapter`,
      );
      if (!/^[a-z][a-z0-9.-]*\.v1$/.test(authority.qualifiedAdapter.adapterId)) {
        throw new ReportAuthorityCatalogError(
          `${authority.authorityId} qualified adapter ID is invalid`,
        );
      }
      for (const [field, digest] of [
        ['implementationSha256', authority.qualifiedAdapter.implementationSha256],
        ['provenanceSha256', authority.qualifiedAdapter.provenanceSha256],
      ] as const) {
        if (!/^[0-9a-f]{64}$/.test(digest)) {
          throw new ReportAuthorityCatalogError(
            `${authority.authorityId}.${field} must be a lower-case SHA-256 digest`,
          );
        }
      }
    }
  });

  const capabilitySnapshot: ReportCapabilityCatalogV1 = deepFreeze({
    schemaVersion: capabilityCatalog.schemaVersion,
    entries: capabilityCatalog.entries.map((entry) => ({
      ...entry,
      range: { ...entry.range },
      preview: { ...entry.preview },
      artifact: {
        ...entry.artifact,
        formats: [...entry.artifact.formats],
      },
    })),
  });
  const measurementSnapshot: ReportMeasurementAuthorityCatalogV1 = deepFreeze({
    schemaVersion: measurementCatalog.schemaVersion,
    entries: measurementCatalog.entries.map((entry) => ({
      ...entry,
      requiredFacts: [...entry.requiredFacts],
      qualifiedAdapter: entry.qualifiedAdapter === null ? null : { ...entry.qualifiedAdapter },
    })),
  });
  const capabilityCatalogSha256 = canonicalWireJsonContentSha256V1(capabilitySnapshot);
  const measurementCatalogSha256 = canonicalWireJsonContentSha256V1(measurementSnapshot);
  const graphIdentity = {
    schemaVersion: 'compiled-report-authority-graph.v1',
    capabilityCatalogSha256,
    measurementCatalogSha256,
  } as const;
  return Object.freeze({
    ...graphIdentity,
    capabilityCatalog: capabilitySnapshot,
    measurementCatalog: measurementSnapshot,
    graphSha256: canonicalWireJsonContentSha256V1(graphIdentity),
  });
}

function deepFreeze<T extends object>(value: T): Readonly<T> {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return Object.freeze(value);
}

export const REPORT_CAPABILITY_CATALOG = deepFreeze(capabilityCatalogSource);
export const REPORT_MEASUREMENT_AUTHORITY_CATALOG = deepFreeze(measurementCatalogSource);
export const COMPILED_REPORT_AUTHORITY_GRAPH = compileReportAuthorityGraph(
  REPORT_CAPABILITY_CATALOG,
  REPORT_MEASUREMENT_AUTHORITY_CATALOG,
);

export const REPORT_CAPABILITY_CATALOG_SHA256 =
  COMPILED_REPORT_AUTHORITY_GRAPH.capabilityCatalogSha256;
export const REPORT_MEASUREMENT_AUTHORITY_CATALOG_SHA256 =
  COMPILED_REPORT_AUTHORITY_GRAPH.measurementCatalogSha256;
export const REPORT_AUTHORITY_GRAPH_SHA256 = COMPILED_REPORT_AUTHORITY_GRAPH.graphSha256;

export function isReportType(value: string): value is ReportType {
  return (REPORT_TYPES as readonly string[]).includes(value);
}

export function isReportFormat(value: string): value is ReportFormat {
  return (REPORT_FORMATS as readonly string[]).includes(value);
}

export function getReportCapability(reportType: ReportType): ReportCapabilityV1 {
  return getReportCapabilityFromAuthorityGraph(COMPILED_REPORT_AUTHORITY_GRAPH, reportType);
}

export function getReportCapabilityFromAuthorityGraph(
  authorityGraph: CompiledReportAuthorityGraphV1,
  reportType: ReportType,
): ReportCapabilityV1 {
  const capability = authorityGraph.capabilityCatalog.entries.find(
    (entry) => entry.reportType === reportType,
  );
  if (!capability) {
    throw new ReportAuthorityCatalogError(`missing capability for ${reportType}`);
  }
  return capability;
}

export function getReportMeasurementAuthority(
  reportType: ReportType,
): ReportMeasurementAuthorityV1 {
  return getReportMeasurementAuthorityFromAuthorityGraph(
    COMPILED_REPORT_AUTHORITY_GRAPH,
    reportType,
  );
}

export function getReportMeasurementAuthorityFromAuthorityGraph(
  authorityGraph: CompiledReportAuthorityGraphV1,
  reportType: ReportType,
): ReportMeasurementAuthorityV1 {
  const authority = authorityGraph.measurementCatalog.entries.find(
    (entry) => entry.reportType === reportType,
  );
  if (!authority) {
    throw new ReportAuthorityCatalogError(`missing measurement authority for ${reportType}`);
  }
  return authority;
}

export function reportMeasurementAdapterBuildAttestationSha256(
  attestation: ReportMeasurementAdapterBuildAttestationSourceV1,
): string {
  return canonicalWireJsonContentSha256V1({
    domain: 'aquaculture.report-measurement-adapter-build-attestation.v1',
    schemaVersion: attestation.schemaVersion,
    issuer: attestation.issuer,
    adapterId: attestation.adapterId,
    reportType: attestation.reportType,
    measurementAuthorityId: attestation.measurementAuthorityId,
    implementationSha256: attestation.implementationSha256,
    provenanceSha256: attestation.provenanceSha256,
    authorityGraphSha256: attestation.authorityGraphSha256,
  });
}

export function assertReportMeasurementAdapterBuildAttestationForAuthorityGraph(
  authorityGraph: CompiledReportAuthorityGraphV1,
  attestation: ReportMeasurementAdapterBuildAttestationV1,
): void {
  assertExactKeys(
    attestation,
    [
      'schemaVersion',
      'issuer',
      'adapterId',
      'reportType',
      'measurementAuthorityId',
      'implementationSha256',
      'provenanceSha256',
      'authorityGraphSha256',
      'attestationSha256',
    ],
    'measurement adapter build attestation',
  );
  for (const [field, digest] of [
    ['implementationSha256', attestation.implementationSha256],
    ['provenanceSha256', attestation.provenanceSha256],
    ['authorityGraphSha256', attestation.authorityGraphSha256],
    ['attestationSha256', attestation.attestationSha256],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new ReportAuthorityCatalogError(
        `measurement adapter attestation ${field} must be a lower-case SHA-256 digest`,
      );
    }
  }
  if (
    attestation.schemaVersion !== 'report-measurement-adapter-build-attestation.v1' ||
    attestation.issuer !== 'admin-reporting-build-bootstrap.v1' ||
    !/^[a-z][a-z0-9.-]*\.v1$/.test(attestation.adapterId) ||
    attestation.authorityGraphSha256 !== authorityGraph.graphSha256 ||
    attestation.attestationSha256 !== reportMeasurementAdapterBuildAttestationSha256(attestation)
  ) {
    throw new ReportAuthorityCatalogError(
      'measurement adapter build attestation is stale or non-canonical',
    );
  }
  const authority = getReportMeasurementAuthorityFromAuthorityGraph(
    authorityGraph,
    attestation.reportType,
  );
  const binding = authority.qualifiedAdapter;
  if (
    authority.state !== 'QUALIFIED' ||
    binding === null ||
    attestation.measurementAuthorityId !== authority.authorityId ||
    attestation.adapterId !== binding.adapterId ||
    attestation.implementationSha256 !== binding.implementationSha256 ||
    attestation.provenanceSha256 !== binding.provenanceSha256
  ) {
    throw new ReportAuthorityCatalogError(
      'measurement adapter build attestation does not match the catalog binding',
    );
  }
}

export function compileReportMeasurementAdapterBuildAttestation(
  authorityGraph: CompiledReportAuthorityGraphV1,
  input: ReportMeasurementAdapterBuildAttestationSourceV1,
): ReportMeasurementAdapterBuildAttestationV1 {
  assertExactKeys(
    input,
    [
      'schemaVersion',
      'issuer',
      'adapterId',
      'reportType',
      'measurementAuthorityId',
      'implementationSha256',
      'provenanceSha256',
      'authorityGraphSha256',
    ],
    'measurement adapter build attestation source',
  );
  const coordinates = Object.freeze({
    schemaVersion: input.schemaVersion,
    issuer: input.issuer,
    adapterId: input.adapterId,
    reportType: input.reportType,
    measurementAuthorityId: input.measurementAuthorityId,
    implementationSha256: input.implementationSha256,
    provenanceSha256: input.provenanceSha256,
    authorityGraphSha256: input.authorityGraphSha256,
  });
  const attestation = Object.freeze({
    ...coordinates,
    attestationSha256: reportMeasurementAdapterBuildAttestationSha256(coordinates),
  });
  assertReportMeasurementAdapterBuildAttestationForAuthorityGraph(authorityGraph, attestation);
  return attestation;
}

export function compileReportMeasurementAdapterBuildAttestationSet(
  authorityGraph: CompiledReportAuthorityGraphV1,
  sources: readonly ReportMeasurementAdapterBuildAttestationSourceV1[],
): CompiledReportMeasurementAdapterBuildAttestationSetV1 {
  const attestations = Object.freeze(
    sources.map((source) =>
      compileReportMeasurementAdapterBuildAttestation(authorityGraph, source),
    ),
  );
  const adapterIds = new Set<string>();
  const reportTypes = new Set<ReportType>();
  for (const attestation of attestations) {
    if (adapterIds.has(attestation.adapterId) || reportTypes.has(attestation.reportType)) {
      throw new ReportAuthorityCatalogError(
        'measurement adapter build attestation set contains a duplicate binding',
      );
    }
    adapterIds.add(attestation.adapterId);
    reportTypes.add(attestation.reportType);
  }
  const qualifiedAuthorities = authorityGraph.measurementCatalog.entries.filter(
    (authority) => authority.state === 'QUALIFIED',
  );
  if (
    attestations.length !== qualifiedAuthorities.length ||
    qualifiedAuthorities.some(
      (authority) =>
        authority.qualifiedAdapter === null ||
        !adapterIds.has(authority.qualifiedAdapter.adapterId) ||
        !reportTypes.has(authority.reportType),
    )
  ) {
    throw new ReportAuthorityCatalogError(
      'measurement adapter build attestation set is not equal to the qualified catalog bindings',
    );
  }
  const coordinates = Object.freeze({
    schemaVersion: 'report-measurement-adapter-build-attestation-set.v1' as const,
    authorityGraphSha256: authorityGraph.graphSha256,
    attestations,
  });
  return Object.freeze({
    ...coordinates,
    setSha256: canonicalWireJsonContentSha256V1({
      domain: 'aquaculture.report-measurement-adapter-build-attestation-set.v1',
      ...coordinates,
    }),
  });
}

export function assertReportArtifactSize(reportType: ReportType, byteLength: number): void {
  assertReportArtifactSizeForAuthorityGraph(
    COMPILED_REPORT_AUTHORITY_GRAPH,
    reportType,
    byteLength,
  );
}

export function assertReportArtifactSizeForAuthorityGraph(
  authorityGraph: CompiledReportAuthorityGraphV1,
  reportType: ReportType,
  byteLength: number,
): void {
  const maximumBytes = getReportCapabilityFromAuthorityGraph(authorityGraph, reportType).artifact
    .maximumBytes;
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maximumBytes) {
    throw new ReportAuthorityCatalogError(
      `${reportType} artifact byte length must be between 0 and ${maximumBytes}`,
    );
  }
}

export function assertReportArtifactCommitTransition(
  previous: ReportArtifactCommitState | null,
  next: ReportArtifactCommitState,
): void {
  const expected =
    previous === null
      ? 'INTENT_CREATED'
      : previous === 'INTENT_CREATED'
        ? 'BYTES_VERIFIED'
        : previous === 'BYTES_VERIFIED'
          ? 'REFERENCE_COMMITTED'
          : null;
  if (next !== expected) {
    throw new ReportAuthorityCatalogError(
      `illegal report artifact commit transition ${previous ?? 'NONE'} -> ${next}`,
    );
  }
}

export function reportPreviewSha256(
  reportType: ReportType,
  totalRowCount: number,
  rows: readonly Readonly<Record<string, unknown>>[],
): string {
  if (!Number.isSafeInteger(totalRowCount) || totalRowCount < rows.length) {
    throw new ReportAuthorityCatalogError(
      'preview totalRowCount must be a safe integer greater than or equal to the row sample',
    );
  }
  return canonicalWireJsonContentSha256V1({ reportType, totalRowCount, rows });
}

export function reportMeasurementIntentSha256(input: {
  readonly reportType: ReportType;
  readonly startInclusiveUtc: string | null;
  readonly endExclusiveUtc: string | null;
  readonly filters: Readonly<Record<string, unknown>> | null;
}): string {
  return canonicalWireJsonContentSha256V1({
    domain: 'aquaculture.report-measurement-intent.v1',
    reportType: input.reportType,
    startInclusiveUtc: input.startInclusiveUtc,
    endExclusiveUtc: input.endExclusiveUtc,
    filters: input.filters,
  });
}

function parseCanonicalUtcInstant(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new ReportAuthorityCatalogError(`${field} must be a canonical UTC instant`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ReportAuthorityCatalogError(`${field} must be a canonical UTC instant`);
  }
  return parsed;
}

export interface CompileReportMeasurementIntentInputV1 {
  readonly reportType: ReportType;
  readonly startInclusiveUtc: string | null;
  readonly endExclusiveUtc: string | null;
  readonly filters: Readonly<Record<string, unknown>> | null;
  readonly currentTimeUtc: string;
}

export function compileReportMeasurementIntent(
  input: CompileReportMeasurementIntentInputV1,
): ReportMeasurementIntentV1 {
  return compileReportMeasurementIntentForAuthorityGraph(COMPILED_REPORT_AUTHORITY_GRAPH, input);
}

export function compileReportMeasurementIntentForAuthorityGraph(
  authorityGraph: CompiledReportAuthorityGraphV1,
  input: CompileReportMeasurementIntentInputV1,
): ReportMeasurementIntentV1 {
  const capability = getReportCapabilityFromAuthorityGraph(authorityGraph, input.reportType);
  const filters =
    input.filters === null
      ? null
      : (() => {
          const budget: ReportDatasetSnapshotBudget = { nodeCount: 0 };
          const snapshot = snapshotPortableReportJson(input.filters, '$.filters', 0, budget);
          if (!isPortableReportRecord(snapshot)) {
            throw new ReportAuthorityCatalogError('$.filters must be a JSON object');
          }
          return snapshot;
        })();
  if (capability.range.policy === 'FORBIDDEN') {
    if (input.startInclusiveUtc !== null || input.endExclusiveUtc !== null) {
      throw new ReportAuthorityCatalogError(`${input.reportType} does not accept a date range`);
    }
  } else {
    if (input.startInclusiveUtc === null || input.endExclusiveUtc === null) {
      throw new ReportAuthorityCatalogError(
        `${input.reportType} requires an exact startDate and endDate`,
      );
    }
    const start = parseCanonicalUtcInstant(input.startInclusiveUtc, 'startInclusiveUtc');
    const end = parseCanonicalUtcInstant(input.endExclusiveUtc, 'endExclusiveUtc');
    const current = parseCanonicalUtcInstant(input.currentTimeUtc, 'currentTimeUtc');
    if (start.getTime() >= end.getTime()) {
      throw new ReportAuthorityCatalogError(
        'report range must be a non-empty UTC half-open interval',
      );
    }
    const durationSeconds = (end.getTime() - start.getTime()) / 1_000;
    if (durationSeconds > capability.range.maximumDurationSeconds) {
      throw new ReportAuthorityCatalogError(
        `${input.reportType} range exceeds ${capability.range.maximumDurationSeconds} seconds`,
      );
    }
    if (end.getTime() > current.getTime()) {
      throw new ReportAuthorityCatalogError(`${input.reportType} range cannot end in the future`);
    }
  }
  const intentCoordinates = Object.freeze({
    schemaVersion: 'report-measurement-intent.v1' as const,
    reportType: input.reportType,
    startInclusiveUtc: input.startInclusiveUtc,
    endExclusiveUtc: input.endExclusiveUtc,
    filters,
  });
  return Object.freeze({
    ...intentCoordinates,
    intentSha256: reportMeasurementIntentSha256(intentCoordinates),
  });
}

export function reportDatasetSha256(input: {
  readonly reportType: ReportType;
  readonly intentSha256: string;
  readonly measuredAt: string;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly summary: Readonly<Record<string, unknown>>;
}): string {
  return canonicalWireJsonContentSha256V1({
    domain: 'aquaculture.measured-report-dataset.v1',
    ...input,
  });
}

interface ReportDatasetSnapshotBudget {
  nodeCount: number;
}

function snapshotPortableReportJson(
  value: unknown,
  path: string,
  depth: number,
  budget: ReportDatasetSnapshotBudget,
): ReportPortableJsonValue {
  budget.nodeCount += 1;
  if (budget.nodeCount > REPORT_MAX_DATASET_NODES) {
    throw new ReportAuthorityCatalogError(
      `report dataset exceeds ${REPORT_MAX_DATASET_NODES} JSON nodes`,
    );
  }
  if (depth > REPORT_MAX_DATASET_DEPTH) {
    throw new ReportAuthorityCatalogError(
      `report dataset exceeds depth ${REPORT_MAX_DATASET_DEPTH} at ${path}`,
    );
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ReportAuthorityCatalogError(`${path} contains a non-finite number`);
    }
    return value;
  }
  if (typeof value !== 'object') {
    throw new ReportAuthorityCatalogError(`${path} contains a non-JSON value`);
  }
  if (Array.isArray(value)) {
    const snapshot: ReportPortableJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(value, index)) {
        throw new ReportAuthorityCatalogError(`${path} contains a sparse array`);
      }
      snapshot.push(
        snapshotPortableReportJson(value[index], `${path}[${index}]`, depth + 1, budget),
      );
    }
    return Object.freeze(snapshot);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ReportAuthorityCatalogError(`${path} must contain only plain JSON objects`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.some((key) => typeof key !== 'string')) {
    throw new ReportAuthorityCatalogError(`${path} contains a symbol-keyed field`);
  }
  const snapshot: Record<string, ReportPortableJsonValue> = {};
  for (const key of Object.keys(descriptors).sort()) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value')
    ) {
      throw new ReportAuthorityCatalogError(`${path}.${key} must be an enumerable data property`);
    }
    snapshot[key] = snapshotPortableReportJson(
      descriptor.value,
      `${path}.${key}`,
      depth + 1,
      budget,
    );
  }
  return Object.freeze(snapshot);
}

function isPortableReportRecord(value: ReportPortableJsonValue): value is ReportPortableJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function compileReportDatasetSnapshot(input: {
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly summary: Readonly<Record<string, unknown>>;
}): CompiledReportDatasetSnapshotV1 {
  if (input.rows.length > REPORT_MAX_DATASET_ROWS) {
    throw new ReportAuthorityCatalogError(`report dataset exceeds ${REPORT_MAX_DATASET_ROWS} rows`);
  }
  const budget: ReportDatasetSnapshotBudget = { nodeCount: 0 };
  const rows = input.rows.map((inputRow, index) => {
    const row = snapshotPortableReportJson(inputRow, `$.rows[${index}]`, 0, budget);
    if (!isPortableReportRecord(row)) {
      throw new ReportAuthorityCatalogError(`$.rows[${index}] must be a JSON object`);
    }
    return row;
  });
  const summary = snapshotPortableReportJson(input.summary, '$.summary', 0, budget);
  if (!isPortableReportRecord(summary)) {
    throw new ReportAuthorityCatalogError('$.summary must be a JSON object');
  }
  const frozenRows = Object.freeze(rows);
  const canonicalByteLength = new TextEncoder().encode(
    canonicalWireJsonStringifyV1({ rows: frozenRows, summary }),
  ).byteLength;
  if (canonicalByteLength > REPORT_MAX_ARTIFACT_BYTES) {
    throw new ReportAuthorityCatalogError(
      `report dataset exceeds ${REPORT_MAX_ARTIFACT_BYTES} canonical JSON bytes`,
    );
  }
  return Object.freeze({
    rows: frozenRows,
    summary,
    canonicalByteLength,
  });
}

export function reportMeasurementProofSha256(proof: ReportMeasurementProofV1): string {
  return canonicalWireJsonContentSha256V1({
    domain: 'aquaculture.report-measurement-proof.v1',
    proof,
  });
}

export function assertCurrentReportMeasurementProof(
  proof: ReportMeasurementProofV1,
  expected: {
    readonly reportType: ReportType;
    readonly intentSha256: string;
    readonly proofSha256: string;
  },
): void {
  assertReportMeasurementProofForAuthorityGraph(COMPILED_REPORT_AUTHORITY_GRAPH, proof, expected);
}

export function assertReportMeasurementProofForAuthorityGraph(
  authorityGraph: CompiledReportAuthorityGraphV1,
  proof: ReportMeasurementProofV1,
  expected: {
    readonly reportType: ReportType;
    readonly intentSha256: string;
    readonly proofSha256: string;
  },
): void {
  assertExactKeys(
    proof,
    [
      'schemaVersion',
      'reportType',
      'intentSha256',
      'capabilityCatalogSha256',
      'measurementCatalogSha256',
      'authorityGraphSha256',
      'measurementAuthorityId',
      'adapterId',
      'adapterImplementationSha256',
      'adapterProvenanceSha256',
      'measuredAt',
      'datasetSha256',
      'factEvidence',
    ],
    'measurement proof',
  );
  for (const [field, digest] of [
    ['intentSha256', proof.intentSha256],
    ['capabilityCatalogSha256', proof.capabilityCatalogSha256],
    ['measurementCatalogSha256', proof.measurementCatalogSha256],
    ['authorityGraphSha256', proof.authorityGraphSha256],
    ['adapterImplementationSha256', proof.adapterImplementationSha256],
    ['adapterProvenanceSha256', proof.adapterProvenanceSha256],
    ['datasetSha256', proof.datasetSha256],
    ['proofSha256', expected.proofSha256],
  ] as const) {
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new ReportAuthorityCatalogError(
        `measurement proof ${field} must be a lower-case SHA-256 digest`,
      );
    }
  }
  if (
    proof.schemaVersion !== 'report-measurement-proof.v1' ||
    proof.reportType !== expected.reportType ||
    proof.intentSha256 !== expected.intentSha256 ||
    proof.capabilityCatalogSha256 !== authorityGraph.capabilityCatalogSha256 ||
    proof.measurementCatalogSha256 !== authorityGraph.measurementCatalogSha256 ||
    proof.authorityGraphSha256 !== authorityGraph.graphSha256 ||
    reportMeasurementProofSha256(proof) !== expected.proofSha256
  ) {
    throw new ReportAuthorityCatalogError(
      'measurement proof does not match current execution coordinates',
    );
  }
  const measuredAt = new Date(proof.measuredAt);
  if (Number.isNaN(measuredAt.getTime()) || measuredAt.toISOString() !== proof.measuredAt) {
    throw new ReportAuthorityCatalogError(
      'measurement proof measuredAt must be a canonical UTC instant',
    );
  }
  const authority = getReportMeasurementAuthorityFromAuthorityGraph(
    authorityGraph,
    expected.reportType,
  );
  const adapter = authority.qualifiedAdapter;
  if (
    authority.state !== 'QUALIFIED' ||
    adapter === null ||
    proof.measurementAuthorityId !== authority.authorityId ||
    proof.adapterId !== adapter.adapterId ||
    proof.adapterImplementationSha256 !== adapter.implementationSha256 ||
    proof.adapterProvenanceSha256 !== adapter.provenanceSha256
  ) {
    throw new ReportAuthorityCatalogError(
      'measurement proof is not bound to the catalog-qualified adapter',
    );
  }
  if (proof.factEvidence.length !== authority.requiredFacts.length) {
    throw new ReportAuthorityCatalogError('measurement proof has incomplete fact evidence');
  }
  proof.factEvidence.forEach((fact, index) => {
    assertExactKeys(fact, ['factId', 'sourceCutSha256'], `measurement proof fact ${index}`);
    if (
      fact.factId !== authority.requiredFacts[index] ||
      !/^[0-9a-f]{64}$/.test(fact.sourceCutSha256)
    ) {
      throw new ReportAuthorityCatalogError(
        'measurement proof fact evidence is stale or non-canonical',
      );
    }
  });
}

export function reportAuthorityGraphCanonicalJson(): string {
  return canonicalWireJsonStringifyV1(COMPILED_REPORT_AUTHORITY_GRAPH);
}
