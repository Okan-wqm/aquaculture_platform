import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { indexFixtureTree } from '../gates/fixture-git-index';
import { makeFixtureTree } from '../gates/fixture-tree';

import { analyzeEventContracts } from './event-contracts-adapter';

// DET-contractsa (ledger Z27, Z-C2), package P-A: the typed path of the event-contracts adapter's
// `schema_contract_agreement` check.
//
// The defect (Z27): a runtime wire schema is tied by tsc only to a local, hand-copied `Wire*`
// interface (`JSONSchemaType<WireTankDeleted>`), never to the contract interface
// (`TankDeletedEvent`). Renaming `deletedAt` to `removedAt` in the Wire interface and its schema
// compiles, and no adapter rule relates the two. The check pairs each schema catalog entry that
// resolves to a `JSONSchemaType<W>` variable with the contract interface that defines the same
// event type (`eventDefinitionsIn`, never by name) and compares own member names and
// optionality, after dropping the BaseEvent members. It ships SHADOW with two rules:
// `event_schema_field_drift` and `event_schema_required_drift`.
//
// Every scenario runs the DEFAULT checks, so each is red at the branch base by an assertion (the
// check is absent from `metadata.checks`, the seeded drift is missing). The one scenario that
// names the check in the input (S8) builds that input as the JSON the manifest runner pipes in,
// because `CheckName` has no such member yet; the check name is the new API this package adds.
//
// The near-miss scenarios each carry a control event with a seeded drift, so a pass proves the
// extractor saw the catalog and the near-misses added nothing, instead of passing on an empty read.

type Output = ReturnType<typeof analyzeEventContracts>;
type Input = Parameters<typeof analyzeEventContracts>[0];

const ADAPTER_DIR = __dirname;
const REPO_ROOT = join(__dirname, '..', '..');
const ROOT = 'libs/event-contracts/src';
const CHECK = 'schema_contract_agreement';
const FIELD_DRIFT = 'event_schema_field_drift';
const REQUIRED_DRIFT = 'event_schema_required_drift';

const failures: string[] = [];
function scenario(name: string, body: () => void): void {
  try {
    body();
    process.stdout.write(`ok   ${name}\n`);
  } catch (error) {
    failures.push(name);
    const reason = error instanceof Error ? error.message.split('\n')[0] : String(error);
    process.stdout.write(`FAIL ${name}: ${reason}\n`);
  }
}

// ---------------------------------------------------------------- fixture builders

// The real BaseEvent member list (libs/event-contracts/src/base-event.ts).
const BASE_EVENT = `
export type EventId = string & { readonly __brand: unique symbol };
export interface BaseEvent {
  eventId: EventId;
  eventType: string;
  timestamp: string;
  tenantId: string;
  aggregateId?: string;
  aggregateType?: string;
  correlationId?: string;
  causationId?: string;
  userId?: string;
  version: number;
  retryCount?: number;
  cryptoShredKeyId?: string;
}
export function createBaseEvent(eventType: string, tenantId: string) {
  return { eventId: crypto.randomUUID() as EventId, eventType, tenantId, timestamp: '', version: 1 };
}
`;

// The wire bases of farm-events.schema.ts: the Wire base omits cryptoShredKeyId, and the setup
// base narrows two optional BaseEvent members to required.
const SCHEMA_HEADER = `import type { JSONSchemaType } from 'ajv';
interface WireBaseEvent {
  eventId: string;
  eventType: string;
  timestamp: string;
  tenantId: string;
  version: number;
  aggregateId?: string;
  aggregateType?: string;
  correlationId?: string;
  causationId?: string;
  userId?: string;
  retryCount?: number;
}
interface WireSetupBaseEvent extends WireBaseEvent {
  aggregateId: string;
  aggregateType: string;
}
declare const EXTRA_SCHEMAS: Record<string, object>;
declare function buildSchema(eventType: string): object;
`;

/** `name?: type` declares an optional member, as in the interfaces. */
const memberName = (field: string): string => field.slice(0, field.indexOf(':')).replace('?', '');
const isOptional = (field: string): boolean => field.slice(0, field.indexOf(':')).endsWith('?');
const schemaVariable = (eventType: string): string =>
  `${eventType.charAt(0).toLowerCase()}${eventType.slice(1)}Schema`;

function contract(declaration: string, eventType: string, fields: readonly string[]): string {
  return [
    `export interface ${declaration} extends BaseEvent {`,
    `  eventType: '${eventType}';`,
    ...fields.map((field) => `  ${field};`),
    '}',
    '',
  ].join('\n');
}

/** A Wire interface and its schema constant: `JSONSchemaType<W>` annotated, or `as`-cast. */
function wire(eventType: string, fields: readonly string[], form: 'annotated' | 'cast'): string {
  const properties = fields.map((field) => `${memberName(field)}: { type: 'string' }`);
  const required = fields.filter((field) => !isOptional(field)).map(memberName);
  const body = `{ type: 'object', properties: { eventType: { type: 'string', const: '${eventType}' }, ${properties.join(', ')} }, required: ['eventType', ${required.map((name) => `'${name}'`).join(', ')}], additionalProperties: false }`;
  const type = `Wire${eventType}`;
  return [
    `interface ${type} extends WireSetupBaseEvent {`,
    `  eventType: '${eventType}';`,
    ...fields.map((field) => `  ${field};`),
    '}',
    form === 'annotated'
      ? `export const ${schemaVariable(eventType)}: JSONSchemaType<${type}> = ${body};`
      : `export const ${schemaVariable(eventType)} = ${body} as JSONSchemaType<${type}>;`,
    '',
  ].join('\n');
}

interface Pair {
  readonly eventType: string;
  readonly declaration?: string;
  readonly contract: readonly string[];
  readonly wire: readonly string[];
}
interface Farm {
  readonly pairs: readonly Pair[];
  /** Catalog entries that are not a typed schema variable, written as they appear. */
  readonly otherEntries?: readonly string[];
  /** Events with a contract interface and no schema, or a schema and no contract. */
  readonly contractsOnly?: readonly Pair[];
  readonly wiresOnly?: readonly Pair[];
  readonly form?: 'annotated' | 'cast';
  readonly catalog?: 'record' | 'const';
  readonly contractFile?: string;
  /** A control event whose wire renames `seenAt` to `sawAt`: the one finding a near-miss tree has. */
  readonly control?: boolean;
}

const CONTROL: Pair = {
  eventType: 'Control',
  contract: ['controlId: string', 'seenAt: string'],
  wire: ['controlId: string', 'sawAt: string'],
};

function farmFiles(farm: Farm): Record<string, string> {
  const form = farm.form ?? 'annotated';
  const typed = [...farm.pairs, ...(farm.control === true ? [CONTROL] : [])];
  const contracts = [...typed, ...(farm.contractsOnly ?? [])].map((pair) =>
    contract(pair.declaration ?? `${pair.eventType}Event`, pair.eventType, pair.contract),
  );
  const wires = [...typed, ...(farm.wiresOnly ?? [])].map((pair) =>
    wire(pair.eventType, pair.wire, form),
  );
  const entries = [
    ...[...typed, ...(farm.wiresOnly ?? [])].map(
      (pair) => `${pair.eventType}: ${schemaVariable(pair.eventType)}`,
    ),
    ...(farm.otherEntries ?? []),
  ].map((entry) => `  ${entry},`);
  const catalog =
    farm.catalog === 'const'
      ? `export const FARM_EVENT_SCHEMAS = {\n${entries.join('\n')}\n} as const;`
      : `export const FARM_EVENT_SCHEMAS: Record<string, object> = {\n${entries.join('\n')}\n};`;
  return {
    [farm.contractFile ?? 'farm-events.ts']:
      `import type { BaseEvent } from './base-event';\n${contracts.join('\n')}`,
    'schemas/farm-events.schema.ts': [SCHEMA_HEADER, ...wires, catalog, ''].join('\n'),
  };
}

/** Plant a contracts tree and index it: the adapter reads the tracked view of the workspace. */
function plant(files: Readonly<Record<string, string>>): string {
  const workspace = makeFixtureTree('aria-event-schema-agreement-');
  for (const [path, text] of Object.entries({ 'base-event.ts': BASE_EVENT, ...files })) {
    mkdirSync(dirname(join(workspace, ROOT, path)), { recursive: true });
    writeFileSync(join(workspace, ROOT, path), text, 'utf8');
  }
  return indexFixtureTree(workspace);
}

const analyze = (workspace: string, input: Input = { root: ROOT }): Output =>
  analyzeEventContracts(input, workspace);
const run = (farm: Farm): Output => analyze(plant(farmFiles(farm)));

// ---------------------------------------------------------------- assertions

function assertCheckRan(output: Output): void {
  const checks = output.metadata.checks;
  assert.ok(
    Array.isArray(checks) && checks.includes(CHECK),
    `the default checks do not include ${CHECK}: ${JSON.stringify(checks)}`,
  );
}

/** The one finding of a seeded tree: its rule, and the names it must carry. */
function assertOnlyFinding(output: Output, rule: string, names: readonly string[]): void {
  assert.equal(
    output.findings.length,
    1,
    `expected exactly one ${rule} finding, got ${JSON.stringify(output.findings.map((f) => f.rule))}`,
  );
  const [finding] = output.findings;
  assert.equal(finding?.rule, rule);
  const text = JSON.stringify(finding);
  for (const name of names) {
    assert.ok(text.includes(name), `the ${rule} finding does not name ${name}: ${text}`);
  }
  assertCheckRan(output);
}

// ---------------------------------------------------------------- S1..S6: seeded drift

scenario('S1 Z27: a renamed Wire member is field drift naming both members', () => {
  const output = run({
    pairs: [
      {
        eventType: 'TankDeleted',
        contract: ['tankId: string', 'deletedAt: string'],
        wire: ['tankId: string', 'removedAt: string'],
      },
    ],
  });
  assertOnlyFinding(output, FIELD_DRIFT, ['TankDeleted', 'deletedAt', 'removedAt']);
  const [finding] = output.findings;
  const cited = [`${ROOT}/farm-events.ts`, `${ROOT}/schemas/farm-events.schema.ts`];
  assert.ok(finding !== undefined && cited.includes(finding.path), 'the finding cites no side');
  assert.ok(
    finding.evidence.length > 0 && finding.evidence.every((e) => cited.includes(e.path)),
    'the finding evidence is not read from the contract and schema files',
  );
});

scenario('S2 the `as JSONSchemaType<W>` form and an `as const` catalog are read too', () => {
  const output = run({
    form: 'cast',
    catalog: 'const',
    pairs: [
      {
        eventType: 'TankDeleted',
        contract: ['tankId: string', 'deletedAt: string'],
        wire: ['tankId: string', 'removedAt: string'],
      },
    ],
  });
  assertOnlyFinding(output, FIELD_DRIFT, ['TankDeleted', 'deletedAt', 'removedAt']);
});

scenario(
  'S3 a Wire-only member and a contract-only member each drift, one finding per event',
  () => {
    const output = run({
      pairs: [
        {
          eventType: 'TankArchived',
          contract: ['tankId: string'],
          wire: ['tankId: string', 'archivedBy: string'],
        },
        {
          eventType: 'TankRestored',
          contract: ['tankId: string', 'restoredBy: string'],
          wire: ['tankId: string'],
        },
      ],
    });
    assert.deepEqual(
      output.findings.map((finding) => finding.rule),
      [FIELD_DRIFT, FIELD_DRIFT],
    );
    const text = output.findings.map((finding) => JSON.stringify(finding));
    assert.ok(text.some((t) => t.includes('TankArchived') && t.includes('archivedBy')));
    assert.ok(text.some((t) => t.includes('TankRestored') && t.includes('restoredBy')));
    assertCheckRan(output);
  },
);

scenario('S4 required on the wire, optional in the contract, is required drift', () => {
  const output = run({
    pairs: [
      {
        eventType: 'TankNoted',
        contract: ['tankId: string', 'note?: string'],
        wire: ['tankId: string', 'note: string'],
      },
    ],
  });
  assertOnlyFinding(output, REQUIRED_DRIFT, ['TankNoted', 'note']);
});

scenario('S5 mandatory in the contract, optional on the wire, is required drift', () => {
  const output = run({
    pairs: [
      {
        eventType: 'TankNoted',
        contract: ['tankId: string', 'note: string'],
        wire: ['tankId: string', 'note?: string'],
      },
    ],
  });
  assertOnlyFinding(output, REQUIRED_DRIFT, ['TankNoted', 'note']);
});

scenario('S6 the pair is the event type literal, not the interface name or file', () => {
  const output = run({
    contractFile: 'tank-events.ts',
    pairs: [
      {
        eventType: 'TankDeleted',
        declaration: 'TankRemovalRecorded',
        contract: ['tankId: string', 'deletedAt: string'],
        wire: ['tankId: string', 'removedAt: string'],
      },
    ],
  });
  assertOnlyFinding(output, FIELD_DRIFT, ['TankDeleted', 'deletedAt', 'removedAt']);
});

// ---------------------------------------------------------------- S7: near misses

scenario('S7 near misses add no finding to the control tree', () => {
  const output = run({
    control: true,
    otherEntries: [
      "Plain: { type: 'object' }",
      '...EXTRA_SCHEMAS',
      "Called: buildSchema('Called')",
    ],
    pairs: [
      // identical Wire and contract: the Wire base omits cryptoShredKeyId and narrows aggregateId
      { eventType: 'Matched', contract: ['tankId: string'], wire: ['tankId: string'] },
      // Date in the contract, string on the wire: types are not compared
      { eventType: 'Dated', contract: ['happenedAt: Date'], wire: ['happenedAt: string'] },
      // optional on both sides
      { eventType: 'Optioned', contract: ['note?: string'], wire: ['note?: string'] },
      // the contract re-declares a BaseEvent member the Wire base omits: BaseEvent members are dropped
      {
        eventType: 'Shredded',
        contract: ['cryptoShredKeyId: string', 'tankId: string'],
        wire: ['tankId: string'],
      },
    ],
    // an interface with no schema is a coverage gap, not drift
    contractsOnly: [{ eventType: 'Unschemed', contract: ['tankId: string'], wire: [] }],
    // a catalog entry whose event type no interface defines
    wiresOnly: [{ eventType: 'Lookalike', contract: [], wire: ['otherField: string'] }],
  });
  assertOnlyFinding(output, FIELD_DRIFT, ['Control', 'seenAt', 'sawAt']);
});

scenario('S7b a lookalike interface name does not pair a schema with a foreign event type', () => {
  const files = farmFiles({
    control: true,
    pairs: [],
    wiresOnly: [{ eventType: 'Lookalike', contract: [], wire: ['otherField: string'] }],
  });
  const lookalike = contract('LookalikeEvent', 'LookalikeRenamed', ['oldField: string']);
  const output = analyze(
    plant({
      ...files,
      'farm-events.ts': `${files['farm-events.ts'] ?? ''}${lookalike}`,
    }),
  );
  assertOnlyFinding(output, FIELD_DRIFT, ['Control', 'seenAt', 'sawAt']);
});

// ---------------------------------------------------------------- S8: check selection

scenario('S8 the check is selectable by name and absent when other checks are chosen', () => {
  const workspace = plant(
    farmFiles({
      pairs: [
        {
          eventType: 'TankDeleted',
          contract: ['tankId: string', 'deletedAt: string'],
          wire: ['tankId: string', 'removedAt: string'],
        },
      ],
    }),
  );
  // The manifest runner pipes this JSON to the adapter; `checks` names the new check.
  const selected = JSON.parse(`{"root":"${ROOT}","checks":["${CHECK}"]}`) as Input;
  const only = analyze(workspace, selected);
  assert.deepEqual(only.metadata.checks, [CHECK]);
  assertOnlyFinding(only, FIELD_DRIFT, ['TankDeleted', 'deletedAt', 'removedAt']);
  const others = analyze(workspace, { root: ROOT, checks: ['event_interfaces'] });
  assert.deepEqual(others.findings, [], 'a run that does not select the check reports its rules');
});

// ---------------------------------------------------------------- S9: the real contracts tree

scenario('S9 on the real contracts tree: 0 findings clean, one when TankDeleted is renamed', () => {
  const real = plant({});
  cpSync(join(REPO_ROOT, ROOT), join(real, ROOT), {
    recursive: true,
    filter: (source) => !/(__tests__|\.spec\.ts$|\.test\.ts$)/.test(source),
  });
  indexFixtureTree(real);
  const clean = analyze(real);
  assert.deepEqual(
    clean.findings.map((finding) => finding.rule),
    [],
    'the unmodified contracts tree reports schema findings',
  );
  // The Z27 patch: the Wire interface and the schema of TankDeleted say `removedAt`.
  const schemaPath = join(real, ROOT, 'schemas/farm-events.schema.ts');
  const schema = readFileSync(schemaPath, 'utf8');
  const wireStart = schema.indexOf('interface WireTankDeleted');
  const schemaStart = schema.indexOf('export const tankDeletedSchema');
  assert.ok(wireStart > 0 && schemaStart > wireStart, 'the TankDeleted Wire and schema moved');
  const wireEnd = schema.indexOf('\n}\n', wireStart);
  const schemaEnd = schema.indexOf('\n};\n', schemaStart);
  const renamed = (text: string): string => text.replaceAll('deletedAt', 'removedAt');
  writeFileSync(
    schemaPath,
    schema.slice(0, wireStart) +
      renamed(schema.slice(wireStart, wireEnd)) +
      schema.slice(wireEnd, schemaStart) +
      renamed(schema.slice(schemaStart, schemaEnd)) +
      schema.slice(schemaEnd),
    'utf8',
  );
  indexFixtureTree(real);
  assertOnlyFinding(analyze(real), FIELD_DRIFT, ['TankDeleted', 'deletedAt', 'removedAt']);
});

// ---------------------------------------------------------------- S10: manifest

scenario('S10 the manifest contracts both rules, stays SHADOW and keeps its scope', () => {
  const manifest = JSON.parse(
    readFileSync(join(ADAPTER_DIR, 'event-contracts-adapter.tool.json'), 'utf8'),
  ) as {
    status: string;
    declared_scope: string[];
    allowed_read_globs: string[];
    health_thresholds: { max_cost_units: number };
    rules: Record<string, { claim_type: string; defect_claim: string; premises: string[] }>;
  };
  for (const rule of [FIELD_DRIFT, REQUIRED_DRIFT]) {
    const contractOfRule = manifest.rules[rule];
    assert.ok(contractOfRule !== undefined, `the manifest has no ${rule} contract`);
    assert.equal(contractOfRule.claim_type, 'wrong_code');
    assert.ok(contractOfRule.defect_claim.length > 0 && contractOfRule.premises.length > 0);
  }
  assert.notEqual(
    manifest.rules[FIELD_DRIFT]?.defect_claim,
    manifest.rules[REQUIRED_DRIFT]?.defect_claim,
    'the two rules state one claim',
  );
  // No scope change (the signature hashes the scope, so it is unchanged with it).
  assert.equal(manifest.status, 'SHADOW');
  assert.deepEqual(manifest.declared_scope, [`${ROOT}/**/*.ts`]);
  assert.deepEqual(manifest.allowed_read_globs, [`${ROOT}/**/*.ts`]);
  assert.equal(manifest.health_thresholds.max_cost_units, 150);
});

assert.deepEqual(failures, [], `scenarios failed: ${failures.join('; ')}`);
process.stdout.write('event-contracts schema agreement tests passed\n');
