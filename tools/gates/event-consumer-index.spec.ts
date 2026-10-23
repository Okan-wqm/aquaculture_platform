#!/usr/bin/env ts-node
/**
 * tools/gates/event-consumer-index.ts — event consumers read from the code (ARIA-HIGH-313).
 *
 * The fixture cases build a throwaway repository with a minimal event bus, NATS client and
 * NestJS microservices declaration, one subscription per fold rule, and libraries wired in the
 * ways the scan attributes. The live cases run the scan on this checkout and compare it to
 * independent reads: a regex count of the subscription forms, the source of
 * TRIGGER_EVENT_MAP and the erasure-target registry, and the apps that wire library modules.
 * The `--facts` cases (SE-3, service-expertise PLAN §8) run the module's one JSON entry as the
 * kernel runs it, as a subprocess on a fixture tree, and read only its JSON.
 *
 * Invoke via:
 *   ts-node --project tools/gates/tsconfig.json tools/gates/event-consumer-index.spec.ts
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { after, test } from 'node:test';

import ts from 'typescript';

import { TENANT_ERASURE_OUTCOME_EVENT_TYPES_BY_TARGET } from '../../libs/event-contracts/src/tenant-erasure-targets';

import {
  type EventConsumerIndex,
  eventConsumersFor,
  FORWARDING_SITES,
  applicationNames,
  eventFacts,
  scanEventConsumers,
  scanEventProducers,
  trackedTree,
} from './event-consumer-index';
import { isUnresolvedFindingState } from './finding-registry-chain';
import { indexFixtureTree, removeFixtureTree } from './fixture-tree';
import { hermeticGitEnv } from './hermetic-git';
import { loadNatsServices } from './nats-services';

const REPO_ROOT = resolve(__dirname, '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'event-consumer-index-spec-'));
after(() => removeFixtureTree(scratch));

/** Writes `files` under `root` and indexes the tree: the scans read its tracked files (git ls-files). */
function writeTree(root: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, 'utf8');
  }
  return indexFixtureTree(root);
}

const BUS = [
  'export interface IEventBus {',
  '  subscribe(eventType: string, handler: object): Promise<void>;',
  '  subscribeWildcard(eventType: string, handler: object, options?: object): Promise<void>;',
  '  subscribeForTenant(eventType: string, tenantId: string, handler: object): Promise<void>;',
  '  subscribeTo(topic: string, handler: object): Promise<void>;',
  '}',
  'export function buildWildcardEventSubject(eventType: string): string {',
  '  return `events.*.${eventType}`;',
  '}',
  'export function SubscribeTo(topic: string | { topic: string }): MethodDecorator {',
  '  void topic;',
  '  return () => undefined;',
  '}',
  'export function EventHandler(eventName: string | { eventName: string }): ClassDecorator {',
  '  void eventName;',
  '  return () => undefined;',
  '}',
  '',
].join('\n');

const IMPORTS = [
  "import { buildWildcardEventSubject, EventHandler, type IEventBus, SubscribeTo } from '../../../platform/libs/event-bus/src/event-bus';",
  "import type { NatsConnection } from '@nats-io/nats-core';",
  "import { EventPattern } from '@nestjs/microservices';",
].join('\n');

const FOLDS = [
  IMPORTS,
  "const LIST = ['ListA', 'ListB'] as const;",
  "const MAP: Record<string, string> = { KeyA: 'x', 'Key.B': 'y' };",
  "const VALUES = { one: 'ValueA', two: 'ValueB' } as const;",
  "const PREFIX = 'events.*';",
  "enum Kind { E = 'EnumE' }",
  "const BUILT = (['BuiltA'] as const).map(buildWildcardEventSubject);",
  "const WRAPPED = (['WrappedA'] as const).map((type) => buildWildcardEventSubject(type));",
  'class Stream { subscribe(next: (value: unknown) => void): void { void next; } }',
  'export class Folds {',
  '  constructor(',
  '    private readonly bus: IEventBus,',
  '    private readonly nc: NatsConnection,',
  '    private readonly stream: Stream,',
  '  ) {}',
  '  async start(): Promise<void> {',
  "    await this.bus.subscribeWildcard('Literal', this);",
  '    await this.bus.subscribe(Kind.E, this);',
  '    await this.bus.subscribeWildcard(VALUES.one, this);',
  '    for (const type of LIST) await this.bus.subscribeWildcard(type, this);',
  "    for (const key of Object.keys(MAP)) await this.bus.subscribeForTenant(key, 't', this);",
  '    for (const value of Object.values(VALUES)) await this.bus.subscribeWildcard(value, this);',
  '    await this.bus.subscribeTo(`${PREFIX}.Templated`, this);',
  "    this.listen('ParamA');",
  "    this.listen('ParamB');",
  '    for (const subject of BUILT) this.nc.subscribe(subject);',
  '    for (const subject of WRAPPED) this.nc.subscribe(subject);',
  "    ['EachA', 'EachB'].forEach((type) => this.bus.subscribeWildcard(type, this));",
  "    this.nc.subscribe('events.*.CoreLiteral');",
  '    this.stream.subscribe(() => undefined);',
  '  }',
  '  private listen(type: string): void {',
  '    void this.bus.subscribeWildcard(type, this);',
  '  }',
  "  @SubscribeTo({ topic: 'events.*.Decorated' })",
  '  async onDecorated(): Promise<void> {}',
  "  @EventPattern('events.*.Patterned')",
  '  async onPattern(): Promise<void> {}',
  '}',
  "@EventHandler({ eventName: 'Handled' })",
  'export class Handled {}',
  '',
].join('\n');

const DYNAMIC = [
  IMPORTS,
  'declare function runtimeType(): string;',
  'export class Dynamic {',
  '  constructor(private readonly bus: IEventBus) {}',
  '  async start(): Promise<void> {',
  '    await this.bus.subscribeWildcard(runtimeType(), this);',
  "    this.listenPublic('Exported');",
  '  }',
  '  listenPublic(type: string): void {',
  '    void this.bus.subscribeWildcard(type, this);',
  '  }',
  '}',
  '',
].join('\n');

const LIB_SUBSCRIBER = (name: string, event: string): string =>
  [
    "import type { IEventBus } from '../../../platform/libs/event-bus/src/event-bus';",
    `export class ${name} {`,
    '  constructor(private readonly bus: IEventBus) {}',
    '  async start(): Promise<void> {',
    `    await this.bus.subscribeWildcard('${event}', this);`,
    '  }',
    '}',
    '',
  ].join('\n');

const MODULE_DECL = 'declare function Module(metadata: object): ClassDecorator;';

/** 1-based line of the first line of `text` containing `needle`. */
function lineOf(text: string, needle: string): number {
  const index = text.split('\n').findIndex((line) => line.includes(needle));
  assert.ok(index >= 0, needle);
  return index + 1;
}

function fixtureRepo(): string {
  return writeTree(mkdtempSync(join(scratch, 'repo-')), {
    'platform/libs/event-bus/src/event-bus.ts': BUS,
    'node_modules/@nats-io/nats-core/package.json':
      '{"name":"@nats-io/nats-core","types":"index.d.ts"}',
    'node_modules/@nats-io/nats-core/index.d.ts':
      'export interface NatsConnection { subscribe(subject: string, opts?: object): object; }\n',
    'node_modules/@nestjs/microservices/package.json':
      '{"name":"@nestjs/microservices","types":"index.d.ts"}',
    'node_modules/@nestjs/microservices/index.d.ts':
      'export declare const EventPattern: { (metadata?: string): MethodDecorator };\n',
    'apps/demo-service/project.json': '{"name":"demo-service"}',
    'apps/demo-service/src/folds.ts': FOLDS,
    'apps/demo-service/src/app.module.ts': [
      "import { OuterModule } from '../../../libs/shared/src/outer.module';",
      MODULE_DECL,
      '@Module({ imports: [OuterModule] })',
      'export class AppModule {}',
      '',
    ].join('\n'),
    'apps/dyn-service/src/dynamic.ts': DYNAMIC,
    'apps/dyn-service/src/app.module.ts': [
      "import { LibSubscriber } from '../../../libs/shared/src/lib-subscriber';",
      MODULE_DECL,
      '@Module({ providers: [LibSubscriber] })',
      'export class AppModule {}',
      '',
    ].join('\n'),
    'apps/barrel-service/src/index.ts': [
      "export { LibModule } from '../../../libs/shared/src/lib.module';",
      "import { LibModule } from '../../../libs/shared/src/lib.module';",
      '',
    ].join('\n'),
    'libs/shared/src/lib-subscriber.ts': LIB_SUBSCRIBER('LibSubscriber', 'LibEvent'),
    'libs/shared/src/orphan.ts': LIB_SUBSCRIBER('Orphan', 'OrphanEvent'),
    'libs/shared/src/lib.module.ts': [
      "import { LibSubscriber } from './lib-subscriber';",
      MODULE_DECL,
      '@Module({ providers: [LibSubscriber] })',
      'export class LibModule {}',
      '',
    ].join('\n'),
    'libs/shared/src/outer.module.ts': [
      "import { LibModule } from './lib.module';",
      MODULE_DECL,
      '@Module({ imports: [LibModule] })',
      'export class OuterModule {}',
      '',
    ].join('\n'),
  });
}

let fixtureIndex: EventConsumerIndex | null = null;
function fixture(): EventConsumerIndex {
  fixtureIndex ??= scanEventConsumers(fixtureRepo());
  return fixtureIndex;
}

function valuesOf(index: EventConsumerIndex, application: string): string[] {
  return index.entries
    .filter((entry) => entry.application === application)
    .map((entry) => `${entry.kind}:${entry.value}`)
    .sort();
}

void test('every fold rule resolves; an rxjs-style subscribe is not a consumer', () => {
  const demo = valuesOf(fixture(), 'demo-service').filter(
    (value) => value !== 'event_type:LibEvent',
  );
  assert.deepEqual(demo, [
    'event_type:BuiltA',
    'event_type:EachA',
    'event_type:EachB',
    'event_type:EnumE',
    'event_type:Handled',
    'event_type:Key.B',
    'event_type:KeyA',
    'event_type:ListA',
    'event_type:ListB',
    'event_type:Literal',
    'event_type:ParamA',
    'event_type:ParamB',
    'event_type:ValueA',
    'event_type:ValueA',
    'event_type:ValueB',
    'event_type:WrappedA',
    'subject:events.*.CoreLiteral',
    'subject:events.*.Decorated',
    'subject:events.*.Patterned',
    'subject:events.*.Templated',
  ]);
  // The Stream.subscribe call is declared in the app, not by the bus or the NATS client.
  const stream = `apps/demo-service/src/folds.ts:${lineOf(FOLDS, 'this.stream.subscribe(')}`;
  assert.ok(fixture().sites.every((site) => site.site !== stream));
});

void test('a value that does not fold is unresolved: a runtime value, a public method parameter', () => {
  assert.deepEqual(
    fixture().unresolved.map((site) => [site.application, site.site, site.form]),
    [
      [
        'dyn-service',
        `apps/dyn-service/src/dynamic.ts:${lineOf(DYNAMIC, 'subscribeWildcard(runtimeType()')}`,
        'runtimeType()',
      ],
      [
        'dyn-service',
        `apps/dyn-service/src/dynamic.ts:${lineOf(DYNAMIC, 'subscribeWildcard(type')}`,
        'type',
      ],
    ],
  );
});

void test('a library site belongs to the apps that wire its class, directly or through modules', () => {
  const wiring = fixture()
    .entries.filter((entry) => entry.value === 'LibEvent')
    .map((entry) => entry.application)
    .sort();
  // barrel-service only re-exports and imports LibModule: neither is a use.
  assert.deepEqual(wiring, ['demo-service', 'dyn-service']);
  const orphan = LIB_SUBSCRIBER('Orphan', 'OrphanEvent');
  assert.deepEqual(fixture().unattributed, [
    `libs/shared/src/orphan.ts:${lineOf(orphan, 'subscribeWildcard(')}`,
  ]);
});

void test('eventConsumersFor unites code sites and grants naming the event; catch-alls stay apart', () => {
  const services = loadNatsServices(
    join(REPO_ROOT, 'tools', 'gates', 'fixtures', 'plan-coverage', 'services.yaml'),
  );
  const literal = eventConsumersFor('Literal', fixture(), services);
  assert.deepEqual(
    literal.consumers.map((c) => [c.application, c.sources, c.codeSites, c.subject]),
    [
      [
        'demo-service',
        ['code_subscription'],
        [`apps/demo-service/src/folds.ts:${lineOf(FOLDS, "subscribeWildcard('Literal'")}`],
        'events.*.Literal',
      ],
    ],
  );
  const decorated = eventConsumersFor('Decorated', fixture(), services);
  assert.deepEqual(
    decorated.consumers.map((c) => [c.application, c.matchingPattern]),
    [['demo-service', 'events.*.Decorated']],
  );
  const harvested = eventConsumersFor('BatchHarvested', fixture(), services);
  assert.deepEqual(
    harvested.consumers.map((c) => [c.application, c.sources, c.matchingPattern]),
    [['notification-service', ['acl_grant'], 'events.*.BatchHarvested']],
  );
});

// --- live tree --------------------------------------------------------------------------------

let liveIndex: EventConsumerIndex | null = null;
function live(): EventConsumerIndex {
  liveIndex ??= scanEventConsumers(REPO_ROOT);
  return liveIndex;
}

/** Non-test .ts files under the scan roots, read independently of the module. */
function liveSources(): { path: string; text: string }[] {
  const files: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '__tests__') walk(path);
      } else if (entry.name.endsWith('.ts') && !/\.(spec|test|d)\.ts$/.test(entry.name)) {
        files.push({ path: relative(REPO_ROOT, path), text: readFileSync(path, 'utf8') });
      }
    }
  };
  for (const base of ['apps', 'libs', join('platform', 'libs')]) {
    for (const pkg of readdirSync(join(REPO_ROOT, base))) {
      const src = join(REPO_ROOT, base, pkg, 'src');
      if (existsSync(src)) walk(src);
    }
  }
  return files;
}

void test('live: every subscription site resolves', () => {
  assert.deepEqual(live().unresolved, []);
  assert.ok(live().entries.length > 50, `${live().entries.length} entries`);
});

void test('live: the scan finds every bus-method and decorator site a regex count finds', () => {
  // Code only: comments mention the API by name.
  const stripComments = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const count = (pattern: RegExp): Map<string, number> => {
    const counts = new Map<string, number>();
    for (const file of liveSources()) {
      for (const match of stripComments(file.text).matchAll(pattern)) {
        const key = match[1] ?? '';
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
    return counts;
  };
  const scanned = new Map<string, number>();
  for (const site of live().sites) {
    const key = site.api.replace(/^event-bus:|^@/, '');
    scanned.set(key, (scanned.get(key) ?? 0) + 1);
  }
  const methods = count(/\.(subscribeWildcard|subscribeForTenant|subscribeTo)\s*\(/g);
  // A decorator opens its line; the same text inside a log message is not one.
  const decorators = count(/^\s*@(SubscribeTo|EventPattern|EventHandler)\s*\(/gm);
  for (const [key, expected] of [...methods, ...decorators]) {
    assert.equal(scanned.get(key) ?? 0, expected, key);
  }
});

void test('live: every forwarding entry still holds a site', () => {
  for (const entry of FORWARDING_SITES) {
    assert.ok(
      live().sites.some(
        (site) => site.forwarding && site.file === entry.file && site.function === entry.function,
      ),
      `${entry.file} ${entry.function}`,
    );
  }
});

void test('live: dynamic sites fold to the values their sources declare', () => {
  const at = (application: string, file: string): string[] =>
    live()
      .entries.filter(
        (entry) => entry.application === application && entry.site.startsWith(`${file}:`),
      )
      .map((entry) => entry.value)
      .sort();

  const triggerSource = readFileSync(
    join(REPO_ROOT, 'apps/farm-service/src/task/services/auto-rule-trigger.service.ts'),
    'utf8',
  );
  const mapBody = /const TRIGGER_EVENT_MAP[^{]*\{([^}]*)\}/.exec(triggerSource)?.[1] ?? '';
  const triggerKeys = [...mapBody.matchAll(/'([^']+)'\s*:/g)].map((m) => m[1] ?? '').sort();
  assert.ok(triggerKeys.length > 0);
  assert.deepEqual(
    at('farm-service', 'apps/farm-service/src/task/services/auto-rule-trigger.service.ts'),
    triggerKeys,
  );

  const outcomes = Object.values(TENANT_ERASURE_OUTCOME_EVENT_TYPES_BY_TARGET)
    .flatMap((byOutcome) => Object.values(byOutcome))
    .sort();
  assert.deepEqual(
    at('admin-api-service', 'apps/admin-api-service/src/tenant/handlers/tenant-erasure.handler.ts'),
    outcomes,
  );

  assert.ok(
    live().entries.some(
      (entry) =>
        entry.application === 'observability-service' &&
        entry.value === 'events.platform.schema-migration.>',
    ),
  );
});

void test('live: TenantProvisioned reaches exactly the apps that import TenantSchemaCacheModule', () => {
  const importers = new Set<string>();
  for (const file of liveSources()) {
    const app = /^apps\/([^/]+)\/src\//.exec(file.path)?.[1];
    const used = file.text
      .split('\n')
      .some((line) => line.includes('TenantSchemaCacheModule') && !/^\s*import\b/.test(line));
    if (app !== undefined && used) importers.add(app);
  }
  const reached = new Set(
    live()
      .entries.filter(
        (entry) =>
          entry.value === 'TenantProvisioned' &&
          entry.site.startsWith('libs/backend-common/src/database/tenant-schema-cache/'),
      )
      .map((entry) => entry.application),
  );
  assert.ok(importers.size > 0);
  assert.deepEqual([...reached].sort(), [...importers].sort());
});

void test('live: every catch-all grant belongs to an app the scan reads', () => {
  for (const service of loadNatsServices()) {
    const catchAll = service.subscribe.some((grant) => /^(events|telemetry)\.>$/.test(grant));
    if (!catchAll) continue;
    assert.ok(
      existsSync(join(REPO_ROOT, 'apps', service.application, 'src', 'main.ts')),
      `${service.name} holds a catch-all grant, but apps/${service.application}/src is not scanned`,
    );
  }
});

// --- SE-3: the code-fact bridge (`--facts`) -----------------------------------------------------
//
// service-expertise PLAN §8 SE-3: `scanEventProducers` and one JSON entry (`--facts`) in this
// module give, per application, the produced and consumed event sites, code producer x code
// subscription edges, ACL grants as permission facts (never edges), the NATS identity, and the
// event definition sites. The kernel runs the entry as a subprocess on the diff's base tree
// (plan_coverage's runner), so these cases run it the same way and read only its JSON. The
// entry reads the tree under --repo-root, its services.yaml included: facts are computed at base.

const FACTS_BUS = [
  'export interface IEventBus {',
  '  publish<TEvent extends { readonly eventType: string }>(event: TEvent): Promise<void>;',
  '  subscribeWildcard(eventType: string, handler: object): Promise<void>;',
  '}',
  '',
].join('\n');

const BASE_EVENT = [
  'export interface BaseEvent {',
  '  readonly eventId: string;',
  '  readonly eventType: string;',
  '  readonly tenantId: string;',
  '}',
  'export function createBaseEvent<T extends BaseEvent>(',
  "  eventType: T['eventType'],",
  '  tenantId: string,',
  "): BaseEvent & { readonly eventType: T['eventType'] } {",
  "  return { eventId: 'fixture-id', eventType, tenantId };",
  '}',
  '',
].join('\n');

const FIXTURE_EVENTS = [
  "import type { BaseEvent } from './base-event';",
  "export interface FixtureShippedEvent extends BaseEvent { readonly eventType: 'FixtureShipped'; readonly lot: string }",
  "export interface FixtureLibEventEvent extends BaseEvent { readonly eventType: 'FixtureLibEvent' }",
  "export interface FixtureLibProducedEvent extends BaseEvent { readonly eventType: 'FixtureLibProduced' }",
  '',
].join('\n');

// Producer and its event construction share one line, so the site is the same whichever of the
// two the scan reads.
const SHIPPER = [
  "import type { IEventBus } from '../../../platform/libs/event-bus/src/event-bus';",
  "import { createBaseEvent } from '../../../libs/event-contracts/src/base-event';",
  "import type { FixtureShippedEvent } from '../../../libs/event-contracts/src/fixture-events';",
  'export class Shipper {',
  '  constructor(private readonly bus: IEventBus) {}',
  '  async ship(tenantId: string): Promise<void> {',
  "    await this.bus.publish<FixtureShippedEvent>({ ...createBaseEvent<FixtureShippedEvent>('FixtureShipped', tenantId), lot: 'L1' });",
  '  }',
  '}',
  '',
].join('\n');

const LISTENER = [
  "import type { IEventBus } from '../../../platform/libs/event-bus/src/event-bus';",
  'export class Listener {',
  '  constructor(private readonly bus: IEventBus) {}',
  '  async start(): Promise<void> {',
  "    await this.bus.subscribeWildcard('FixtureShipped', this);",
  "    await this.bus.subscribeWildcard('FixtureLibProduced', this);",
  '  }',
  '}',
  '',
].join('\n');

// A library class that both consumes and produces; d-service and e-service wire it.
const LIB_RELAY = [
  "import type { IEventBus } from '../../../platform/libs/event-bus/src/event-bus';",
  "import { createBaseEvent } from '../../event-contracts/src/base-event';",
  "import type { FixtureLibProducedEvent } from '../../event-contracts/src/fixture-events';",
  'export class LibRelay {',
  '  constructor(private readonly bus: IEventBus) {}',
  '  async start(): Promise<void> {',
  "    await this.bus.subscribeWildcard('FixtureLibEvent', this);",
  '  }',
  '  async relay(tenantId: string): Promise<void> {',
  "    await this.bus.publish<FixtureLibProducedEvent>({ ...createBaseEvent<FixtureLibProducedEvent>('FixtureLibProduced', tenantId) });",
  '  }',
  '}',
  '',
].join('\n');

const RELAY_MODULE = [
  "import { LibRelay } from '../../../libs/shared/src/lib-relay';",
  MODULE_DECL,
  '@Module({ providers: [LibRelay] })',
  'export class AppModule {}',
  '',
].join('\n');

/** One services.yaml entry: the schema's grant minimums plus the given event grants. */
function natsEntry(
  name: string,
  description: string,
  publish: readonly string[],
  subscribe: readonly string[],
): string {
  const inbox = `_INBOX${name.toUpperCase()}.>`;
  return [
    `  - name: ${name}`,
    `    application: ${name.replace(/_/g, '-')}`,
    `    description: ${description}`,
    '    publish:',
    ...[...publish, '$JS.API.>', '$JS.ACK.>', '_INBOX.>'].map((grant) => `      - ${grant}`),
    '    subscribe:',
    ...[...subscribe, '$JS.API.>', inbox].map((grant) => `      - ${grant}`),
  ].join('\n');
}

const FACTS_SERVICES_YAML = [
  'version: 1',
  'services:',
  natsEntry('a_service', 'fixture shipper of FixtureShipped', ['events.*.FixtureShipped'], []),
  natsEntry('b_service', 'fixture code subscriber', [], []),
  // c_service may receive FixtureShipped but no code of c-service subscribes to it.
  natsEntry('c_service', 'fixture grant-only holder', [], ['events.*.FixtureShipped']),
  natsEntry('d_service', 'fixture wiring of LibRelay', ['events.*.FixtureLibProduced'], []),
  natsEntry('e_service', 'fixture wiring of LibRelay', ['events.*.FixtureLibProduced'], []),
  '',
].join('\n');

const FACTS_APPS = ['a-service', 'b-service', 'c-service', 'd-service', 'e-service'] as const;

function factsRepo(servicesYaml: string): string {
  const files: Record<string, string> = {
    'platform/libs/event-bus/src/event-bus.ts': FACTS_BUS,
    'libs/event-contracts/src/base-event.ts': BASE_EVENT,
    'libs/event-contracts/src/fixture-events.ts': FIXTURE_EVENTS,
    'libs/shared/src/lib-relay.ts': LIB_RELAY,
    'apps/a-service/src/shipper.ts': SHIPPER,
    'apps/b-service/src/listener.ts': LISTENER,
    'apps/c-service/src/main.ts': 'export const started = true;\n',
    'apps/d-service/src/app.module.ts': RELAY_MODULE,
    'apps/e-service/src/app.module.ts': RELAY_MODULE,
    'infrastructure/nats/services.yaml': servicesYaml,
  };
  for (const app of FACTS_APPS) files[`apps/${app}/project.json`] = JSON.stringify({ name: app });
  return writeTree(mkdtempSync(join(scratch, 'facts-')), files);
}

/** 1-based line of the first line containing `needle` at or after the first containing `anchor`. */
function lineAfter(text: string, anchor: string, needle: string): number {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.includes(anchor));
  assert.ok(start >= 0, anchor);
  const offset = lines.slice(start).findIndex((line) => line.includes(needle));
  assert.ok(offset >= 0, `${needle} after ${anchor}`);
  return start + offset + 1;
}

interface FactsRun {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** The `--facts` entry as the kernel runs it: a subprocess, its JSON on stdout. */
function runFactsEntry(repoRoot: string): FactsRun {
  const args = [
    '--project',
    join(REPO_ROOT, 'tools', 'gates', 'tsconfig.json'),
    join(REPO_ROOT, 'tools', 'gates', 'event-consumer-index.ts'),
    '--facts',
    '--repo-root',
    repoRoot,
  ];
  try {
    const stdout = execFileSync(join(REPO_ROOT, 'node_modules', '.bin', 'ts-node'), args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (error) {
    const failed = error as { status?: number | null; stdout?: string; stderr?: string };
    return {
      exitCode: failed.status ?? -1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    };
  }
}

interface EventFact {
  readonly event_type: string;
  readonly site: string;
}
interface EdgeFact {
  readonly kind: string;
  readonly to: string;
  readonly subject: string;
  readonly ref: string;
}
interface GrantFact {
  readonly subject: string;
  readonly direction: string;
  readonly ref: string;
}
interface ServiceFacts {
  readonly service: string;
  readonly events_produced: readonly EventFact[];
  readonly events_consumed: readonly EventFact[];
  readonly edges: readonly EdgeFact[];
  readonly acl_grants: readonly GrantFact[];
  readonly nats_identity: { readonly name: string; readonly ref: string } | null;
}
interface EventFacts {
  readonly services: readonly ServiceFacts[];
  readonly event_definitions: readonly EventFact[];
}

// One subprocess for every case that reads the fixture's facts.
let factsRun: FactsRun | null = null;
function facts(): EventFacts {
  factsRun ??= runFactsEntry(factsRepo(FACTS_SERVICES_YAML));
  const run = factsRun;
  assert.equal(run.exitCode, 0, `--facts exited ${run.exitCode}: ${run.stderr}`);
  assert.ok(run.stdout.trim().startsWith('{'), `--facts printed no JSON object: ${run.stdout}`);
  return JSON.parse(run.stdout) as EventFacts;
}

function serviceFacts(name: string): ServiceFacts {
  const found = facts().services.filter((entry) => entry.service === name);
  assert.equal(found.length, 1, `exactly one facts entry for ${name}`);
  const [only] = found;
  assert.ok(only !== undefined);
  return only;
}

const eventSites = (list: readonly EventFact[], eventType: string): EventFact[] =>
  list
    .filter((fact) => fact.event_type === eventType)
    .map((fact) => ({ event_type: fact.event_type, site: fact.site }));

const eventEdges = (list: readonly EdgeFact[], subject: string): Omit<EdgeFact, 'ref'>[] =>
  list
    .filter((edge) => edge.kind === 'event' && edge.subject === subject)
    .map((edge) => ({ kind: edge.kind, to: edge.to, subject: edge.subject }));

const SHIPPED_PRODUCER = `apps/a-service/src/shipper.ts:${lineOf(SHIPPER, "('FixtureShipped', tenantId)")}`;
const SHIPPED_CONSUMER = `apps/b-service/src/listener.ts:${lineOf(LISTENER, "('FixtureShipped'")}`;
const LIB_CONSUMER = `libs/shared/src/lib-relay.ts:${lineOf(LIB_RELAY, "('FixtureLibEvent'")}`;
const LIB_PRODUCER = `libs/shared/src/lib-relay.ts:${lineOf(LIB_RELAY, "('FixtureLibProduced'")}`;
const NATS_REF = 'infrastructure/nats/services.yaml';

// The fixture is valid today, so the cases below are red for the missing entry, not the fixture.
void test('facts fixture: its services.yaml passes the SSoT schema; the consumer scan reads it', () => {
  const repo = factsRepo(FACTS_SERVICES_YAML);
  const services = loadNatsServices(join(repo, NATS_REF));
  assert.deepEqual(services.map((service) => service.application).sort(), [...FACTS_APPS]);
  const index = scanEventConsumers(repo);
  assert.deepEqual(index.unresolved, []);
  const consumers = (value: string): string[][] =>
    index.entries
      .filter((entry) => entry.value === value)
      .map((entry) => [entry.application, entry.site]);
  assert.deepEqual(consumers('FixtureShipped'), [['b-service', SHIPPED_CONSUMER]]);
  assert.deepEqual(consumers('FixtureLibEvent'), [
    ['d-service', LIB_CONSUMER],
    ['e-service', LIB_CONSUMER],
  ]);
});

void test('facts (i): A emits T and B subscribes -> A produces T@site, B consumes T@site, edge A->B (event, T)', () => {
  assert.deepEqual(serviceFacts('a-service').events_produced, [
    { event_type: 'FixtureShipped', site: SHIPPED_PRODUCER },
  ]);
  assert.deepEqual(eventSites(serviceFacts('b-service').events_consumed, 'FixtureShipped'), [
    { event_type: 'FixtureShipped', site: SHIPPED_CONSUMER },
  ]);
  assert.deepEqual(eventEdges(serviceFacts('a-service').edges, 'FixtureShipped'), [
    { kind: 'event', to: 'b-service', subject: 'FixtureShipped' },
  ]);
  // The edge's evidence is one of its two code sites, never a grant.
  for (const edge of serviceFacts('a-service').edges) {
    assert.ok([SHIPPED_PRODUCER, SHIPPED_CONSUMER].includes(edge.ref), edge.ref);
  }
});

void test('facts (ii): a grant-only consumer is a permission fact and no edge', () => {
  const holder = serviceFacts('c-service');
  assert.deepEqual(eventSites(holder.events_consumed, 'FixtureShipped'), []);
  assert.ok(
    holder.acl_grants.some(
      (grant) =>
        grant.subject === 'events.*.FixtureShipped' &&
        grant.direction === 'subscribe' &&
        grant.ref ===
          `${NATS_REF}:${lineAfter(FACTS_SERVICES_YAML, 'name: c_service', 'events.*.FixtureShipped')}`,
    ),
    JSON.stringify(holder.acl_grants),
  );
  assert.ok(
    serviceFacts('a-service').acl_grants.some(
      (grant) =>
        grant.subject === 'events.*.FixtureShipped' &&
        grant.direction === 'publish' &&
        grant.ref ===
          `${NATS_REF}:${lineAfter(FACTS_SERVICES_YAML, 'name: a_service', 'events.*.FixtureShipped')}`,
    ),
    JSON.stringify(serviceFacts('a-service').acl_grants),
  );
  for (const entry of facts().services) {
    assert.deepEqual(
      entry.edges.filter((edge) => edge.to === 'c-service'),
      [],
      `${entry.service} has an edge to the grant-only holder`,
    );
  }
});

void test('facts (iii): a tree the entry cannot read is an environment failure (exit 2), never empty facts', () => {
  // services.yaml without `application:` is refused by its schema (nats-services.ts).
  const refused = FACTS_SERVICES_YAML.replace('    application: c-service\n', '');
  assert.notEqual(refused, FACTS_SERVICES_YAML);
  const run = runFactsEntry(factsRepo(refused));
  assert.equal(run.exitCode, 2, `exit ${run.exitCode}, stdout ${JSON.stringify(run.stdout)}`);
  assert.ok(!run.stdout.trim().startsWith('{'), `facts printed on failure: ${run.stdout}`);
});

void test('facts (iv): a library site wired by two apps -> two app-keyed facts with the library site as ref', () => {
  for (const app of ['d-service', 'e-service']) {
    assert.deepEqual(eventSites(serviceFacts(app).events_consumed, 'FixtureLibEvent'), [
      { event_type: 'FixtureLibEvent', site: LIB_CONSUMER },
    ]);
    assert.deepEqual(eventSites(serviceFacts(app).events_produced, 'FixtureLibProduced'), [
      { event_type: 'FixtureLibProduced', site: LIB_PRODUCER },
    ]);
    assert.deepEqual(eventEdges(serviceFacts(app).edges, 'FixtureLibProduced'), [
      { kind: 'event', to: 'b-service', subject: 'FixtureLibProduced' },
    ]);
  }
  // A library is never a service key and never an edge endpoint.
  const services = facts().services.map((entry) => entry.service);
  assert.deepEqual([...services].sort(), [...FACTS_APPS]);
  for (const entry of facts().services) {
    for (const edge of entry.edges) assert.ok(services.includes(edge.to), edge.to);
  }
});

void test('facts: the NATS identity of each app is its services.yaml name, with its line', () => {
  for (const app of FACTS_APPS) {
    const name = app.replace(/-/g, '_');
    assert.deepEqual(serviceFacts(app).nats_identity, {
      name,
      ref: `${NATS_REF}:${lineOf(FACTS_SERVICES_YAML, `- name: ${name}`)}`,
    });
  }
});

void test('facts: each event interface in libs/event-contracts is listed with its definition site', () => {
  for (const eventType of ['FixtureShipped', 'FixtureLibEvent', 'FixtureLibProduced']) {
    assert.deepEqual(eventSites(facts().event_definitions, eventType), [
      {
        event_type: eventType,
        site: `libs/event-contracts/src/fixture-events.ts:${lineOf(FIXTURE_EVENTS, `'${eventType}'`)}`,
      },
    ]);
  }
});

void test('one owner of "who produces event T": scanEventProducers is defined once, in this module', () => {
  // service-expertise PLAN §2: the producer scan lives inside event-consumer-index.ts (readonly,
  // CODEOWNED); tools/ripple-tracer, which takes producers from ACL grants, is not a source.
  const tracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '--', 'tools'], {
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) => /\.ts$/.test(path) && !/\.(?:spec|test)\.ts$/.test(path));
  const owners = tracked.filter((path) =>
    /\bfunction\s+scanEventProducers\b/.test(readFileSync(join(REPO_ROOT, path), 'utf8')),
  );
  assert.deepEqual(owners, ['tools/gates/event-consumer-index.ts']);
});

// --- SE-3 review round 1 blockers (build/SE-3/review-r1-blockers.md), pinned before round 2 ----

// Architecture B2: a code subscription to a subject that names no known event type was dropped
// (live: admin-api-service events.security.events.auth.login.*, observability-service
// events.platform.schema-migration.>). Architecture B3: an app the TypeScript scan cannot read
// (sensor-ingestion, Rust) was listed with empty lists, which reads as "produces nothing".
const SUBJECT_BUS = [
  'export interface ISubjectBus {',
  '  subscribeTo(topic: string, handler: object): Promise<void>;',
  '}',
  '',
].join('\n');

const LOGIN_SUBJECT = 'events.security.events.auth.login.*';
const MIGRATION_SUBJECT = 'events.platform.schema-migration.>';
const SUBJECT_LISTENER = [
  "import type { ISubjectBus } from '../../../platform/libs/event-bus/src/subject-bus';",
  'export class SecurityListener {',
  '  constructor(private readonly bus: ISubjectBus) {}',
  '  async start(): Promise<void> {',
  `    await this.bus.subscribeTo('${LOGIN_SUBJECT}', this);`,
  `    await this.bus.subscribeTo('${MIGRATION_SUBJECT}', this);`,
  '  }',
  '}',
  '',
].join('\n');
const SUBJECT_APP = 'f-service';
const SUBJECT_SITES: readonly (readonly [string, string])[] = [
  [
    LOGIN_SUBJECT,
    `apps/${SUBJECT_APP}/src/security-listener.ts:${lineOf(SUBJECT_LISTENER, 'auth.login')}`,
  ],
  [
    MIGRATION_SUBJECT,
    `apps/${SUBJECT_APP}/src/security-listener.ts:${lineOf(SUBJECT_LISTENER, 'schema-migration')}`,
  ],
];
const UNSCANNED_APP = 'g-ingest';

/** The round-1 facts fixture plus a subject-only subscriber and an app with no TypeScript. */
function roundTwoRepo(): string {
  return writeTree(factsRepo(FACTS_SERVICES_YAML), {
    'platform/libs/event-bus/src/subject-bus.ts': SUBJECT_BUS,
    [`apps/${SUBJECT_APP}/project.json`]: JSON.stringify({ name: SUBJECT_APP }),
    [`apps/${SUBJECT_APP}/src/security-listener.ts`]: SUBJECT_LISTENER,
    [`apps/${UNSCANNED_APP}/project.json`]: JSON.stringify({ name: UNSCANNED_APP }),
    [`apps/${UNSCANNED_APP}/Cargo.toml`]: '[package]\nname = "g-ingest"\nversion = "0.1.0"\n',
    [`apps/${UNSCANNED_APP}/src/main.rs`]:
      'fn main() { publish("events.tenant.SensorReading"); }\nfn publish(_subject: &str) {}\n',
  });
}

let roundTwoRun: FactsRun | null = null;
function roundTwoFacts(): Record<string, unknown> {
  roundTwoRun ??= runFactsEntry(roundTwoRepo());
  const run = roundTwoRun;
  assert.equal(run.exitCode, 0, `--facts exited ${run.exitCode}: ${run.stderr}`);
  const parsed: unknown = JSON.parse(run.stdout);
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
  return parsed as Record<string, unknown>;
}

/** Every object inside `value`, with the `services[i].service` it lies under (or null). */
function objectsIn(
  value: unknown,
  service: string | null = null,
  out: { readonly holder: Record<string, unknown>; readonly service: string | null }[] = [],
): { readonly holder: Record<string, unknown>; readonly service: string | null }[] {
  if (Array.isArray(value)) {
    for (const item of value) objectsIn(item, service, out);
  } else if (typeof value === 'object' && value !== null) {
    const holder = value as Record<string, unknown>;
    out.push({ holder, service });
    for (const child of Object.values(holder)) objectsIn(child, service, out);
  }
  return out;
}

/** Every string inside `value`. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}

function serviceEntry(facts: Record<string, unknown>, service: string): unknown {
  const services = facts.services;
  assert.ok(Array.isArray(services));
  const found = services.filter(
    (entry: unknown) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as { service?: unknown }).service === service,
  );
  assert.equal(found.length, 1, `exactly one facts entry for ${service}`);
  return found[0];
}

/** Top-level keys of the round-1 output; a new top-level list may name what the scan could not read. */
const ROUND_ONE_TOP_LEVEL: ReadonlySet<string> = new Set([
  'schema',
  'services',
  'event_definitions',
  'unresolved',
  'unattributed',
  'nats_identities_without_application',
]);

/** True when the facts name `app` as not scanned: an `unavailable:<reason>` state in its own entry, or a new top-level list naming it. */
function namedUnscanned(facts: Record<string, unknown>, app: string): boolean {
  if (stringsIn(serviceEntry(facts, app)).some((text) => text.startsWith('unavailable:')))
    return true;
  return Object.entries(facts).some(
    ([key, value]) => !ROUND_ONE_TOP_LEVEL.has(key) && stringsIn(value).includes(app),
  );
}

void test('facts: a code subscription to a subject that names no known event type is a fact of its app, never dropped', () => {
  const facts = roundTwoFacts();
  for (const [subject, site] of SUBJECT_SITES) {
    const holders = objectsIn(facts.services).map(({ holder }) => holder);
    const attributed = [
      // inside f-service's own entry
      ...objectsIn(serviceEntry(facts, SUBJECT_APP), SUBJECT_APP),
      // or in a named top-level list, keyed by the application
      ...Object.entries(facts)
        .filter(([key]) => key !== 'services')
        .flatMap(([, value]) => objectsIn(value))
        .filter(({ holder }) => Object.values(holder).includes(SUBJECT_APP)),
    ].filter(
      ({ holder }) =>
        Object.values(holder).includes(site) && Object.values(holder).includes(subject),
    );
    assert.ok(
      attributed.length > 0,
      `${subject} at ${site} is in no facts entry of ${SUBJECT_APP} (objects under services: ${holders.length})`,
    );
  }
});

void test('facts: an app the TypeScript scan cannot read is named unavailable, never listed as producing nothing', () => {
  const facts = roundTwoFacts();
  assert.ok(
    namedUnscanned(facts, UNSCANNED_APP),
    JSON.stringify(serviceEntry(facts, UNSCANNED_APP)),
  );
  // A TypeScript app is read, whether or not it has event code.
  for (const app of ['a-service', 'c-service', SUBJECT_APP]) {
    assert.equal(namedUnscanned(facts, app), false, `${app} is a TypeScript app the scan reads`);
  }
});

// Single-owner blockers 1 and 2: a second producer-site scanner (the emit invariant's
// `createBaseEvent('…')` regex) and a second and third reader of "where event T is defined"
// (event-contracts-adapter's readEventTypeLiteral, the invariant's `export interface …Event`
// regex) lived beside the owners in this module.

const EMIT_INVARIANT = 'tests/invariants/event-contract-emit-has-interface.spec.ts';

function parsedSource(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(join(REPO_ROOT, path), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
}

function nodesOf(source: ts.SourceFile): ts.Node[] {
  const nodes: ts.Node[] = [];
  const visit = (node: ts.Node): void => {
    nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return nodes;
}

/** Regex literals, and string or template literals handed to the RegExp constructor. */
function regexTexts(source: ts.SourceFile): string[] {
  return nodesOf(source).flatMap((node): string[] => {
    if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) return [node.getText(source)];
    if (
      (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
      node.expression.getText(source) === 'RegExp'
    ) {
      const [pattern] = node.arguments ?? [];
      if (pattern === undefined) return [];
      if (ts.isStringLiteralLike(pattern)) return [pattern.text];
      // A template interpolates a value into the pattern, e.g. the event type being looked up.
      return ts.isTemplateExpression(pattern) ? [pattern.getText(source)] : [];
    }
    return [];
  });
}

void test('one owner of "who produces event T": the emit invariant reads scanEventProducers and has no producer regex', () => {
  const source = parsedSource(EMIT_INVARIANT);
  const importsOwner = source.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      /(?:^|\/)tools\/gates\/event-consumer-index$/.test(statement.moduleSpecifier.text) &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) => element.name.text === 'scanEventProducers',
      ),
  );
  assert.ok(importsOwner, `${EMIT_INVARIANT} does not import scanEventProducers from its owner`);
  assert.deepEqual(
    regexTexts(source).filter((text) => text.includes('createBaseEvent')),
    [],
    `${EMIT_INVARIANT} still discovers producer sites with its own regex`,
  );
  // Sites the scan cannot fold or attribute fail the invariant by name, never pass silently.
  const accessed = new Set(
    nodesOf(source)
      .filter(ts.isPropertyAccessExpression)
      .map((node) => node.name.text),
  );
  for (const name of ['unresolved', 'unattributed']) {
    assert.ok(accessed.has(name), `${EMIT_INVARIANT} never reads the scan's ${name} sites`);
  }
});

// --- SE-3-R2 corrective round 1 (build/SE-3-R2/appellate-r1.md roots R1-R3) -------------------

// Root R1: both --facts entries read the disk, while the kernel's clean-tree check sees only what
// `git status` shows. An ignored file under a scanned src root (the repo ignores tmp, build, dist…
// at any depth), an untracked file, an empty apps/<dir> or an ignored-only one became facts and
// services stamped with the base commit. Everything the scans enumerate is now the tree's tracked
// set, so such content never reaches the facts.
const PLANTED_IGNORED = [
  "import { createBaseEvent } from '../../../../libs/event-contracts/src/base-event';",
  "export const planted = createBaseEvent('PlantedIgnored', 'tenant-1');",
  '',
].join('\n');
const PLANTED_UNTRACKED = [
  "import { createBaseEvent } from '../../../libs/event-contracts/src/base-event';",
  "export const planted = createBaseEvent('PlantedUntracked', 'tenant-1');",
  '',
].join('\n');

/** The facts fixture plus content that is not in its tracked set. */
function untrackedContentRepo(): string {
  const root = writeTree(factsRepo(FACTS_SERVICES_YAML), { '.gitignore': 'tmp\nbuild\n' });
  // Written after indexing, so none of these is tracked.
  const plant = (path: string, text: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, 'utf8');
  };
  plant('apps/a-service/src/tmp/planted.ts', PLANTED_IGNORED);
  plant('apps/a-service/src/untracked.ts', PLANTED_UNTRACKED);
  plant('apps/build/project.json', JSON.stringify({ name: 'phantom-build-service' }));
  plant('apps/untracked-service/project.json', JSON.stringify({ name: 'untracked-service' }));
  mkdirSync(join(root, 'apps', 'ghost-service', 'src'), { recursive: true });
  return root;
}

void test('R1: ignored and untracked files, and app directories with no tracked file, never reach the facts', () => {
  const root = untrackedContentRepo();
  // Precondition: git sees the ignored paths as ignored, the others as untracked.
  const ignored = execFileSync(
    'git',
    ['-C', root, 'status', '--porcelain', '--ignored=matching', '--untracked-files=all'],
    { encoding: 'utf8', env: hermeticGitEnv() },
  );
  // git collapses an ignored directory to its name.
  assert.match(ignored, /^!! apps\/a-service\/src\/tmp\/$/m);
  assert.match(ignored, /^!! apps\/build\/$/m);
  assert.match(ignored, /^\?\? apps\/a-service\/src\/untracked\.ts$/m);

  const run = runFactsEntry(root);
  assert.equal(run.exitCode, 0, run.stderr);
  for (const planted of ['PlantedIgnored', 'PlantedUntracked', 'tmp/planted.ts', 'untracked.ts']) {
    assert.ok(!run.stdout.includes(planted), `${planted} reached the facts`);
  }
  const parsed = JSON.parse(run.stdout) as { services: readonly { service: string }[] };
  assert.deepEqual(parsed.services.map((entry) => entry.service).sort(), [...FACTS_APPS].sort());

  const producerSites = scanEventProducers(root).sites.map((site) => site.site);
  assert.ok(producerSites.includes(SHIPPED_PRODUCER), producerSites.join(', '));
  assert.ok(
    producerSites.every((site) => !site.includes('planted') && !site.includes('untracked')),
    producerSites.join(', '),
  );
  assert.deepEqual(
    [...new Set(applicationNames(trackedTree(root)).values())].sort(),
    [...FACTS_APPS].sort(),
  );
});

// SE-3-R2 corrective round 2, root RB (build/SE-3-R2/appellate-r2.md): R1 bounded what the scans
// enumerate, but the type checker still resolved imports on the default compiler host, so a
// tracked file importing an ignored module, a module behind an ignored directory symlink, or one at
// an absolute path outside the tree turned that content into facts. The checker now sees only the
// tracked tree (no symlink at any level), the workspace node_modules and the TypeScript lib dir.
const PLANTED_VIA_IMPORT = 'PlantedViaIgnoredImport';
const VIA_IMPORT = 'apps/a-service/src/via-import.ts';

function viaImportSource(specifier: string): string {
  return [
    "import { createBaseEvent } from '../../../libs/event-contracts/src/base-event';",
    `import { PLANTED_TYPE } from '${specifier}';`,
    "export const viaImport = createBaseEvent(PLANTED_TYPE, 'tenant-1');",
    '',
  ].join('\n');
}

const PLANTED_VALUE = `export const PLANTED_TYPE = '${PLANTED_VIA_IMPORT}' as const;\n`;

/** Facts and the producer scan before and after `plant` writes content outside the tracked set. */
function assertImportOutsideTheTreeIsNoFact(root: string, plant: () => void): void {
  const before = JSON.stringify(eventFacts(root));
  plant();
  const status = execFileSync(
    'git',
    ['-C', root, 'status', '--porcelain', '--untracked-files=all'],
    { encoding: 'utf8', env: hermeticGitEnv() },
  );
  // The fixture is indexed, not committed: its files are staged, and the planted path is not listed.
  assert.ok(!status.includes('tmp') && !status.includes('value'), status);
  const after = JSON.stringify(eventFacts(root));
  assert.equal(after, before, 'content outside the tracked tree changed the facts');
  assert.ok(!after.includes(PLANTED_VIA_IMPORT), `${PLANTED_VIA_IMPORT} reached the facts`);
  const producers = scanEventProducers(root);
  assert.ok(
    producers.unresolved.some((site) => site.site === `${VIA_IMPORT}:3`),
    JSON.stringify(producers.unresolved),
  );
  assert.ok(!JSON.stringify(producers).includes(PLANTED_VIA_IMPORT));
}

void test('RB: a tracked file importing an ignored module never turns that module into facts', () => {
  const root = writeTree(factsRepo(FACTS_SERVICES_YAML), {
    '.gitignore': 'tmp\n',
    [VIA_IMPORT]: viaImportSource('./tmp/value'),
  });
  assertImportOutsideTheTreeIsNoFact(root, () => {
    mkdirSync(join(root, 'apps', 'a-service', 'src', 'tmp'), { recursive: true });
    writeFileSync(join(root, 'apps', 'a-service', 'src', 'tmp', 'value.ts'), PLANTED_VALUE, 'utf8');
  });
});

void test('RB: a module behind an ignored directory symlink never becomes facts', () => {
  const root = writeTree(factsRepo(FACTS_SERVICES_YAML), {
    '.gitignore': 'tmp\n',
    [VIA_IMPORT]: viaImportSource('./tmp/value'),
  });
  assertImportOutsideTheTreeIsNoFact(root, () => {
    const outside = mkdtempSync(join(scratch, 'outside-dir-'));
    writeFileSync(join(outside, 'value.ts'), PLANTED_VALUE, 'utf8');
    symlinkSync(outside, join(root, 'apps', 'a-service', 'src', 'tmp'), 'dir');
  });
});

void test('RB: a module at an absolute path outside the tree never becomes facts', () => {
  const outside = mkdtempSync(join(scratch, 'outside-absolute-'));
  const root = writeTree(factsRepo(FACTS_SERVICES_YAML), {
    [VIA_IMPORT]: viaImportSource(join(outside, 'value')),
  });
  assertImportOutsideTheTreeIsNoFact(root, () => {
    writeFileSync(join(outside, 'value.ts'), PLANTED_VALUE, 'utf8');
  });
});

// Root R2: the SE-1 key reader followed a symlinked apps/<dir>/project.json out of the tree, and a
// target that is not JSON reached the kernel's witness through the SyntaxError's message.
const OUTSIDE_MARKER = 'ZQXJ-outside-marker-7c41';

/** The facts fixture with a tracked apps/x-service/project.json that links out of the tree. */
function linkedProjectRepo(): string {
  const outside = mkdtempSync(join(scratch, 'outside-'));
  writeFileSync(join(outside, 'marker.txt'), `${OUTSIDE_MARKER}\n`, 'utf8');
  const root = factsRepo(FACTS_SERVICES_YAML);
  mkdirSync(join(root, 'apps', 'x-service', 'src'), { recursive: true });
  writeFileSync(join(root, 'apps', 'x-service', 'src', 'main.ts'), 'export const x = 1;\n', 'utf8');
  symlinkSync(join(outside, 'marker.txt'), join(root, 'apps', 'x-service', 'project.json'));
  return indexFixtureTree(root);
}

void test('R2: a tracked project.json that is a symlink is a named unavailability (exit 2) that carries no target content', () => {
  const root = linkedProjectRepo();
  const tracked = execFileSync('git', ['-C', root, 'ls-files', '-s', '--', 'apps/x-service'], {
    encoding: 'utf8',
    env: hermeticGitEnv(),
  });
  assert.match(tracked, /^120000 \S+ 0\tapps\/x-service\/project\.json$/m);
  const run = runFactsEntry(root);
  assert.equal(run.exitCode, 2, `exit ${run.exitCode}: ${run.stderr}`);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /SourceTreeUnavailable/);
  assert.match(run.stderr, /apps\/x-service\/project\.json/);
  assert.ok(
    !`${run.stdout}${run.stderr}`.includes(OUTSIDE_MARKER.slice(0, 4)),
    `the target's content reached the output: ${run.stderr}`,
  );
});

void test('R2: a tracked project.json that is not JSON is a named unavailability (exit 2) that carries no file content', () => {
  const root = writeTree(factsRepo(FACTS_SERVICES_YAML), {
    'apps/y-service/project.json': `${OUTSIDE_MARKER} is not JSON\n`,
    'apps/y-service/src/main.ts': 'export const y = 1;\n',
  });
  const run = runFactsEntry(root);
  assert.equal(run.exitCode, 2, `exit ${run.exitCode}: ${run.stderr}`);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /SourceTreeUnavailable/);
  assert.match(run.stderr, /apps\/y-service\/project\.json/);
  assert.ok(!run.stderr.includes(OUTSIDE_MARKER.slice(0, 4)), run.stderr);
});

// Root R3: "who produces event T" (scanEventProducers) and "where event T is defined"
// (eventDefinitionsIn) are owned here, but the round-2 pins searched only tools/ and one syntactic
// form, so live readers with their own rules survived unlisted. These pins read every tracked
// *.ts and *.py file. A reader is a pattern that EXTRACTS the concept: a regex (a literal, a string
// or template handed to RegExp, or a Python `re.*` pattern) that captures the event-type argument
// of a `createBaseEvent(` call, or that reads an `eventType:` literal (captured, or interpolated
// for a given type) or an interface extending BaseEvent; or a TypeScript AST comparison of a name
// with the constructor or with the `eventType` member. A matcher for one named type (a provenance
// or retirement check) asserts a fact about that type and is not a reader. Every reader other
// than the owner is listed by the open registry finding that tracks its fold; a listed reader
// that is gone fails as stale, and the owner must itself be found, so the pin cannot pass empty.

/** The literals are assembled so this file's own patterns and comparisons are not readers. */
const CONSTRUCTOR_NAME = ['create', 'BaseEvent'].join('');
const MEMBER_NAME = ['event', 'Type'].join('');
const OWNER_MODULE = 'tools/gates/event-consumer-index.ts';
const REGISTRY_PATH = 'docs/reviews/_registry/findings.jsonl';

type ReaderConcept = 'producer' | 'definition';

/** A capture group that is not escaped and not `(?…)`. */
const CAPTURE = /(?:^|[^\\])\((?!\?)/;
const CALL_OPEN = String.raw`\(`;

/** The pattern captures what follows the constructor's opening parenthesis: the event type. */
function capturesConstructorArgument(pattern: string): boolean {
  const at = pattern.indexOf(CONSTRUCTOR_NAME);
  if (at === -1) return false;
  const open = pattern.indexOf(CALL_OPEN, at + CONSTRUCTOR_NAME.length);
  return open !== -1 && CAPTURE.test(pattern.slice(open + CALL_OPEN.length));
}

const MEMBER_LITERAL = new RegExp(`${MEMBER_NAME}[^:]{0,16}:`);
const INTERPOLATION = /\$\{/;

/** The pattern reads an `eventType:` literal (captured or interpolated), or a BaseEvent interface by name. */
function readsDefinitions(pattern: string): boolean {
  const member = pattern.search(MEMBER_LITERAL);
  if (member !== -1) {
    const rest = pattern.slice(member);
    return CAPTURE.test(rest) || INTERPOLATION.test(rest);
  }
  return /extends/.test(pattern) && pattern.includes('BaseEvent') && CAPTURE.test(pattern);
}

const PYTHON_PATTERN =
  /\bre\.(?:compile|search|match|fullmatch|findall|finditer|sub|split)\(\s*[rRbBuU]*("""|'''|"|')((?:(?!\1)[\s\S])*?)\1/g;

const EQUALITY: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** AST forms: a name compared with the constructor, or a node's `.text` compared with the member. */
function astReaders(source: ts.SourceFile): Set<ReaderConcept> {
  const nodes = nodesOf(source);
  const constants = new Map<string, string>();
  for (const node of nodes) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      constants.set(node.name.text, node.initializer.text);
    }
  }
  const valueOf = (side: ts.Expression): string | undefined =>
    ts.isStringLiteralLike(side)
      ? side.text
      : ts.isIdentifier(side)
        ? constants.get(side.text)
        : undefined;
  const found = new Set<ReaderConcept>();
  for (const node of nodes) {
    if (!ts.isBinaryExpression(node) || !EQUALITY.has(node.operatorToken.kind)) continue;
    for (const [side, other] of [
      [node.left, node.right],
      [node.right, node.left],
    ] as const) {
      const value = valueOf(side);
      if (value === CONSTRUCTOR_NAME) found.add('producer');
      if (
        value === MEMBER_NAME &&
        ts.isPropertyAccessExpression(other) &&
        other.name.text === 'text'
      ) {
        found.add('definition');
      }
    }
  }
  return found;
}

let readerScan: ReadonlyMap<ReaderConcept, readonly string[]> | null = null;

/** Every tracked *.ts / *.py file (outside node_modules) holding a reader form, per concept. */
function conceptReaders(): ReadonlyMap<ReaderConcept, readonly string[]> {
  if (readerScan !== null) return readerScan;
  const tracked = execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '--', '*.ts', '*.py'], {
    encoding: 'utf8',
    env: hermeticGitEnv(),
    maxBuffer: 256 * 1024 * 1024,
  })
    .split('\0')
    .filter((path) => path.length > 0 && !path.split('/').includes('node_modules'));
  const readers = new Map<ReaderConcept, string[]>([
    ['producer', []],
    ['definition', []],
  ]);
  for (const path of tracked) {
    const text = readFileSync(join(REPO_ROOT, path), 'utf8');
    if (![CONSTRUCTOR_NAME, MEMBER_NAME, 'BaseEvent'].some((name) => text.includes(name))) continue;
    const concepts = new Set<ReaderConcept>();
    let patterns: string[];
    if (path.endsWith('.py')) {
      patterns = [...text.matchAll(PYTHON_PATTERN)].map((match) => match[2] ?? '');
    } else {
      const source = parsedSource(path);
      patterns = regexTexts(source);
      for (const concept of astReaders(source)) concepts.add(concept);
    }
    for (const pattern of patterns) {
      if (capturesConstructorArgument(pattern)) concepts.add('producer');
      if (readsDefinitions(pattern)) concepts.add('definition');
    }
    for (const concept of concepts) readers.get(concept)?.push(path);
  }
  readerScan = readers;
  return readers;
}

/** Open registry ids (the reader's tracked fold) -> the readers each one lists. */
const KNOWN_PRODUCER_READERS: Readonly<Record<string, readonly string[]>> = {
  // extractPublishedEventTypes (PUBLISH COVERAGE); folds after ARIA-MEDIUM-792, before SE-4.
  'CONTRACT-MEDIUM-015': ['e2e/tests/integration/nats-invariants.spec.ts'],
};
const KNOWN_DEFINITION_READERS: Readonly<Record<string, readonly string[]>> = {
  // Its `eventType: 'X'` literal regex, part of the same producer reader.
  'CONTRACT-MEDIUM-015': ['e2e/tests/integration/nats-invariants.spec.ts'],
  // extractEventTypes; removed with the witness's event-consumer nodes by SE-4.
  'ARIA-MEDIUM-793': ['tools/gates/plan-coverage-witness.ts'],
  'CONTRACT-MEDIUM-016': [
    'tests/invariants/feeding-event-delivery-semantics.spec.ts',
    'tests/invariants/pii-events-mandatory-crypto-shred.spec.ts',
  ],
  // _EVENT_INTERFACE_RE; tombstoned with the module in F0.9b (service-expertise PLAN §2 row 1.3).
  'ARIA-MEDIUM-794': ['aria-kernel/aria_kernel/recursive_impact.py'],
};

/**
 * The owner's own oracle: event-producer-scan.spec.ts finds every constructor call with an
 * independent parse and asserts the owner returns exactly those sites, so it cannot disagree with
 * the owner silently. Listed so a new reader in a spec still has to be named.
 */
const PRODUCER_ORACLES: readonly string[] = ['tools/gates/event-producer-scan.spec.ts'];

/** Reader-shaped patterns that read another fact, with what they read. */
const NOT_DEFINITION_READERS: Readonly<Record<string, string>> = {
  'tests/invariants/upcaster-chain.spec.ts':
    "the event an upcaster upcasts (its object's eventType property), not where the event is defined",
};

/** Registry id -> state. */
function registryStates(): Map<string, string> {
  const states = new Map<string, string>();
  for (const line of readFileSync(join(REPO_ROOT, REGISTRY_PATH), 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const row = JSON.parse(line) as { id: string; state: string };
    states.set(row.id, row.state);
  }
  return states;
}

function assertOneOwner(
  concept: ReaderConcept,
  known: Readonly<Record<string, readonly string[]>>,
  exempt: readonly string[],
): void {
  const found = conceptReaders().get(concept) ?? [];
  assert.ok(found.includes(OWNER_MODULE), `the owner ${OWNER_MODULE} holds no ${concept} reader`);
  const states = registryStates();
  const listed = new Set<string>();
  for (const [id, paths] of Object.entries(known)) {
    assert.ok(
      isUnresolvedFindingState(states.get(id) ?? ''),
      `${id} lists ${paths.join(', ')} but is not an unresolved registry finding (${states.get(id) ?? 'absent'})`,
    );
    for (const path of paths) {
      assert.ok(
        found.includes(path),
        `${id}: ${path} holds no ${concept} reader any more (stale entry)`,
      );
      listed.add(path);
    }
  }
  for (const path of exempt) {
    assert.ok(
      found.includes(path),
      `${path} holds no ${concept} reader any more (stale exemption)`,
    );
    listed.add(path);
  }
  const unlisted = found.filter((path) => path !== OWNER_MODULE && !listed.has(path));
  assert.deepEqual(
    unlisted,
    [],
    `${concept} readers beside the owner with no tracked fold: ${unlisted.join(', ')}`,
  );
}

void test('R3: one owner of "who produces event T": every other producer reader in the tree is tracked by an open finding', () => {
  assertOneOwner('producer', KNOWN_PRODUCER_READERS, PRODUCER_ORACLES);
});

void test('R3: one owner of "where event T is defined": every other definition reader in the tree is tracked by an open finding', () => {
  assertOneOwner('definition', KNOWN_DEFINITION_READERS, Object.keys(NOT_DEFINITION_READERS));
  assert.deepEqual(
    regexTexts(parsedSource(EMIT_INVARIANT)).filter((text) => text.includes('interface')),
    [],
    `${EMIT_INVARIANT} still discovers declared interfaces with its own regex`,
  );
});
