import type { JSONSchemaType } from 'ajv';

import {
  BASE_EVENT_PROPERTIES,
  BASE_EVENT_REQUIRED,
  UTC_MILLISECOND_TIMESTAMP_SCHEMA,
  UUID_SCHEMA,
} from './common.schema';

const SHA256_PATTERN = '^[a-f0-9]{64}$';

interface WireMarineAnalysisRequested {
  eventId: string;
  eventType: 'MarineAnalysisRequested';
  timestamp: string;
  tenantId: string;
  version: 1;
  aggregateId: string;
  aggregateType: 'MarineAnalysisJob';
  correlationId?: string;
  causationId?: string;
  userId?: string;
  retryCount?: number;
  analysisJobId: string;
  executionId: string;
  siteId: string;
  marineAreaId: string;
  provider: 'CMEMS';
  jobKind: 'SNAPSHOT' | 'AOI_STATS' | 'TIME_SERIES';
  requestFingerprint: string;
  credentialGeneration: number;
  requestedAt: string;
}

const marineAnalysisRequestedSchema: JSONSchemaType<WireMarineAnalysisRequested> = {
  type: 'object',
  properties: {
    ...BASE_EVENT_PROPERTIES,
    eventType: { type: 'string', const: 'MarineAnalysisRequested' },
    timestamp: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
    version: { type: 'integer', const: 1 },
    aggregateId: UUID_SCHEMA,
    aggregateType: { type: 'string', const: 'MarineAnalysisJob' },
    analysisJobId: UUID_SCHEMA,
    executionId: UUID_SCHEMA,
    siteId: UUID_SCHEMA,
    marineAreaId: UUID_SCHEMA,
    provider: { type: 'string', const: 'CMEMS' },
    jobKind: {
      type: 'string',
      enum: ['SNAPSHOT', 'AOI_STATS', 'TIME_SERIES'],
    },
    requestFingerprint: { type: 'string', pattern: SHA256_PATTERN },
    credentialGeneration: {
      type: 'integer',
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    },
    requestedAt: UTC_MILLISECOND_TIMESTAMP_SCHEMA,
  },
  required: [
    ...BASE_EVENT_REQUIRED,
    'aggregateId',
    'aggregateType',
    'analysisJobId',
    'executionId',
    'siteId',
    'marineAreaId',
    'provider',
    'jobKind',
    'requestFingerprint',
    'credentialGeneration',
    'requestedAt',
  ],
  additionalProperties: false,
};

export type MarineEventType = 'MarineAnalysisRequested';

export const MARINE_EVENT_SCHEMAS: Record<MarineEventType, object> = {
  MarineAnalysisRequested: marineAnalysisRequestedSchema,
};
