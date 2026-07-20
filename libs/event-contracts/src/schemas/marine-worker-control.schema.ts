import type { JSONSchemaType } from 'ajv';

import { MARINE_ANALYSIS_JOB_KINDS } from '../marine-events';
import {
  MARINE_ARTIFACT_FILE_NAMES,
  MARINE_ARTIFACT_KINDS,
  MARINE_CREDENTIAL_KINDS,
  MARINE_DATA_ROLES,
  MARINE_EXECUTION_STAGES,
  MARINE_EXECUTION_STOP_REASONS,
  MARINE_EXECUTION_TERMINAL_STATES,
  MARINE_MAX_SAFE_INTEGER,
  MARINE_PROVIDER_STATUS_KINDS,
  MARINE_SELECTION_CATALOG_REVISION,
  MARINE_SELECTION_CATALOG_SCHEMA_VERSION,
  MARINE_SELECTION_CATALOG_VERSION,
  MARINE_USAGE_OPERATION_TYPES,
  MARINE_USAGE_OUTCOMES,
  MARINE_WORKER_CONTROL_SUBJECTS,
  type MarineArtifactLeaseReply,
  type MarineArtifactLeaseRequest,
  type MarineCredentialLeaseReply,
  type MarineCredentialLeaseRequest,
  type MarineExecutionFinalizeReply,
  type MarineExecutionFinalizeRequest,
  type MarineExecutionLeaseReply,
  type MarineExecutionLeaseRequest,
  type MarineExecutionRenewReply,
  type MarineExecutionRenewRequest,
  type MarineSelectionProvenance,
  type MarineUsageFinalizeReply,
  type MarineUsageFinalizeRequest,
  type MarineUsageReserveReply,
  type MarineUsageReserveRequest,
  type MarineWorkerControlContracts,
  type MarineWorkerControlSubject,
} from '../marine-worker-control';
import { UTC_MILLISECOND_TIMESTAMP_SCHEMA, UUID_PATTERN, UUID_SCHEMA } from './common.schema';

const SHA256_PATTERN = '^[a-f0-9]{64}$';
const NONCE_PATTERN = '^[A-Za-z0-9_-]{16,128}$';
const SAFE_IDENTIFIER_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$';
const FAILURE_CODE_PATTERN = '^[A-Z][A-Z0-9_]{0,63}$';
const UUID_PATH_SEGMENT = UUID_PATTERN.slice(1, -1);
const ARTIFACT_FILE_NAME_PATTERN = Object.values(MARINE_ARTIFACT_FILE_NAMES)
  .map((fileName) => fileName.replaceAll('.', '\\.'))
  .join('|');
const ARTIFACT_OBJECT_KEY_PATTERN =
  `^marine/${UUID_PATH_SEGMENT}/${UUID_PATH_SEGMENT}/${UUID_PATH_SEGMENT}/` +
  `${SHA256_PATTERN.slice(1, -1)}/(?:${ARTIFACT_FILE_NAME_PATTERN})$`;
const RESULT_MANIFEST_KEY_PATTERN =
  `^marine/${UUID_PATH_SEGMENT}/${UUID_PATH_SEGMENT}/${UUID_PATH_SEGMENT}/` +
  `${SHA256_PATTERN.slice(1, -1)}/manifest\\.json$`;

const MAX_GENERATION = MARINE_MAX_SAFE_INTEGER;
const MAX_ATTEMPT = 1_000;
const MAX_VARIABLES = 32;
const MAX_GEOJSON_BYTES = 262_144;
const MAX_RESULT_BYTES = 268_435_456;
const MAX_SCRATCH_BYTES = 1_073_741_824;
const MAX_ARTIFACT_HEADERS = 4;
const MAX_ARTIFACT_URL_LENGTH = 4_096;
const MAX_MEDIA_TYPE_LENGTH = 255;

/** AJV's generic cannot represent a required property whose sole TS value is null. */
type MarineSelectionProvenanceSchemaShape = Omit<MarineSelectionProvenance, 'recipeSha256'> & {
  recipeSha256: string | null;
};

type MarineExecutionLeaseReplySchemaShape = Omit<
  MarineExecutionLeaseReply,
  'selectionProvenance'
> & {
  selectionProvenance: MarineSelectionProvenanceSchemaShape;
};

const executionLeaseRequestSchema: JSONSchemaType<MarineExecutionLeaseRequest> = {
  type: 'object',
  properties: {
    tenantId: UUID_SCHEMA,
    jobId: UUID_SCHEMA,
    executionId: UUID_SCHEMA,
    nonce: { type: 'string', pattern: NONCE_PATTERN },
    requestFingerprint: { type: 'string', pattern: SHA256_PATTERN },
    requestedAt: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
  },
  required: ['tenantId', 'jobId', 'executionId', 'nonce', 'requestFingerprint', 'requestedAt'],
  additionalProperties: false,
};

const selectionProvenanceSchema: JSONSchemaType<MarineSelectionProvenanceSchemaShape> = {
  type: 'object',
  properties: {
    catalogSchemaVersion: {
      type: 'integer',
      const: MARINE_SELECTION_CATALOG_SCHEMA_VERSION,
    },
    catalogVersion: {
      type: 'string',
      const: MARINE_SELECTION_CATALOG_VERSION,
    },
    catalogRevision: {
      type: 'string',
      const: MARINE_SELECTION_CATALOG_REVISION,
      pattern: SHA256_PATTERN,
    },
    catalogEntryId: {
      type: 'string',
      pattern: '^cmems\\.[a-z0-9.-]{1,248}$',
      maxLength: 255,
    },
    provider: { type: 'string', const: 'CMEMS' },
    dataKind: { type: 'string', enum: ['SCALAR', 'VECTOR'] },
    productId: {
      type: 'string',
      enum: [
        'GLOBAL_ANALYSISFORECAST_PHY_001_024',
        'GLOBAL_ANALYSISFORECAST_BGC_001_028',
        'GLOBAL_MULTIYEAR_PHY_001_030',
        'GLOBAL_MULTIYEAR_BGC_001_029',
      ],
    },
    datasetId: {
      type: 'string',
      pattern: SAFE_IDENTIFIER_PATTERN,
      maxLength: 255,
    },
    datasetVersionPart: {
      type: 'string',
      enum: ['202311', '202406'],
    },
    variables: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            pattern: SAFE_IDENTIFIER_PATTERN,
            maxLength: 255,
          },
          unit: { type: 'string', minLength: 1, maxLength: 64 },
        },
        required: ['id', 'unit'],
        additionalProperties: false,
      },
      minItems: 1,
      maxItems: MAX_VARIABLES,
      uniqueItems: true,
    },
    spatialResolution: {
      type: 'object',
      properties: {
        x: { type: 'number', enum: [0.083, 0.25] },
        y: { type: 'number', enum: [0.083, 0.25] },
        unit: { type: 'string', const: 'degree' },
      },
      required: ['x', 'y', 'unit'],
      additionalProperties: false,
    },
    depthSelection: {
      type: 'object',
      properties: {
        semantics: { type: 'string', const: 'DEPTH_BELOW_SEA_SURFACE' },
        method: { type: 'string', const: 'strict-inside' },
        verticalAxis: { type: 'string', const: 'depth' },
        positiveDirection: { type: 'string', const: 'DOWN' },
        unit: { type: 'string', const: 'm' },
        levelCount: { type: 'integer', enum: [50, 75] },
        coordinateValuesSource: {
          type: 'string',
          const: 'PROVIDER_DATASET_METADATA',
        },
        outOfBounds: { type: 'string', const: 'REJECT' },
        raiseIfUpdating: { type: 'boolean', const: true },
      },
      required: [
        'semantics',
        'method',
        'verticalAxis',
        'positiveDirection',
        'unit',
        'levelCount',
        'coordinateValuesSource',
        'outOfBounds',
        'raiseIfUpdating',
      ],
      additionalProperties: false,
    },
    selectionMethodId: {
      type: 'string',
      const: 'cmems.toolbox.strict-inside.depth.v1',
    },
    processing: {
      type: 'object',
      properties: {
        providerLevel: { type: 'string', const: 'L4' },
        toolboxVersion: { type: 'string', const: '2.4.1' },
        derivationId: {
          type: 'string',
          enum: ['marine.cmems.raw-scalar', 'marine.cmems.raw-uv-speed-bearing'],
        },
        derivationVersion: { type: 'integer', const: 1 },
        vectorDerivation: {
          anyOf: [
            {
              type: 'object',
              properties: {
                version: { type: 'integer', const: 1 },
                eastwardVariable: { type: 'string', const: 'uo' },
                northwardVariable: { type: 'string', const: 'vo' },
                speed: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', const: 'speed' },
                    formula: { type: 'string', const: 'sqrt(uo^2 + vo^2)' },
                    unit: { type: 'string', const: 'm s-1' },
                  },
                  required: ['id', 'formula', 'unit'],
                  additionalProperties: false,
                },
                bearing: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', const: 'bearing' },
                    formula: {
                      type: 'string',
                      const: '(atan2(uo, vo) * 180 / pi + 360) % 360',
                    },
                    unit: { type: 'string', const: 'degrees_true' },
                    convention: {
                      type: 'string',
                      const: 'clockwise_from_true_north_toward_flow',
                    },
                  },
                  required: ['id', 'formula', 'unit', 'convention'],
                  additionalProperties: false,
                },
              },
              required: ['version', 'eastwardVariable', 'northwardVariable', 'speed', 'bearing'],
              additionalProperties: false,
            },
            { type: 'null', nullable: true },
          ],
        },
      },
      required: [
        'providerLevel',
        'toolboxVersion',
        'derivationId',
        'derivationVersion',
        'vectorDerivation',
      ],
      additionalProperties: false,
    },
    noData: {
      type: 'object',
      properties: {
        rule: { type: 'string', const: 'EXCLUDE_METADATA_NODATA_AND_NON_FINITE' },
        valueSource: { type: 'string', const: 'PROVIDER_VARIABLE_METADATA' },
        metadataKeysInPriorityOrder: {
          type: 'array',
          items: [
            { type: 'string', const: '_FillValue' },
            { type: 'string', const: 'missing_value' },
          ],
          minItems: 2,
          maxItems: 2,
        },
        onMissingValue: { type: 'string', const: 'REJECT' },
      },
      required: ['rule', 'valueSource', 'metadataKeysInPriorityOrder', 'onMissingValue'],
      additionalProperties: false,
    },
    recipeSha256: {
      anyOf: [
        { type: 'string', pattern: SHA256_PATTERN },
        { type: 'null', nullable: true },
      ],
      not: { type: 'string' },
    },
    display: {
      type: 'object',
      properties: {
        wmtsCapabilitiesUrl: {
          type: 'string',
          minLength: 1,
          maxLength: 2_048,
          pattern:
            '^https://wmts\\.marine\\.copernicus\\.eu/[^\\s]+\\?SERVICE=WMTS&VERSION=1\\.0\\.0&REQUEST=GetCapabilities$',
        },
        variable: {
          type: 'string',
          pattern: SAFE_IDENTIFIER_PATTERN,
          maxLength: 255,
        },
        style: { type: 'string', minLength: 1, maxLength: 255 },
        legendId: {
          type: 'string',
          pattern: SAFE_IDENTIFIER_PATTERN,
          maxLength: 255,
        },
        legendPolicyId: {
          type: 'string',
          const: 'legend-policy.cmems.wmts-getlegend.v1',
        },
        artifact: {
          type: 'object',
          properties: {
            dataKind: { type: 'string', const: 'RASTER' },
            mediaType: { type: 'string', const: 'image/png' },
            authority: { type: 'string', const: 'DISPLAY_ONLY' },
          },
          required: ['dataKind', 'mediaType', 'authority'],
          additionalProperties: false,
        },
      },
      required: [
        'wmtsCapabilitiesUrl',
        'variable',
        'style',
        'legendId',
        'legendPolicyId',
        'artifact',
      ],
      additionalProperties: false,
    },
    attribution: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          enum: [
            'attribution.cmems.global-analysisforecast-phy-001-024.v1',
            'attribution.cmems.global-analysisforecast-bgc-001-028.v1',
            'attribution.cmems.global-multiyear-phy-001-030.v1',
            'attribution.cmems.global-multiyear-bgc-001-029.v1',
          ],
        },
        provider: { type: 'string', const: 'COPERNICUS_MARINE' },
        creditTemplate: { type: 'string', minLength: 1, maxLength: 2_048 },
        citationTemplate: { type: 'string', minLength: 1, maxLength: 4_096 },
        requiredTemplateVariables: {
          type: 'array',
          items: [{ type: 'string', const: 'ACCESSED_ON' }],
          minItems: 1,
          maxItems: 1,
        },
        doi: { type: 'string', pattern: '^10\\.48670/moi-[0-9]{5}$' },
        doiUrl: { type: 'string', pattern: '^https://doi\\.org/10\\.48670/moi-[0-9]{5}$' },
        sourceUrl: {
          type: 'string',
          pattern: '^https://data\\.marine\\.copernicus\\.eu/product/[^\\s]+/description$',
          maxLength: 2_048,
        },
        guidanceUrl: {
          type: 'string',
          pattern: '^https://help\\.marine\\.copernicus\\.eu/[^\\s]+$',
          maxLength: 2_048,
        },
      },
      required: [
        'id',
        'provider',
        'creditTemplate',
        'citationTemplate',
        'requiredTemplateVariables',
        'doi',
        'doiUrl',
        'sourceUrl',
        'guidanceUrl',
      ],
      additionalProperties: false,
    },
    toolbox: {
      type: 'object',
      properties: {
        schemaVersion: { type: 'integer', const: 1 },
        tool: { type: 'string', const: 'copernicusmarine' },
        version: { type: 'string', const: '2.4.1' },
        artifact: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              const: 'copernicusmarine_linux-glibc-2.35.cli',
            },
            sizeBytes: { type: 'integer', const: 154166192 },
            sha256: {
              type: 'string',
              const: 'e65f72db9fc7075f91fc9bd90368246248aa39a599a8a79eb4d06a5705b15864',
              pattern: SHA256_PATTERN,
            },
          },
          required: ['name', 'sizeBytes', 'sha256'],
          additionalProperties: false,
        },
      },
      required: ['schemaVersion', 'tool', 'version', 'artifact'],
      additionalProperties: false,
    },
  },
  required: [
    'catalogSchemaVersion',
    'catalogVersion',
    'catalogRevision',
    'catalogEntryId',
    'provider',
    'dataKind',
    'productId',
    'datasetId',
    'datasetVersionPart',
    'variables',
    'spatialResolution',
    'depthSelection',
    'selectionMethodId',
    'processing',
    'noData',
    'recipeSha256',
    'display',
    'attribution',
    'toolbox',
  ],
  additionalProperties: false,
};

const executionLeaseReplySchema: JSONSchemaType<MarineExecutionLeaseReplySchemaShape> = {
  type: 'object',
  properties: {
    leaseId: UUID_SCHEMA,
    leaseVersion: {
      type: 'integer',
      minimum: 1,
      maximum: MARINE_MAX_SAFE_INTEGER,
    },
    issuedAt: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
    expiresAt: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
    renewAfterSeconds: { type: 'integer', minimum: 1, maximum: 20 },
    tenantId: UUID_SCHEMA,
    jobId: UUID_SCHEMA,
    executionId: UUID_SCHEMA,
    requestFingerprint: { type: 'string', pattern: SHA256_PATTERN },
    requestedAt: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
    siteId: UUID_SCHEMA,
    marineAreaId: UUID_SCHEMA,
    marineAreaRevision: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_GENERATION,
    },
    marineAreaSha256: { type: 'string', pattern: SHA256_PATTERN },
    marineAreaGeoJson: {
      type: 'string',
      minLength: 2,
      maxLength: MAX_GEOJSON_BYTES,
    },
    provider: { type: 'string', const: 'CMEMS' },
    jobKind: { type: 'string', enum: [...MARINE_ANALYSIS_JOB_KINDS] },
    credentialGeneration: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_GENERATION,
    },
    selectionProvenance: selectionProvenanceSchema,
    dataRole: { type: 'string', enum: [...MARINE_DATA_ROLES] },
    temporalPartitionBoundaryAt: {
      anyOf: [UTC_MILLISECOND_TIMESTAMP_SCHEMA, { type: 'null', nullable: true }],
    },
    providerCoverageStart: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
    providerCoverageEnd: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
    timeStart: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
    timeEnd: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
    depthMinMeters: {
      anyOf: [
        { type: 'number', minimum: 0, maximum: 12_000 },
        { type: 'null', nullable: true },
      ],
    },
    depthMaxMeters: {
      anyOf: [
        { type: 'number', minimum: 0, maximum: 12_000 },
        { type: 'null', nullable: true },
      ],
    },
    sourceSnapshotJobId: {
      anyOf: [UUID_SCHEMA, { type: 'null', nullable: true }],
    },
    maxCells: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    maxTimeSteps: { type: 'integer', minimum: 1, maximum: 366 },
    maxOutputBytes: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_RESULT_BYTES,
    },
    maxScratchBytes: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_SCRATCH_BYTES,
    },
    deadlineAt: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
  },
  required: [
    'leaseId',
    'leaseVersion',
    'issuedAt',
    'expiresAt',
    'renewAfterSeconds',
    'tenantId',
    'jobId',
    'executionId',
    'requestFingerprint',
    'requestedAt',
    'siteId',
    'marineAreaId',
    'marineAreaRevision',
    'marineAreaSha256',
    'marineAreaGeoJson',
    'provider',
    'jobKind',
    'credentialGeneration',
    'selectionProvenance',
    'dataRole',
    'temporalPartitionBoundaryAt',
    'providerCoverageStart',
    'providerCoverageEnd',
    'timeStart',
    'timeEnd',
    'depthMinMeters',
    'depthMaxMeters',
    'sourceSnapshotJobId',
    'maxCells',
    'maxTimeSteps',
    'maxOutputBytes',
    'maxScratchBytes',
    'deadlineAt',
  ],
  additionalProperties: false,
};

const executionRenewRequestSchema: JSONSchemaType<MarineExecutionRenewRequest> = {
  type: 'object',
  properties: {
    tenantId: UUID_SCHEMA,
    jobId: UUID_SCHEMA,
    executionId: UUID_SCHEMA,
    executionLeaseId: UUID_SCHEMA,
    leaseVersion: {
      type: 'integer',
      minimum: 1,
      maximum: MARINE_MAX_SAFE_INTEGER,
    },
    nonce: { type: 'string', pattern: NONCE_PATTERN },
    stage: { type: 'string', enum: [...MARINE_EXECUTION_STAGES] },
  },
  required: [
    'tenantId',
    'jobId',
    'executionId',
    'executionLeaseId',
    'leaseVersion',
    'nonce',
    'stage',
  ],
  additionalProperties: false,
};

const executionRenewReplySchema: JSONSchemaType<MarineExecutionRenewReply> = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        decision: { type: 'string', const: 'CONTINUE' },
        executionLeaseId: UUID_SCHEMA,
        leaseVersion: {
          type: 'integer',
          minimum: 1,
          maximum: MARINE_MAX_SAFE_INTEGER,
        },
        issuedAt: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
        expiresAt: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
      },
      required: ['decision', 'executionLeaseId', 'leaseVersion', 'issuedAt', 'expiresAt'],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        decision: { type: 'string', const: 'STOP' },
        executionLeaseId: UUID_SCHEMA,
        leaseVersion: {
          type: 'integer',
          minimum: 1,
          maximum: MARINE_MAX_SAFE_INTEGER,
        },
        reason: {
          type: 'string',
          enum: [...MARINE_EXECUTION_STOP_REASONS],
        },
      },
      required: ['decision', 'executionLeaseId', 'leaseVersion', 'reason'],
      additionalProperties: false,
    },
  ],
};

const credentialLeaseRequestSchema: JSONSchemaType<MarineCredentialLeaseRequest> = {
  type: 'object',
  properties: {
    tenantId: UUID_SCHEMA,
    jobId: UUID_SCHEMA,
    executionId: UUID_SCHEMA,
    executionLeaseId: UUID_SCHEMA,
    leaseVersion: {
      type: 'integer',
      minimum: 1,
      maximum: MARINE_MAX_SAFE_INTEGER,
    },
    provider: { type: 'string', const: 'CMEMS' },
    credentialGeneration: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_GENERATION,
    },
    nonce: { type: 'string', pattern: NONCE_PATTERN },
  },
  required: [
    'tenantId',
    'jobId',
    'executionId',
    'executionLeaseId',
    'leaseVersion',
    'provider',
    'credentialGeneration',
    'nonce',
  ],
  additionalProperties: false,
};

const credentialLeaseReplySchema: JSONSchemaType<MarineCredentialLeaseReply> = {
  type: 'object',
  properties: {
    leaseId: UUID_SCHEMA,
    issuedAt: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
    expiresAt: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
    generation: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_GENERATION,
    },
    kind: {
      type: 'string',
      const: MARINE_CREDENTIAL_KINDS[0],
    },
    value: {
      type: 'object',
      properties: {
        username: { type: 'string', minLength: 1, maxLength: 512 },
        password: { type: 'string', minLength: 1, maxLength: 4_096 },
      },
      required: ['username', 'password'],
      additionalProperties: false,
    },
  },
  required: ['leaseId', 'issuedAt', 'expiresAt', 'generation', 'kind', 'value'],
  additionalProperties: false,
};

const usageReserveRequestSchema: JSONSchemaType<MarineUsageReserveRequest> = {
  type: 'object',
  properties: {
    tenantId: UUID_SCHEMA,
    jobId: UUID_SCHEMA,
    executionId: UUID_SCHEMA,
    executionLeaseId: UUID_SCHEMA,
    leaseVersion: {
      type: 'integer',
      minimum: 1,
      maximum: MARINE_MAX_SAFE_INTEGER,
    },
    operationId: UUID_SCHEMA,
    idempotencyKey: UUID_SCHEMA,
    provider: { type: 'string', const: 'CMEMS' },
    operationType: {
      type: 'string',
      enum: [...MARINE_USAGE_OPERATION_TYPES],
    },
    requestFingerprint: { type: 'string', pattern: SHA256_PATTERN },
  },
  required: [
    'tenantId',
    'jobId',
    'executionId',
    'executionLeaseId',
    'leaseVersion',
    'operationId',
    'idempotencyKey',
    'provider',
    'operationType',
    'requestFingerprint',
  ],
  additionalProperties: false,
};

const usageReserveReplySchema: JSONSchemaType<MarineUsageReserveReply> = {
  type: 'object',
  properties: {
    operationId: UUID_SCHEMA,
    state: { type: 'string', const: 'RESERVED' },
    attempt: { type: 'integer', minimum: 1, maximum: MAX_ATTEMPT },
    reservedAt: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
    replayed: { type: 'boolean' },
  },
  required: ['operationId', 'state', 'attempt', 'reservedAt', 'replayed'],
  additionalProperties: false,
};

const usageFinalizeRequestSchema: JSONSchemaType<MarineUsageFinalizeRequest> = {
  type: 'object',
  properties: {
    tenantId: UUID_SCHEMA,
    jobId: UUID_SCHEMA,
    executionId: UUID_SCHEMA,
    executionLeaseId: UUID_SCHEMA,
    leaseVersion: {
      type: 'integer',
      minimum: 1,
      maximum: MARINE_MAX_SAFE_INTEGER,
    },
    operationId: UUID_SCHEMA,
    idempotencyKey: UUID_SCHEMA,
    outcome: { type: 'string', enum: [...MARINE_USAGE_OUTCOMES] },
    providerStatusKind: {
      type: 'string',
      enum: [...MARINE_PROVIDER_STATUS_KINDS],
    },
    providerStatusCode: {
      anyOf: [
        { type: 'integer', minimum: 0, maximum: 65_535 },
        { type: 'null', nullable: true },
      ],
    },
    providerRequestId: {
      anyOf: [
        { type: 'string', minLength: 1, maxLength: 512 },
        { type: 'null', nullable: true },
      ],
    },
    processingUnits: {
      anyOf: [
        { type: 'number', minimum: 0, maximum: MARINE_MAX_SAFE_INTEGER },
        { type: 'null', nullable: true },
      ],
    },
    bytesIn: {
      type: 'integer',
      minimum: 0,
      maximum: MARINE_MAX_SAFE_INTEGER,
    },
    bytesOut: {
      type: 'integer',
      minimum: 0,
      maximum: MARINE_MAX_SAFE_INTEGER,
    },
    durationMs: {
      type: 'integer',
      minimum: 0,
      maximum: 86_400_000,
    },
    failureCode: {
      anyOf: [
        { type: 'string', pattern: FAILURE_CODE_PATTERN },
        { type: 'null', nullable: true },
      ],
    },
    finishedAt: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
  },
  required: [
    'tenantId',
    'jobId',
    'executionId',
    'executionLeaseId',
    'leaseVersion',
    'operationId',
    'idempotencyKey',
    'outcome',
    'providerStatusKind',
    'providerStatusCode',
    'providerRequestId',
    'processingUnits',
    'bytesIn',
    'bytesOut',
    'durationMs',
    'failureCode',
    'finishedAt',
  ],
  additionalProperties: false,
  allOf: [
    {
      if: {
        properties: { providerStatusKind: { const: 'HTTP' } },
        required: ['providerStatusKind'],
      },
      then: {
        properties: {
          providerStatusCode: {
            type: 'integer',
            minimum: 100,
            maximum: 599,
          },
        },
      },
    },
    {
      if: {
        properties: { providerStatusKind: { const: 'TOOL_EXIT' } },
        required: ['providerStatusKind'],
      },
      then: {
        properties: {
          providerStatusCode: {
            type: 'integer',
            minimum: 0,
            maximum: 255,
          },
        },
      },
    },
    {
      if: {
        properties: { providerStatusKind: { const: 'NOT_AVAILABLE' } },
        required: ['providerStatusKind'],
      },
      then: { properties: { providerStatusCode: { type: 'null' } } },
    },
    {
      if: {
        properties: { outcome: { const: 'SUCCEEDED' } },
        required: ['outcome'],
      },
      then: {
        properties: { failureCode: { type: 'null' } },
        anyOf: [
          {
            properties: {
              providerStatusKind: { const: 'TOOL_EXIT' },
              providerStatusCode: { const: 0 },
            },
            required: ['providerStatusKind', 'providerStatusCode'],
          },
          {
            properties: {
              providerStatusKind: { const: 'HTTP' },
              providerStatusCode: {
                type: 'integer',
                minimum: 200,
                maximum: 299,
              },
            },
            required: ['providerStatusKind', 'providerStatusCode'],
          },
        ],
      },
    },
    {
      if: {
        properties: { outcome: { enum: ['FAILED', 'CANCELLED'] } },
        required: ['outcome'],
      },
      then: {
        properties: {
          failureCode: {
            type: 'string',
            pattern: FAILURE_CODE_PATTERN,
          },
        },
      },
    },
  ],
};

const usageFinalizeReplySchema: JSONSchemaType<MarineUsageFinalizeReply> = {
  type: 'object',
  properties: {
    operationId: UUID_SCHEMA,
    state: { type: 'string', enum: [...MARINE_USAGE_OUTCOMES] },
    attempt: { type: 'integer', minimum: 1, maximum: MAX_ATTEMPT },
    finalizedAt: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
    replayed: { type: 'boolean' },
  },
  required: ['operationId', 'state', 'attempt', 'finalizedAt', 'replayed'],
  additionalProperties: false,
};

const artifactLeaseRequestSchema: JSONSchemaType<MarineArtifactLeaseRequest> = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        tenantId: UUID_SCHEMA,
        siteId: UUID_SCHEMA,
        jobId: UUID_SCHEMA,
        executionId: UUID_SCHEMA,
        executionLeaseId: UUID_SCHEMA,
        leaseVersion: {
          type: 'integer',
          minimum: 1,
          maximum: MARINE_MAX_SAFE_INTEGER,
        },
        nonce: { type: 'string', pattern: NONCE_PATTERN },
        artifactKind: { type: 'string', enum: [...MARINE_ARTIFACT_KINDS] },
        mode: { type: 'string', const: 'READ' },
        sourceSnapshotJobId: UUID_SCHEMA,
        artifactSha256: { type: 'string', pattern: SHA256_PATTERN },
      },
      required: [
        'tenantId',
        'siteId',
        'jobId',
        'executionId',
        'executionLeaseId',
        'leaseVersion',
        'nonce',
        'artifactKind',
        'mode',
        'sourceSnapshotJobId',
        'artifactSha256',
      ],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        tenantId: UUID_SCHEMA,
        siteId: UUID_SCHEMA,
        jobId: UUID_SCHEMA,
        executionId: UUID_SCHEMA,
        executionLeaseId: UUID_SCHEMA,
        leaseVersion: {
          type: 'integer',
          minimum: 1,
          maximum: MARINE_MAX_SAFE_INTEGER,
        },
        nonce: { type: 'string', pattern: NONCE_PATTERN },
        artifactKind: { type: 'string', enum: [...MARINE_ARTIFACT_KINDS] },
        mode: { type: 'string', const: 'WRITE' },
        mediaType: {
          type: 'string',
          pattern:
            '^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$',
          maxLength: MAX_MEDIA_TYPE_LENGTH,
        },
        byteLength: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_RESULT_BYTES,
        },
        contentSha256: { type: 'string', pattern: SHA256_PATTERN },
      },
      required: [
        'tenantId',
        'siteId',
        'jobId',
        'executionId',
        'executionLeaseId',
        'leaseVersion',
        'nonce',
        'artifactKind',
        'mode',
        'mediaType',
        'byteLength',
        'contentSha256',
      ],
      additionalProperties: false,
    },
  ],
};

const artifactReplyCommonProperties = {
  leaseId: UUID_SCHEMA,
  issuedAt: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
  url: {
    type: 'string',
    format: 'uri',
    pattern: '^https://',
    maxLength: MAX_ARTIFACT_URL_LENGTH,
  },
  objectKey: {
    type: 'string',
    pattern: ARTIFACT_OBJECT_KEY_PATTERN,
    maxLength: 1_024,
  },
  expiresAt: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
} as const;

const artifactLeaseReplySchema: JSONSchemaType<MarineArtifactLeaseReply> = {
  type: 'object',
  oneOf: [
    {
      type: 'object',
      properties: {
        ...artifactReplyCommonProperties,
        method: { type: 'string', const: 'GET' },
        requiredHeaders: {
          type: 'object',
          properties: {},
          required: [],
          maxProperties: 0,
          additionalProperties: false,
        },
      },
      required: [
        'leaseId',
        'method',
        'issuedAt',
        'url',
        'objectKey',
        'expiresAt',
        'requiredHeaders',
      ],
      additionalProperties: false,
    },
    {
      type: 'object',
      properties: {
        ...artifactReplyCommonProperties,
        method: { type: 'string', const: 'PUT' },
        requiredHeaders: {
          type: 'object',
          properties: {
            'content-type': {
              type: 'string',
              pattern:
                '^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$',
              maxLength: MAX_MEDIA_TYPE_LENGTH,
            },
            'content-length': {
              type: 'string',
              pattern: '^[1-9][0-9]{0,8}$',
            },
            'x-amz-checksum-sha256': {
              type: 'string',
              pattern: '^[A-Za-z0-9+/]{43}=$',
            },
            'if-none-match': { type: 'string', const: '*' },
          },
          required: ['content-type', 'content-length', 'x-amz-checksum-sha256', 'if-none-match'],
          minProperties: MAX_ARTIFACT_HEADERS,
          maxProperties: MAX_ARTIFACT_HEADERS,
          additionalProperties: false,
        },
      },
      required: [
        'leaseId',
        'method',
        'issuedAt',
        'url',
        'objectKey',
        'expiresAt',
        'requiredHeaders',
      ],
      additionalProperties: false,
    },
  ],
};

const executionFinalizeRequestSchema: JSONSchemaType<MarineExecutionFinalizeRequest> = {
  type: 'object',
  properties: {
    tenantId: UUID_SCHEMA,
    jobId: UUID_SCHEMA,
    executionId: UUID_SCHEMA,
    executionLeaseId: UUID_SCHEMA,
    leaseVersion: {
      type: 'integer',
      minimum: 1,
      maximum: MARINE_MAX_SAFE_INTEGER,
    },
    idempotencyKey: UUID_SCHEMA,
    requestFingerprint: { type: 'string', pattern: SHA256_PATTERN },
    terminalState: {
      type: 'string',
      enum: [...MARINE_EXECUTION_TERMINAL_STATES],
    },
    resultManifestKey: {
      anyOf: [
        { type: 'string', pattern: RESULT_MANIFEST_KEY_PATTERN },
        { type: 'null', nullable: true },
      ],
    },
    resultManifestSha256: {
      anyOf: [
        { type: 'string', pattern: SHA256_PATTERN },
        { type: 'null', nullable: true },
      ],
    },
    failureCode: {
      anyOf: [
        { type: 'string', pattern: FAILURE_CODE_PATTERN },
        { type: 'null', nullable: true },
      ],
    },
    retryable: { type: 'boolean' },
    finishedAt: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
  },
  required: [
    'tenantId',
    'jobId',
    'executionId',
    'executionLeaseId',
    'leaseVersion',
    'idempotencyKey',
    'requestFingerprint',
    'terminalState',
    'resultManifestKey',
    'resultManifestSha256',
    'failureCode',
    'retryable',
    'finishedAt',
  ],
  additionalProperties: false,
  oneOf: [
    {
      properties: {
        terminalState: { const: 'SUCCEEDED' },
        resultManifestKey: {
          type: 'string',
          pattern: RESULT_MANIFEST_KEY_PATTERN,
        },
        resultManifestSha256: {
          type: 'string',
          pattern: SHA256_PATTERN,
        },
        failureCode: { type: 'null' },
        retryable: { const: false },
      },
    },
    {
      properties: {
        terminalState: { const: 'FAILED' },
        resultManifestKey: { type: 'null' },
        resultManifestSha256: { type: 'null' },
        failureCode: {
          type: 'string',
          pattern: FAILURE_CODE_PATTERN,
        },
      },
    },
    {
      properties: {
        terminalState: { const: 'CANCELLED' },
        resultManifestKey: { type: 'null' },
        resultManifestSha256: { type: 'null' },
        failureCode: {
          type: 'string',
          pattern: FAILURE_CODE_PATTERN,
        },
        retryable: { const: false },
      },
    },
  ],
};

const executionFinalizeReplySchema: JSONSchemaType<MarineExecutionFinalizeReply> = {
  type: 'object',
  properties: {
    jobId: UUID_SCHEMA,
    executionId: UUID_SCHEMA,
    state: {
      type: 'string',
      enum: [...MARINE_EXECUTION_TERMINAL_STATES],
    },
    finalizedAt: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
    manifestVerified: { type: 'boolean' },
    replayed: { type: 'boolean' },
  },
  required: ['jobId', 'executionId', 'state', 'finalizedAt', 'manifestVerified', 'replayed'],
  additionalProperties: false,
  oneOf: [
    {
      properties: {
        state: { const: 'SUCCEEDED' },
        manifestVerified: { const: true },
      },
    },
    {
      properties: {
        state: { enum: ['FAILED', 'CANCELLED'] },
        manifestVerified: { const: false },
      },
    },
  ],
};

type MarineWorkerControlRequestSchemas = {
  readonly [Subject in MarineWorkerControlSubject]: JSONSchemaType<
    MarineWorkerControlContracts[Subject]['request']
  >;
};

type MarineWorkerControlReplySchemas = {
  readonly [Subject in MarineWorkerControlSubject]: Subject extends typeof MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE
    ? JSONSchemaType<MarineExecutionLeaseReplySchemaShape>
    : JSONSchemaType<MarineWorkerControlContracts[Subject]['reply']>;
};

export const MARINE_WORKER_CONTROL_REQUEST_SCHEMAS: MarineWorkerControlRequestSchemas = {
  [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE]: executionLeaseRequestSchema,
  [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_RENEW]: executionRenewRequestSchema,
  [MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE]: credentialLeaseRequestSchema,
  [MARINE_WORKER_CONTROL_SUBJECTS.USAGE_RESERVE]: usageReserveRequestSchema,
  [MARINE_WORKER_CONTROL_SUBJECTS.USAGE_FINALIZE]: usageFinalizeRequestSchema,
  [MARINE_WORKER_CONTROL_SUBJECTS.ARTIFACT_LEASE]: artifactLeaseRequestSchema,
  [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_FINALIZE]: executionFinalizeRequestSchema,
};

export const MARINE_WORKER_CONTROL_REPLY_SCHEMAS: MarineWorkerControlReplySchemas = {
  [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_LEASE]: executionLeaseReplySchema,
  [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_RENEW]: executionRenewReplySchema,
  [MARINE_WORKER_CONTROL_SUBJECTS.CREDENTIAL_LEASE]: credentialLeaseReplySchema,
  [MARINE_WORKER_CONTROL_SUBJECTS.USAGE_RESERVE]: usageReserveReplySchema,
  [MARINE_WORKER_CONTROL_SUBJECTS.USAGE_FINALIZE]: usageFinalizeReplySchema,
  [MARINE_WORKER_CONTROL_SUBJECTS.ARTIFACT_LEASE]: artifactLeaseReplySchema,
  [MARINE_WORKER_CONTROL_SUBJECTS.EXECUTION_FINALIZE]: executionFinalizeReplySchema,
};
