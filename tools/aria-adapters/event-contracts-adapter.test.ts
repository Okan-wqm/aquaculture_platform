import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { eventFacts } from '../gates/event-consumer-index';
import { indexFixtureTree, makeFixtureTree } from '../gates/fixture-tree';

import { analyzeEventContracts } from './event-contracts-adapter';

const workspace = makeFixtureTree('aria-event-contracts-adapter-');
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

// The adapter reads the workspace's tracked content (SE-3-R2 appellate RC): its files are indexed.
indexFixtureTree(workspace);
const output = analyzeEventContracts({ root: 'libs/event-contracts/src' }, workspace);

assert.equal(output.metadata.adapter, 'event-contracts-adapter');
assert.equal(output.findings.length, 0);
assert.equal(
  output.observations.some((item) => item.type === 'event_contract_base'),
  true,
);
assert.equal(
  output.observations.some(
    (item) => item.type === 'event_interface' && item.eventType === 'BatchCreated',
  ),
  true,
);
assert.equal(
  output.observations.some(
    (item) => item.type === 'event_interface' && item.eventType === 'AliasCreated',
  ),
  true,
);
assert.equal(
  output.observations.some(
    (item) =>
      item.type === 'event_schema_catalog' &&
      item.name === 'FARM_EVENT_SCHEMAS' &&
      item.eventCount === 1,
  ),
  true,
);
assert.equal(
  output.observations.some(
    (item) =>
      item.type === 'event_schema_catalog' &&
      item.name === 'SENSOR_EVENT_SCHEMAS' &&
      item.eventCount === 1,
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
assert.equal(
  output.observations.some((item) => item.type === 'event_validator_dispatch'),
  true,
);
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
indexFixtureTree(workspace);
const emptyCatalogOutput = analyzeEventContracts({ root: 'libs/event-contracts/src' }, workspace);
assert.equal(
  emptyCatalogOutput.findings.some(
    (finding) =>
      finding.rule === 'schema_catalog_empty' && finding.details?.catalog === 'EMPTY_EVENT_SCHEMAS',
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

// --- SE-3 review round 1, single-owner blocker 2 (build/SE-3/review-r1-blockers.md) -----------
//
// "Where is event T defined" had three readers with three rules: this adapter's event_interface
// observations (an interface extending BaseEvent, outside schemas/ and base-event.ts), the
// code-fact entry's event_definitions in tools/gates/event-consumer-index.ts (any `eventType`
// member with a literal type: 408 live sites for 288 types, schema catalogs, registries and
// erasure targets included) and the emit invariant's `export interface …Event` regex. One
// definition function, with one explicit rule, serves all of them: on the same tree the adapter's
// observations and the facts' definitions are the same set, and a schema catalog or a registry
// type that merely carries an `eventType` literal is not a definition.
const definitionsTree = makeFixtureTree('aria-event-definitions-');
const definitionFiles: Record<string, string> = {
  'libs/event-contracts/src/base-event.ts': [
    'export interface BaseEvent {',
    '  readonly eventId: string;',
    '  readonly eventType: string;',
    '  readonly tenantId: string;',
    '}',
    '',
  ].join('\n'),
  'libs/event-contracts/src/farm-events.ts': [
    "import type { BaseEvent } from './base-event';",
    'export interface BatchCreatedEvent extends BaseEvent {',
    "  readonly eventType: 'BatchCreated';",
    '  readonly batchId: string;',
    '}',
    '',
  ].join('\n'),
  // A validator catalog's shape, not a definition.
  'libs/event-contracts/src/schemas/farm-events.schema.ts': [
    'export interface BatchCreatedSchemaShape {',
    "  readonly eventType: 'BatchCreated';",
    '}',
    '',
  ].join('\n'),
  // A registry row type, not a definition: it does not extend BaseEvent.
  'libs/event-contracts/src/event-registry.ts': [
    'export interface RegistryRow {',
    "  readonly eventType: 'RegistryOnly';",
    '  readonly stream: string;',
    '}',
    '',
  ].join('\n'),
  'infrastructure/nats/services.yaml': [
    'version: 1',
    'services:',
    '  - name: farm_service',
    '    application: farm-service',
    '    description: fixture identity',
    '    publish:',
    '      - $JS.API.>',
    '      - $JS.ACK.>',
    '      - _INBOX.>',
    '    subscribe:',
    '      - $JS.API.>',
    '      - _INBOXFARM_SERVICE.>',
    '',
  ].join('\n'),
};
for (const [path, text] of Object.entries(definitionFiles)) {
  mkdirSync(join(definitionsTree, path, '..'), { recursive: true });
  writeFileSync(join(definitionsTree, path), text, 'utf8');
}
// The code-fact scans read the tree's tracked files (git ls-files).
indexFixtureTree(definitionsTree);
const adapterDefinitions = analyzeEventContracts(
  { root: 'libs/event-contracts/src', checks: ['event_interfaces'] },
  definitionsTree,
)
  .observations.filter(
    (observation) => observation.type === 'event_interface' && observation.eventType !== undefined,
  )
  .map((observation) => `${observation.eventType} @ ${observation.path}`)
  .sort();
const factDefinitions = eventFacts(definitionsTree)
  .event_definitions.map(
    (definition) => `${definition.event_type} @ ${definition.site.replace(/:\d+$/, '')}`,
  )
  .sort();
assert.deepEqual(
  factDefinitions,
  adapterDefinitions,
  'the code-fact definitions and the adapter observations disagree: two definition rules',
);
assert.deepEqual(factDefinitions, ['BatchCreated @ libs/event-contracts/src/farm-events.ts']);

// --- SE-3-R2 appellate RC: both readers of the one definition rule read one view of the tree ---
//
// The adapter built its program on the contained view (every file on disk) and walked its file
// set from disk, while the code-fact scan reads the tree's tracked content. On this tree a tracked
// contract takes its `eventType` from a gitignored module, and an untracked contract sits beside
// it: the adapter observed PlantedViaIgnoredType and PlantedUntracked, the facts named neither, and
// the pin above ("the same set") held only where nothing untracked is on disk. Both readers now
// read the tracked view, so their answers are one set on every tree.
const viewTree = makeFixtureTree('aria-event-definitions-view-');
const viewFiles: Record<string, string> = {
  '.gitignore': 'tmp\n',
  'libs/event-contracts/src/base-event.ts':
    definitionFiles['libs/event-contracts/src/base-event.ts'] ?? '',
  'libs/event-contracts/src/farm-events.ts': [
    "import type { BaseEvent } from './base-event';",
    "import type { PlantedType } from './tmp/planted-type';",
    'export interface BatchCreatedEvent extends BaseEvent {',
    "  readonly eventType: 'BatchCreated';",
    '}',
    'export interface PlantedEvent extends BaseEvent {',
    '  readonly eventType: PlantedType;',
    '}',
    '',
  ].join('\n'),
  'infrastructure/nats/services.yaml': definitionFiles['infrastructure/nats/services.yaml'] ?? '',
};
for (const [path, text] of Object.entries(viewFiles)) {
  mkdirSync(join(viewTree, path, '..'), { recursive: true });
  writeFileSync(join(viewTree, path), text, 'utf8');
}
indexFixtureTree(viewTree);
// Written after indexing: on disk inside the workspace, one ignored, one untracked.
mkdirSync(join(viewTree, 'libs/event-contracts/src/tmp'), { recursive: true });
writeFileSync(
  join(viewTree, 'libs/event-contracts/src/tmp/planted-type.ts'),
  "export type PlantedType = 'PlantedViaIgnoredType';\n",
  'utf8',
);
writeFileSync(
  join(viewTree, 'libs/event-contracts/src/untracked-events.ts'),
  [
    "import type { BaseEvent } from './base-event';",
    'export interface UntrackedEvent extends BaseEvent {',
    "  readonly eventType: 'PlantedUntracked';",
    '}',
    '',
  ].join('\n'),
  'utf8',
);
const viewAdapter = analyzeEventContracts(
  { root: 'libs/event-contracts/src', checks: ['event_interfaces'] },
  viewTree,
);
const viewFacts = eventFacts(viewTree);
const viewObserved = viewAdapter.observations
  .filter(
    (observation) => observation.type === 'event_interface' && observation.eventType !== undefined,
  )
  .map((observation) => `${observation.eventType} @ ${observation.path}`)
  .sort();
const viewDefined = viewFacts.event_definitions
  .map((definition) => `${definition.event_type} @ ${definition.site.replace(/:\d+$/, '')}`)
  .sort();
assert.deepEqual(
  viewObserved,
  viewDefined,
  'the adapter and the code-fact scan read different views of the same tree',
);
assert.deepEqual(viewDefined, ['BatchCreated @ libs/event-contracts/src/farm-events.ts']);
for (const planted of ['PlantedViaIgnoredType', 'PlantedUntracked']) {
  assert.ok(!JSON.stringify(viewAdapter).includes(planted), `the adapter reports ${planted}`);
  assert.ok(!JSON.stringify(viewFacts).includes(planted), `the facts report ${planted}`);
}

process.stdout.write('event-contracts-adapter tests passed\n');
