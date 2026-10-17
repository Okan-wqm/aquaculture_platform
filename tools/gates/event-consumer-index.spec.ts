#!/usr/bin/env ts-node
/**
 * tools/gates/event-consumer-index.ts — event consumers read from the code (ARIA-HIGH-313).
 *
 * The fixture cases build a throwaway repository with a minimal event bus, NATS client and
 * NestJS microservices declaration, one subscription per fold rule, and libraries wired in the
 * ways the scan attributes. The live cases run the scan on this checkout and compare it to
 * independent reads: a regex count of the subscription forms, the source of
 * TRIGGER_EVENT_MAP and the erasure-target registry, and the apps that wire library modules.
 *
 * Invoke via:
 *   ts-node --project tools/gates/tsconfig.json tools/gates/event-consumer-index.spec.ts
 */

import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { after, test } from 'node:test';

import { TENANT_ERASURE_OUTCOME_EVENT_TYPES_BY_TARGET } from '../../libs/event-contracts/src/tenant-erasure-targets';

import {
  type EventConsumerIndex,
  eventConsumersFor,
  FORWARDING_SITES,
  scanEventConsumers,
} from './event-consumer-index';
import { removeFixtureTree } from './fixture-tree';
import { loadNatsServices } from './nats-services';

const REPO_ROOT = resolve(__dirname, '..', '..');
const scratch = mkdtempSync(join(tmpdir(), 'event-consumer-index-spec-'));
after(() => removeFixtureTree(scratch));

function writeTree(root: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text, 'utf8');
  }
  return root;
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
