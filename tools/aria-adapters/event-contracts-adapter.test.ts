import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeEventContracts } from './event-contracts-adapter';

const workspace = mkdtempSync(join(tmpdir(), 'aria-event-contracts-adapter-'));
const root = join(workspace, 'libs/event-contracts/src');
mkdirSync(join(root, 'schemas'), { recursive: true });

writeFileSync(
  join(root, 'base-event.ts'),
  `
    export type EventId = string & { readonly __brand: unique symbol };
    export interface BaseEvent {
      eventId: EventId;
      eventType: string;
      timestamp: string;
      tenantId: string;
      version: number;
    }
    export function createBaseEvent(eventType: string, tenantId: string) {
      return { eventId: crypto.randomUUID() as EventId, eventType, tenantId, timestamp: new Date().toISOString(), version: 1 };
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'farm-events.ts'),
  `
    import { BaseEvent } from './base-event';
    export interface BatchCreatedEvent extends BaseEvent {
      eventType: 'BatchCreated';
      batchId: string;
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'alias-events.ts'),
  `
    import { BaseEvent as Base } from './base-event';
    export interface AliasCreatedEvent extends Base {
      eventType: 'AliasCreated';
      aliasId: string;
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'schemas/farm-events.schema.ts'),
  `
    export const FARM_EVENT_SCHEMAS = {
      BatchCreated: { type: 'object' },
    } as const;
  `,
  'utf8',
);
writeFileSync(
  join(root, 'schemas/sensor-events.schema.ts'),
  `
    const SENSOR_METRIC_INGESTED_SCHEMA = { type: 'object' };
    export const SENSOR_EVENT_SCHEMAS = {
      SensorMetricIngested: SENSOR_METRIC_INGESTED_SCHEMA,
    } as const;
  `,
  'utf8',
);
writeFileSync(
  join(root, 'schemas/ingest-backend-policy.schema.ts'),
  `
    const INGEST_BACKEND_POLICY_CHANGED_SCHEMA = { type: 'object' };
    export const INGEST_BACKEND_POLICY_EVENT_SCHEMAS = {
      IngestBackendPolicyChanged: INGEST_BACKEND_POLICY_CHANGED_SCHEMA,
    } as const;
  `,
  'utf8',
);
writeFileSync(
  join(root, 'schemas/validator.ts'),
  `
    import { FARM_EVENT_SCHEMAS } from './farm-events.schema';
    import { SENSOR_EVENT_SCHEMAS } from './sensor-events.schema';
    import { INGEST_BACKEND_POLICY_EVENT_SCHEMAS as INGEST_SCHEMAS } from './ingest-backend-policy.schema';
    const farmValidators = Object.entries(FARM_EVENT_SCHEMAS);
    const sensorSchema = SENSOR_EVENT_SCHEMAS.SensorMetricIngested;
    const ingestSchemas = Object.values(INGEST_SCHEMAS);
    export function validateFarmEvent(eventType: string, payload: unknown) {
      return Boolean(farmValidators.length && sensorSchema && ingestSchemas.length && FARM_EVENT_SCHEMAS[eventType as keyof typeof FARM_EVENT_SCHEMAS] && payload);
    }
  `,
  'utf8',
);

const output = analyzeEventContracts({ root: 'libs/event-contracts/src' }, workspace);

assert.equal(output.metadata.adapter, 'event-contracts-adapter');
assert.equal(output.findings.length, 0);
assert.equal(output.observations.some((item) => item.type === 'event_contract_base'), true);
assert.equal(output.observations.some((item) => item.type === 'event_interface' && item.eventType === 'BatchCreated'), true);
assert.equal(output.observations.some((item) => item.type === 'event_interface' && item.eventType === 'AliasCreated'), true);
assert.equal(
  output.observations.some(
    (item) => item.type === 'event_schema_catalog' && item.name === 'FARM_EVENT_SCHEMAS' && item.eventCount === 1,
  ),
  true,
);
assert.equal(
  output.observations.some(
    (item) => item.type === 'event_schema_catalog' && item.name === 'SENSOR_EVENT_SCHEMAS' && item.eventCount === 1,
  ),
  true,
);
assert.equal(
  output.observations.some(
    (item) =>
      item.type === 'event_schema_catalog' &&
      item.name === 'INGEST_BACKEND_POLICY_EVENT_SCHEMAS' &&
      item.eventCount === 1 &&
      item.details?.runtimeReferencedByValidator === true,
  ),
  true,
);
assert.equal(output.observations.some((item) => item.type === 'event_validator_dispatch'), true);
assert.ok(output.read_paths.includes('libs/event-contracts/src/base-event.ts'));
assert.equal(output.belief_candidates.length, 1);
assert.equal(
  output.belief_candidates[0]?.belief_id,
  'event-contracts:runtime-schema-validation-surface',
);

writeFileSync(
  join(root, 'schemas/validator.ts'),
  `
    import { FARM_EVENT_SCHEMAS } from './farm-events.schema';
    import { SENSOR_EVENT_SCHEMAS } from './sensor-events.schema';
    import { INGEST_BACKEND_POLICY_EVENT_SCHEMAS } from './ingest-backend-policy.schema';
    // SENSOR_EVENT_SCHEMAS and INGEST_BACKEND_POLICY_EVENT_SCHEMAS are mentioned here but not used at runtime.
    export function validateFarmEvent(eventType: string, payload: unknown) {
      return Boolean(Object.entries(FARM_EVENT_SCHEMAS).length && eventType && payload);
    }
  `,
  'utf8',
);
const unwiredOutput = analyzeEventContracts({ root: 'libs/event-contracts/src' }, workspace);
assert.equal(
  unwiredOutput.findings.some(
    (finding) =>
      finding.rule === 'schema_catalog_not_wired_to_validator' &&
      finding.details?.catalog === 'SENSOR_EVENT_SCHEMAS',
  ),
  true,
);

writeFileSync(
  join(root, 'schemas/empty-events.schema.ts'),
  `
    export const EMPTY_EVENT_SCHEMAS = {} as const;
  `,
  'utf8',
);
const emptyCatalogOutput = analyzeEventContracts({ root: 'libs/event-contracts/src' }, workspace);
assert.equal(
  emptyCatalogOutput.findings.some(
    (finding) => finding.rule === 'schema_catalog_empty' && finding.details?.catalog === 'EMPTY_EVENT_SCHEMAS',
  ),
  true,
);

writeFileSync(
  join(root, 'base-event.ts'),
  `
    export interface BaseEvent {
      eventId: string;
      eventType: string;
      timestamp: string;
      tenantId: string;
      version: number;
    }
  `,
  'utf8',
);

const badOutput = analyzeEventContracts({ root: 'libs/event-contracts/src' }, workspace);
assert.equal(
  badOutput.findings.some((finding) => finding.rule === 'event_id_brand_missing'),
  true,
);
assert.equal(
  badOutput.findings.some((finding) => finding.rule === 'create_base_event_missing'),
  true,
);

process.stdout.write('event-contracts-adapter tests passed\n');
