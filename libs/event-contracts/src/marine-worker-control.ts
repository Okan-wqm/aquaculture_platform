import type { MarineAnalysisJobKind } from './marine-events';

/** Exact Core NATS subjects used by the Rust worker control connection. */
export const MARINE_WORKER_CONTROL_SUBJECTS = {
  EXECUTION_LEASE: 'request.farm.marineExecutionLease',
  EXECUTION_RENEW: 'request.farm.marineExecutionRenew',
  CREDENTIAL_LEASE: 'request.farm.marineCredentialLease',
  USAGE_RESERVE: 'request.farm.marineUsageReserve',
  USAGE_FINALIZE: 'request.farm.marineUsageFinalize',
  ARTIFACT_LEASE: 'request.farm.marineArtifactLease',
  EXECUTION_FINALIZE: 'request.farm.marineExecutionFinalize',
} as const;

export type MarineWorkerControlSubject =
  (typeof MARINE_WORKER_CONTROL_SUBJECTS)[keyof typeof MARINE_WORKER_CONTROL_SUBJECTS];

/** Broker-enforced reply namespace; the connection appends its random NUID. */
export const MARINE_WORKER_SCOPED_INBOX_PREFIX = '_INBOXMARINEANALYSIS' as const;

export const MARINE_DATA_ROLES = ['ANALYSIS', 'FORECAST', 'REANALYSIS', 'HINDCAST'] as const;
export type MarineDataRole = (typeof MARINE_DATA_ROLES)[number];

export const MARINE_CREDENTIAL_KINDS = ['CMEMS_USERNAME_PASSWORD'] as const;
export type MarineCredentialKind = (typeof MARINE_CREDENTIAL_KINDS)[number];

export const MARINE_USAGE_OPERATION_TYPES_BY_PROVIDER = {
  CMEMS: ['CMEMS_DESCRIBE', 'CMEMS_GET', 'CMEMS_SUBSET'],
} as const;

export const MARINE_USAGE_OPERATION_TYPES = [
  ...MARINE_USAGE_OPERATION_TYPES_BY_PROVIDER.CMEMS,
] as const;
export type MarineUsageOperationType = (typeof MARINE_USAGE_OPERATION_TYPES)[number];

export const MARINE_USAGE_OUTCOMES = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type MarineUsageOutcome = (typeof MARINE_USAGE_OUTCOMES)[number];

export const MARINE_PROVIDER_STATUS_KINDS = ['HTTP', 'TOOL_EXIT', 'NOT_AVAILABLE'] as const;
export type MarineProviderStatusKind = (typeof MARINE_PROVIDER_STATUS_KINDS)[number];

export const MARINE_EXECUTION_TERMINAL_STATES = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const;
export type MarineExecutionTerminalState = (typeof MARINE_EXECUTION_TERMINAL_STATES)[number];

export const MARINE_EXECUTION_STAGES = [
  'PREPARING',
  'PROVIDER_CALL',
  'PROCESSING',
  'UPLOADING',
  'FINALIZING',
] as const;
export type MarineExecutionStage = (typeof MARINE_EXECUTION_STAGES)[number];

export const MARINE_EXECUTION_STOP_REASONS = [
  'CANCEL_REQUESTED',
  'FEATURE_DISABLED',
  'CREDENTIAL_REVOKED',
  'LEASE_FENCED',
  'DEADLINE_EXCEEDED',
] as const;
export type MarineExecutionStopReason = (typeof MARINE_EXECUTION_STOP_REASONS)[number];

export const MARINE_ARTIFACT_KINDS = [
  'SOURCE_ZARR',
  'RASTER_COG',
  'DISPLAY_PNG',
  'VECTOR_JSON',
  'STATISTICS_JSON',
  'TIME_SERIES_JSON',
  'MANIFEST',
] as const;
export type MarineArtifactKind = (typeof MARINE_ARTIFACT_KINDS)[number];

/** Canonical leaf names beneath the content-addressed marine object prefix. */
export const MARINE_ARTIFACT_FILE_NAMES: Readonly<Record<MarineArtifactKind, string>> = {
  SOURCE_ZARR: 'source.zarr.zip',
  RASTER_COG: 'raster.cog.tif',
  DISPLAY_PNG: 'display.png',
  VECTOR_JSON: 'vector.json',
  STATISTICS_JSON: 'statistics.json',
  TIME_SERIES_JSON: 'time-series.json',
  MANIFEST: 'manifest.json',
};

/** Largest integer that has identical, lossless JSON semantics in TypeScript and Rust. */
export const MARINE_MAX_SAFE_INTEGER = 9_007_199_254_740_991 as const;

/** Maximum accepted responder clock lead when consuming a fresh lease. */
export const MARINE_MAX_CLOCK_SKEW_SECONDS = 5 as const;

/** Immutable catalogue identity embedded in every provider selection lease. */
export const MARINE_SELECTION_CATALOG_SCHEMA_VERSION = 2;
export const MARINE_SELECTION_CATALOG_VERSION = '2026-07-19.2';
export const MARINE_SELECTION_CATALOG_REVISION =
  '6776655b7961f860ec5b88ce02e6b5b41b18296367da07229f8ff5c17d339e5b';

export type MarineSelectionDataKind = 'SCALAR' | 'VECTOR';

export interface MarineSelectionVariable {
  id: string;
  unit: string;
}

export interface MarineSelectionSpatialResolution {
  x: number;
  y: number;
  unit: 'degree';
}

export interface MarineCmemsDepthSelection {
  semantics: 'DEPTH_BELOW_SEA_SURFACE';
  method: 'strict-inside';
  verticalAxis: 'depth';
  positiveDirection: 'DOWN';
  unit: 'm';
  levelCount: number;
  coordinateValuesSource: 'PROVIDER_DATASET_METADATA';
  outOfBounds: 'REJECT';
  raiseIfUpdating: true;
}

export interface MarineCmemsVectorDerivation {
  version: 1;
  eastwardVariable: 'uo';
  northwardVariable: 'vo';
  speed: {
    id: 'speed';
    formula: 'sqrt(uo^2 + vo^2)';
    unit: 'm s-1';
  };
  bearing: {
    id: 'bearing';
    formula: '(atan2(uo, vo) * 180 / pi + 360) % 360';
    unit: 'degrees_true';
    convention: 'clockwise_from_true_north_toward_flow';
  };
}

export interface MarineCmemsSelectionProcessing {
  providerLevel: 'L4';
  toolboxVersion: '2.4.1';
  derivationId: 'marine.cmems.raw-scalar' | 'marine.cmems.raw-uv-speed-bearing';
  derivationVersion: 1;
  vectorDerivation: MarineCmemsVectorDerivation | null;
}

export interface MarineCmemsSelectionNoData {
  rule: 'EXCLUDE_METADATA_NODATA_AND_NON_FINITE';
  valueSource: 'PROVIDER_VARIABLE_METADATA';
  metadataKeysInPriorityOrder: ['_FillValue', 'missing_value'];
  onMissingValue: 'REJECT';
}

export interface MarineCmemsToolboxLock {
  schemaVersion: 1;
  tool: 'copernicusmarine';
  version: '2.4.1';
  artifact: {
    name: 'copernicusmarine_linux-glibc-2.35.cli';
    sizeBytes: 154166192;
    sha256: 'e65f72db9fc7075f91fc9bd90368246248aa39a599a8a79eb4d06a5705b15864';
  };
}

/** Closed provider-rendering selection; it is display-only and never numeric input. */
export interface MarineCmemsDisplaySelection {
  wmtsCapabilitiesUrl: string;
  variable: string;
  style: string;
  legendId: string;
  legendPolicyId: 'legend-policy.cmems.wmts-getlegend.v1';
  artifact: {
    dataKind: 'RASTER';
    mediaType: 'image/png';
    authority: 'DISPLAY_ONLY';
  };
}

/** Full immutable CMEMS credit/citation input copied from the farm catalogue. */
export interface MarineCmemsAttributionSelection {
  id: string;
  provider: 'COPERNICUS_MARINE';
  creditTemplate: string;
  citationTemplate: string;
  requiredTemplateVariables: ['ACCESSED_ON'];
  doi: string;
  doiUrl: string;
  sourceUrl: string;
  guidanceUrl: string;
}

/** Closed CMEMS provenance resolved by farm-service before a worker claim. */
export interface MarineSelectionProvenance {
  catalogSchemaVersion: 2;
  catalogVersion: '2026-07-19.2';
  catalogRevision: '6776655b7961f860ec5b88ce02e6b5b41b18296367da07229f8ff5c17d339e5b';
  catalogEntryId: string;
  provider: 'CMEMS';
  dataKind: MarineSelectionDataKind;
  productId: string;
  datasetId: string;
  datasetVersionPart: string;
  variables: readonly MarineSelectionVariable[];
  spatialResolution: MarineSelectionSpatialResolution;
  depthSelection: MarineCmemsDepthSelection;
  selectionMethodId: 'cmems.toolbox.strict-inside.depth.v1';
  processing: MarineCmemsSelectionProcessing;
  noData: MarineCmemsSelectionNoData;
  /** Required for wire compatibility; CMEMS selections carry explicit null. */
  recipeSha256: null;
  display: MarineCmemsDisplaySelection;
  attribution: MarineCmemsAttributionSelection;
  toolbox: MarineCmemsToolboxLock;
}

/** Claim request bound to the immutable fingerprint from the durable event. */
export interface MarineExecutionLeaseRequest {
  tenantId: string;
  jobId: string;
  executionId: string;
  nonce: string;
  requestFingerprint: string;
  /** Immutable user-request timestamp carried from the durable job state. */
  requestedAt: string;
}

/**
 * Secret-free, immutable execution specification returned by farm-service.
 * Nullable values are explicit so the Rust serde shape cannot confuse a
 * missing field with an old contract version.
 */
export interface MarineExecutionLeaseReply {
  leaseId: string;
  /** Stable fencing epoch for this claim; only a takeover may increment it. */
  leaseVersion: number;
  issuedAt: string;
  expiresAt: string;
  renewAfterSeconds: number;
  tenantId: string;
  jobId: string;
  executionId: string;
  requestFingerprint: string;
  requestedAt: string;
  siteId: string;
  marineAreaId: string;
  marineAreaRevision: number;
  marineAreaSha256: string;
  marineAreaGeoJson: string;
  provider: 'CMEMS';
  jobKind: MarineAnalysisJobKind;
  credentialGeneration: number;
  selectionProvenance: MarineSelectionProvenance;
  dataRole: MarineDataRole;
  /** Analysis/forecast partition boundary; null for unpartitioned temporal roles. */
  temporalPartitionBoundaryAt: string | null;
  /** Provider coverage observed and persisted when the immutable selection was made. */
  providerCoverageStart: string;
  providerCoverageEnd: string;
  timeStart: string;
  timeEnd: string;
  depthMinMeters: number | null;
  depthMaxMeters: number | null;
  sourceSnapshotJobId: string | null;
  maxCells: number;
  maxTimeSteps: number;
  maxOutputBytes: number;
  maxScratchBytes: number;
  deadlineAt: string;
}

/** Heartbeat and cancellation checkpoint for a previously claimed execution. */
export interface MarineExecutionRenewRequest {
  tenantId: string;
  jobId: string;
  executionId: string;
  executionLeaseId: string;
  leaseVersion: number;
  nonce: string;
  stage: MarineExecutionStage;
}

export type MarineExecutionRenewReply =
  | {
      decision: 'CONTINUE';
      executionLeaseId: string;
      leaseVersion: number;
      issuedAt: string;
      expiresAt: string;
    }
  | {
      decision: 'STOP';
      executionLeaseId: string;
      leaseVersion: number;
      reason: MarineExecutionStopReason;
    };

/** Exact credential request authorized from job state, never caller headers. */
export interface MarineCredentialLeaseRequest {
  tenantId: string;
  jobId: string;
  executionId: string;
  executionLeaseId: string;
  leaseVersion: number;
  provider: 'CMEMS';
  credentialGeneration: number;
  nonce: string;
}

interface MarineCredentialLeaseReplyBase {
  leaseId: string;
  issuedAt: string;
  expiresAt: string;
  generation: number;
}

export interface MarineCmemsCredentialValue {
  username: string;
  password: string;
}

/**
 * The sole contract in this module that intentionally carries secret material.
 * It may travel only on the broker-scoped reply inbox and must never be logged
 * or persisted by the requester.
 */
export interface MarineCredentialLeaseReply extends MarineCredentialLeaseReplyBase {
  kind: 'CMEMS_USERNAME_PASSWORD';
  value: MarineCmemsCredentialValue;
}

/** Stable lineage reservation written before an external provider call. */
export interface MarineUsageReserveRequest {
  tenantId: string;
  jobId: string;
  executionId: string;
  executionLeaseId: string;
  leaseVersion: number;
  operationId: string;
  idempotencyKey: string;
  provider: 'CMEMS';
  operationType: MarineUsageOperationType;
  requestFingerprint: string;
}

export interface MarineUsageReserveReply {
  operationId: string;
  state: 'RESERVED';
  attempt: number;
  reservedAt: string;
  replayed: boolean;
}

/** Final accounting for the same operation lineage reserved before the call. */
export interface MarineUsageFinalizeRequest {
  tenantId: string;
  jobId: string;
  executionId: string;
  executionLeaseId: string;
  leaseVersion: number;
  operationId: string;
  idempotencyKey: string;
  outcome: MarineUsageOutcome;
  providerStatusKind: MarineProviderStatusKind;
  providerStatusCode: number | null;
  providerRequestId: string | null;
  processingUnits: number | null;
  bytesIn: number;
  bytesOut: number;
  durationMs: number;
  failureCode: string | null;
  finishedAt: string;
}

export interface MarineUsageFinalizeReply {
  operationId: string;
  state: MarineUsageOutcome;
  attempt: number;
  finalizedAt: string;
  replayed: boolean;
}

interface MarineArtifactLeaseRequestBase {
  tenantId: string;
  /** Farm-service must match this asserted lookup key to the active/source job. */
  siteId: string;
  jobId: string;
  executionId: string;
  executionLeaseId: string;
  leaseVersion: number;
  nonce: string;
  artifactKind: MarineArtifactKind;
}

/**
 * Request a short-lived object-store capability. Object keys and prefixes are
 * deliberately absent: farm-service derives the exact key from authoritative
 * job state and the content hash.
 */
export type MarineArtifactLeaseRequest = MarineArtifactLeaseRequestBase &
  (
    | {
        mode: 'READ';
        sourceSnapshotJobId: string;
        artifactSha256: string;
      }
    | {
        mode: 'WRITE';
        mediaType: string;
        byteLength: number;
        contentSha256: string;
      }
  );

interface MarineArtifactLeaseReplyBase {
  leaseId: string;
  issuedAt: string;
  /** Secret capability: never persist or log this URL. */
  url: string;
  objectKey: string;
  expiresAt: string;
}

export interface MarineArtifactPutHeaders {
  'content-type': string;
  'content-length': string;
  'x-amz-checksum-sha256': string;
  'if-none-match': '*';
}

export type MarineArtifactLeaseReply = MarineArtifactLeaseReplyBase &
  (
    | {
        method: 'GET';
        requiredHeaders: Readonly<Record<string, never>>;
      }
    | {
        method: 'PUT';
        requiredHeaders: Readonly<MarineArtifactPutHeaders>;
      }
  );

/** Persist a terminal execution state before the JetStream message is acked. */
export interface MarineExecutionFinalizeRequest {
  tenantId: string;
  jobId: string;
  executionId: string;
  executionLeaseId: string;
  leaseVersion: number;
  idempotencyKey: string;
  requestFingerprint: string;
  terminalState: MarineExecutionTerminalState;
  resultManifestKey: string | null;
  resultManifestSha256: string | null;
  failureCode: string | null;
  retryable: boolean;
  finishedAt: string;
}

export interface MarineExecutionFinalizeReply {
  jobId: string;
  executionId: string;
  state: MarineExecutionTerminalState;
  finalizedAt: string;
  manifestVerified: boolean;
  replayed: boolean;
}

/** Compile-time subject-to-wire mapping shared by responder and requester. */
export interface MarineWorkerControlContracts {
  [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE]: {
    request: MarineExecutionLeaseRequest;
    reply: MarineExecutionLeaseReply;
  };
  [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_RENEW]: {
    request: MarineExecutionRenewRequest;
    reply: MarineExecutionRenewReply;
  };
  [MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE]: {
    request: MarineCredentialLeaseRequest;
    reply: MarineCredentialLeaseReply;
  };
  [MARINE_WORKER_CONTROL_SUBJECTS.USAGE_RESERVE]: {
    request: MarineUsageReserveRequest;
    reply: MarineUsageReserveReply;
  };
  [MARINE_WORKER_CONTROL_SUBJECTS.USAGE_FINALIZE]: {
    request: MarineUsageFinalizeRequest;
    reply: MarineUsageFinalizeReply;
  };
  [MARINE_WORKER_CONTROL_SUBJECTS.ARTIFACT_LEASE]: {
    request: MarineArtifactLeaseRequest;
    reply: MarineArtifactLeaseReply;
  };
  [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_FINALIZE]: {
    request: MarineExecutionFinalizeRequest;
    reply: MarineExecutionFinalizeReply;
  };
}

export type MarineWorkerControlRequest<S extends MarineWorkerControlSubject> =
  MarineWorkerControlContracts[S]['request'];

export type MarineWorkerControlReply<S extends MarineWorkerControlSubject> =
  MarineWorkerControlContracts[S]['reply'];
