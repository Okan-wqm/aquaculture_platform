import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
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
  join(root, 'schemas/farm-events.schema.ts'),
  `
    export const FARM_EVENT_SCHEMAS = {
      BatchCreated: { type: 'object' },
    } as const;
  `,
  'utf8',
);
writeFileSync(
  join(root, 'schemas/validator.ts'),
  `
    import { FARM_EVENT_SCHEMAS } from './farm-events.schema';
    export function validateFarmEvent(eventType: string, payload: unknown) {
      return Boolean(FARM_EVENT_SCHEMAS[eventType as keyof typeof FARM_EVENT_SCHEMAS] && payload);
    }
  `,
  'utf8',
);

const output = analyzeEventContracts({ root: 'libs/event-contracts/src' }, workspace);

assert.equal(output.metadata.adapter, 'event-contracts-adapter');
assert.equal(output.findings.length, 0);
assert.equal(output.observations.some((item) => item.type === 'event_contract_base'), true);
assert.equal(output.observations.some((item) => item.type === 'event_interface' && item.eventType === 'BatchCreated'), true);
assert.equal(output.observations.some((item) => item.type === 'event_schema_catalog' && item.name === 'FARM_EVENT_SCHEMAS'), true);
assert.equal(output.observations.some((item) => item.type === 'event_validator_dispatch'), true);
assert.ok(output.read_paths.includes('libs/event-contracts/src/base-event.ts'));
assert.equal(output.belief_candidates.length, 1);
assert.equal(
  output.belief_candidates[0]?.belief_id,
  'event-contracts:runtime-schema-validation-surface',
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

console.log('event-contracts-adapter tests passed');
