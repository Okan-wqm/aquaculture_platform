import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixtureTree } from '../gates/fixture-tree';

import { analyzeTenantScoping } from './tenant-scoping-adapter';

const workspace = makeFixtureTree('aria-tenant-scoping-adapter-');
const root = join(workspace, 'apps/farm-service/src');
mkdirSync(root, { recursive: true });

// DET tenant-2 — a repository read is a finding only on a table shared across
// tenants, which TypeORM spells as an explicit `schema` on the entity; the
// unscoped reads below are findings because Batch's table declares one.
writeFileSync(
  join(root, 'batch.entity.ts'),
  `
    function Entity(name: string, options?: { schema: string }) { return () => undefined; }
    @Entity('batches', { schema: 'farm' })
    export class Batch {
      id!: string;
      tenantId!: string;
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'safe.service.ts'),
  `
    import { Batch } from './batch.entity';
    interface Repository<T> { findOne(input: unknown): Promise<T | null>; }
    export class SafeService {
      constructor(private readonly repo: Repository<Batch>) {}
      load(id: string, tenantId: string) {
        return this.repo.findOne({ where: { id, tenantId } });
      }
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'unsafe.service.ts'),
  `
    import { Batch } from './batch.entity';
    interface Repository<T> { findOne(input: unknown): Promise<T | null>; }
    export class UnsafeService {
      constructor(private readonly repo: Repository<Batch>) {}
      load(id: string, tenantId: string) {
        return this.repo.findOne({ where: { id } });
      }
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'safe-tenant-manager.service.ts'),
  `
    import { Batch } from './batch.entity';
    import { tenantManagerRepo } from '@aqua/backend-common';
    export class ScopedService {
      load(manager: any, tenantId: string) {
        const repo = tenantManagerRepo(manager, Batch, tenantId);
        return repo.findOne({ where: { id: '1' } });
      }
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'raw-query.service.ts'),
  `
    interface DataSource { query(sql: string, args: unknown[]): Promise<unknown>; }
    export class RawQueryService {
      load(dataSource: DataSource, tenantId: string) {
        return dataSource.query('select * from batches where id = $1', ['1']);
      }
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'array-find.service.ts'),
  `
    export class ArrayFindService {
      load(items: Array<{ id: string }>, tenantId: string) {
        return items.find((item) => item.id === tenantId);
      }
    }
  `,
  'utf8',
);
writeFileSync(
  join(root, 'app.module.ts'),
  `
    import { APP_GUARD } from '@nestjs/core';
    import { TenantGuard } from './tenant.guard';
    export const guards = [{ provide: APP_GUARD, useClass: TenantGuard }];
  `,
  'utf8',
);

// ARIA-HIGH-045 — a finding names the symbol it sits in, so two unscoped
// reads in one file are told apart by WHERE in the code they are (which
// method), not by their line number, which every edit above them moves.
writeFileSync(
  join(root, 'two-methods.service.ts'),
  `
    import { Batch } from './batch.entity';
    interface Repository<T> { findOne(input: unknown): Promise<T | null>; }
    export class TwoMethodsService {
      constructor(private readonly repo: Repository<Batch>) {}
      loadOne(id: string, tenantId: string) {
        return this.repo.findOne({ where: { id } });
      }
      loadTwo(id: string, tenantId: string) {
        return [id].map((key) => {
          const owner = tenantId;
          return this.repo.findOne({ where: { id: key } });
        });
      }
    }
    export const loadArrow = (repo: Repository<Batch>, id: string, tenantId: string) => {
      return repo.findOne({ where: { id } });
    };
    export function loadFree(repo: Repository<Batch>, id: string, tenantId: string) {
      return repo.findOne({ where: { id } });
    }
    declare const moduleRepo: Repository<Batch>;
    export const moduleLoad = moduleRepo.findOne({ where: { id: 'm' } });
  `,
  'utf8',
);

const output = analyzeTenantScoping(
  { roots: ['apps/farm-service/src'], includeRepositoryReadFindings: true },
  workspace,
);

assert.equal(output.metadata.adapter, 'tenant-scoping-adapter');
assert.equal(
  output.observations.some((item) => item.type === 'tenant_source'),
  true,
);
assert.equal(
  output.observations.some((item) => item.type === 'tenant_repository_call'),
  true,
);
assert.equal(
  output.observations.some((item) => item.type === 'tenant_guard_registration'),
  true,
);
assert.equal(
  output.findings.some(
    (finding) =>
      finding.rule === 'tenant_repository_unscoped_read' &&
      finding.path.endsWith('unsafe.service.ts'),
  ),
  true,
);
assert.equal(
  output.findings.some(
    (finding) =>
      finding.rule === 'tenant_raw_query_missing_tenant_predicate' &&
      finding.path.endsWith('raw-query.service.ts'),
  ),
  true,
);
assert.equal(
  output.findings.some((finding) => finding.path.endsWith('/safe.service.ts')),
  false,
);
assert.equal(
  output.findings.some((finding) => finding.path.endsWith('safe-tenant-manager.service.ts')),
  false,
);
assert.equal(
  output.findings.some((finding) => finding.path.endsWith('array-find.service.ts')),
  false,
);
assert.equal(
  output.findings.some((finding) => finding.rule === 'tenant_guard_missing'),
  false,
);

type TenantFinding = (typeof output.findings)[number];
function symbolOf(finding: TenantFinding | undefined): unknown {
  assert.ok(finding, 'the expected finding exists');
  assert.ok(finding.details, 'a tenant finding carries details');
  return finding.details.enclosingSymbol;
}
const twoMethodSymbols = output.findings
  .filter((finding) => finding.path.endsWith('two-methods.service.ts'))
  .map((finding) => symbolOf(finding))
  .sort();
assert.deepEqual(twoMethodSymbols, [
  '<module>',
  'TwoMethodsService.loadOne',
  'TwoMethodsService.loadTwo.<anonymous>',
  'loadArrow',
  'loadFree',
]);
assert.equal(
  symbolOf(output.findings.find((finding) => finding.path.endsWith('unsafe.service.ts'))),
  'UnsafeService.load',
);
assert.equal(
  symbolOf(
    output.findings.find((finding) => finding.rule === 'tenant_raw_query_missing_tenant_predicate'),
  ),
  'RawQueryService.load',
);

// B04 — the guard rule reads each app.module.ts as a syntax tree: only an
// APP_GUARD provider whose class, alias or factory names a tenant guard is a
// registration, and only an import specifier is an import. A mention in an
// export list, a comment or a plain provider beside a JwtAuthGuard APP_GUARD is
// neither. Each module that must be flagged has a near-miss where the guard is
// really registered.
type GuardOutcome = 'flagged' | 'registered' | 'absent';
type GuardRow = readonly [name: string, outcome: GuardOutcome, ...lines: string[]];
const guard = (provider: string): string => `{ provide: APP_GUARD, ${provider} }`;
const mod = (providers: string, exports = ''): string =>
  `import { APP_GUARD } from '@nestjs/core';\n@Module({ providers: [${providers}]${exports} })`;
const imp = (names: string): string => `import { ${names} } from './guards';`;
const JWT = guard('useClass: JwtAuthGuard');
const TENANT = guard('useClass: TenantGuard');
const BOTH = imp('JwtAuthGuard, TenantGuard');
const ONLY = imp('TenantGuard');
const EXPORT = ', exports: [TenantGuard]';
const NOTE = '// TenantGuard is applied at the gateway';
// Longer than the 240 characters a text window reaches: what is above it is not
// "next to" the APP_GUARD below it.
const FAR = `// ${'-'.repeat(260)}`;
const guardRows: readonly GuardRow[] = [
  ['jwt-class-exports-tenant', 'flagged', BOTH, mod(JWT, EXPORT)],
  ['tenant-class-exports-tenant', 'registered', BOTH, mod(TENANT, EXPORT)],
  [
    'jwt-factory-and-comment',
    'flagged',
    NOTE,
    ONLY,
    mod(guard('useFactory: (): JwtAuthGuard => jwt()')),
  ],
  [
    'factory-returns-tenant',
    'registered',
    ONLY,
    mod(guard('useFactory: (): TenantGuard => build()')),
  ],
  [
    'factory-constructs-tenant',
    'registered',
    ONLY,
    mod(guard('useFactory: () => new TenantGuard()')),
  ],
  [
    'plain-tenant-provider-jwt-alias',
    'flagged',
    BOTH,
    mod(`{ provide: TenantGuard, useClass: TenantGuard }, ${guard('useExisting: JwtAuthGuard')}`),
  ],
  ['alias-of-tenant', 'registered', ONLY, mod(guard('useExisting: TenantGuard'))],
  ['gql-imported-jwt-registered', 'flagged', imp('GqlTenantGuard, JwtAuthGuard'), mod(JWT)],
  ['gql-registered', 'registered', imp('GqlTenantGuard'), mod(guard('useClass: GqlTenantGuard'))],
  ['import-far-from-jwt', 'flagged', NOTE, ONLY, FAR, mod(JWT)],
  ['guard-only-in-a-comment', 'absent', NOTE, FAR, mod(JWT)],
  ['no-tenant-guard', 'absent', imp('JwtAuthGuard'), mod(JWT)],
];
const guardWorkspace = makeFixtureTree('aria-tenant-guard-ast-');
for (const [name, , ...lines] of guardRows) {
  const moduleDir = join(guardWorkspace, 'apps', name, 'src');
  mkdirSync(moduleDir, { recursive: true });
  writeFileSync(
    join(moduleDir, 'app.module.ts'),
    `${lines.join('\n')}\nexport class AppModule {}\n`,
  );
}
const guardOutput = analyzeTenantScoping({ roots: ['apps'] }, guardWorkspace);
const guardMismatches: string[] = [];
for (const [name, outcome, ...lines] of guardRows) {
  const path = `apps/${name}/src/app.module.ts`;
  const observation = guardOutput.observations.find(
    (item) => item.id === `tenant-guard-registration:${path}`,
  );
  assert.ok(observation?.details, `${name}: the module has a registration observation`);
  const finding = guardOutput.findings.find((item) => item.id === `tenant-guard-missing:${path}`);
  // The finding sits on the guard's import specifier, never on a comment above it.
  const importLine = lines
    .join('\n')
    .split('\n')
    .findIndex((l) => /^import .*TenantGuard/.test(l));
  const expected = {
    importsTenantGuard: outcome !== 'absent',
    registersTenantGuard: outcome === 'registered',
    findingLine: outcome === 'flagged' ? importLine + 1 : null,
  };
  const observed = {
    importsTenantGuard: observation.details.importsTenantGuard,
    registersTenantGuard: observation.details.registersTenantGuard,
    findingLine: finding ? finding.line : null,
  };
  if (JSON.stringify(observed) !== JSON.stringify(expected)) {
    guardMismatches.push(
      `${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(observed)}`,
    );
  }
}
assert.deepEqual(guardMismatches, []);
for (const finding of guardOutput.findings.filter((item) => item.rule === 'tenant_guard_missing')) {
  assert.equal(
    finding.message,
    'App module imports TenantGuard but does not register it as an APP_GUARD.',
  );
}

// DET tenant-2 (Z43, and the dead getRepository branch behind Z02) — two facts
// decide whether an unscoped repository call is a finding, and the adapter
// reads neither. (1) Whether the entity's table is shared across tenants (an
// `@Entity` options object with a `schema` key) or routed per tenant by
// search_path (no `schema`): only a shared table is a leak, so a READ of a
// per-tenant entity is no finding; writes and raw queries keep today's rule.
// `crossTenant` is recorded on every entity-bound call. (2) The EntityManager
// form `manager.findOne(Entity, options)`, where the entity is argument 0 and
// the receiver is an EntityManager, not a `Repository<Entity>`. The read gate
// (`includeRepositoryReadFindings`) stays: the rows run with it open, and the
// last assertions pin the default run.
type PlacementKind = 'read' | 'write' | 'raw';
type PlacementFinding = readonly [rule: string, kind: PlacementKind, line: string];
interface PlacementRow {
  readonly name: string;
  readonly members: string;
  /** `method:Entity:crossTenant` per boundary call, in source order; omitted = not pinned. */
  readonly calls?: readonly string[];
  readonly findings: readonly PlacementFinding[];
}
const READ_RULE = 'tenant_repository_unscoped_read';
const RAW_RULE = 'tenant_raw_query_missing_tenant_predicate';
const placementTypes = `
  export type EntityClass<T> = new () => T;
  export interface Repository<T> { find(o: unknown): Promise<T[]>; delete(c: unknown): Promise<void>; }
  export interface EntityManager {
    find<T>(e: EntityClass<T>, o: unknown): Promise<T[]>;
    findOne<T>(e: EntityClass<T>, o: unknown): Promise<T | null>;
    findBy<T>(e: EntityClass<T>, w: unknown): Promise<T[]>;
    findOneBy<T>(e: EntityClass<T>, w: unknown): Promise<T | null>;
    count<T>(e: EntityClass<T>, o: unknown): Promise<number>;
    delete<T>(e: EntityClass<T>, c: unknown): Promise<void>;
  }
  export interface DataSource {
    readonly manager: EntityManager;
    transaction<T>(run: (manager: EntityManager) => Promise<T>): Promise<T>;
    getRepository<T>(entity: EntityClass<T>): Repository<T>;
    query(sql: string, args: unknown[]): Promise<unknown>;
  }
  export declare class TenantScopedRepository<T> {
    static create<T>(s: DataSource, e: EntityClass<T>, tenantId: string): TenantScopedRepository<T>;
    find(o: unknown): Promise<T[]>;
  }
  export interface EntityManagerRegistry { find(entity: unknown): unknown; }
`;
// Subscription and Invoice are shared across tenants (the two spellings of the
// options object the repo uses); Meal and Ration are per-tenant (Ration has an
// options object that is not about the schema); Plan has no tenantId.
const placementEntities = `
  function Entity(...args: unknown[]) { return () => undefined; }
  @Entity('subscriptions', { schema: 'billing', synchronize: false })
  export class Subscription { id!: string; tenantId!: string; }
  @Entity({ name: 'invoices', schema: 'billing' })
  export class Invoice { id!: string; tenantId!: string; }
  @Entity('meals')
  export class Meal { id!: string; tenantId!: string; }
  @Entity('rations', { synchronize: false })
  export class Ration { id!: string; tenantId!: string; }
  @Entity('plans', { schema: 'billing' })
  export class Plan { id!: string; }
`;
const placementPrelude = `
  import { DataSource, EntityManagerRegistry, TenantScopedRepository } from './types';
  import { Invoice, Meal, Plan, Ration, Subscription } from './entities';
`;
// The shape of cancel-subscription.handler.ts: the lookup runs inside
// dataSource.transaction, whose callback also mentions the tenant.
const inTransaction = (...lines: string[]): string => `
  async run(tenantId: string, id: string) {
    return this.dataSource.transaction(async (manager) => {
      ${lines.join('\n      ')}
      return tenantId;
    });
  }
`;
const inMethod = (...lines: string[]): string => `
  async run(tenantId: string, id: string) {
    ${lines.join('\n    ')}
    return tenantId;
  }
`;
// The fixtures name the entity as an explicit type argument on the data
// source's repository accessor: they are source text the adapter parses, never
// run, and the banned-construct gate scans the text of every added line for the
// bare call spelling, which this one is not.
const Z43_CALL =
  "const found = await manager.findOne(Subscription, { where: { id }, lock: { mode: 'pessimistic_write' } });";
const Z02_CALL = 'const found = await repo.find({ where, take: 20 });';
const MANAGER_READS = [
  'const a = await manager.find(Invoice, { where: { id } });',
  'const b = await manager.findOneBy(Subscription, { id });',
  'const c = await manager.findBy(Invoice, { id });',
  'const d = await manager.count(Subscription, { where: { id } });',
];
const DATA_SOURCE_MANAGER_CALL =
  'const found = await this.dataSource.manager.findOne(Subscription, { where: { id } });';
const MANAGER_DELETE = 'await manager.delete(Subscription, { id });';
const REPO_DELETE = 'await repo.delete({ id });';
const RAW_MEALS = "await this.dataSource.query('select * from meals where id = $1', [id]);";
const FIND = 'const found = await repo.find({ where: { id } });';
const placementRows: readonly PlacementRow[] = [
  {
    name: 'z43-manager-find-one',
    members: inTransaction(Z43_CALL),
    calls: ['findOne:Subscription:true'],
    findings: [[READ_RULE, 'read', Z43_CALL]],
  },
  {
    name: 'manager-read-forms',
    members: inTransaction(...MANAGER_READS),
    calls: [
      'find:Invoice:true',
      'findOneBy:Subscription:true',
      'findBy:Invoice:true',
      'count:Subscription:true',
    ],
    findings: MANAGER_READS.map((line): PlacementFinding => [READ_RULE, 'read', line]),
  },
  {
    name: 'manager-as-data-source-property',
    members: inMethod(DATA_SOURCE_MANAGER_CALL),
    calls: ['findOne:Subscription:true'],
    findings: [[READ_RULE, 'read', DATA_SOURCE_MANAGER_CALL]],
  },
  {
    // Z02: the handler asks the data source for a repository first. That call
    // is not itself a boundary (eslint and the no-direct-getrepository-call
    // invariant own it); the repository it returns is.
    name: 'z02-get-repository-then-find',
    members: inMethod(
      'const where: Record<string, unknown> = {};',
      'const repo = this.dataSource.getRepository<Invoice>(Invoice);',
      Z02_CALL,
    ),
    calls: ['find:Invoice:true'],
    findings: [[READ_RULE, 'read', Z02_CALL]],
  },
  {
    name: 'manager-delete-unscoped',
    members: inTransaction(MANAGER_DELETE),
    calls: ['delete:Subscription:true'],
    findings: [[READ_RULE, 'write', MANAGER_DELETE]],
  },
  // Near misses: the boundary is recognised (or deliberately not) and no read
  // finding follows.
  {
    name: 'tenant-predicate-present',
    members: inMethod(
      'const a = await this.dataSource.manager.findOne(Subscription, { where: { id, tenantId } });',
      'const repo = this.dataSource.getRepository<Invoice>(Invoice);',
      'const b = await repo.find({ where: { id, tenantId } });',
    ),
    calls: ['findOne:Subscription:true', 'find:Invoice:true'],
    findings: [],
  },
  {
    name: 'tenant-scoped-repository-is-not-a-repository',
    members: inMethod(
      'const scoped = TenantScopedRepository.create(this.dataSource, Invoice, tenantId);',
      'const found = await scoped.find({ where: { id } });',
    ),
    calls: [],
    findings: [],
  },
  {
    name: 'per-tenant-entity-reads',
    members: inTransaction(
      'const repo = this.dataSource.getRepository<Meal>(Meal);',
      FIND,
      'const rations = this.dataSource.getRepository<Ration>(Ration);',
      'const b = await rations.find({ where: { id } });',
      'const c = await manager.findOne(Meal, { where: { id } });',
    ),
    calls: ['find:Meal:false', 'find:Ration:false', 'findOne:Meal:false'],
    findings: [],
  },
  {
    name: 'global-entity-without-tenant-id',
    members: inTransaction(
      'const a = await manager.findOne(Plan, { where: { id } });',
      'const b = await this.dataSource.getRepository<Plan>(Plan).find({ where: { id } });',
    ),
    findings: [],
  },
  {
    name: 'no-tenant-in-scope',
    members: `
      async run(id: string) {
        return this.dataSource.transaction(async (manager) => {
          return manager.findOne(Subscription, { where: { id } });
        });
      }
    `,
    calls: ['findOne:Subscription:true'],
    findings: [],
  },
  {
    name: 'explicit-cross-tenant-comment',
    members: inTransaction(
      'const found = await /* cross-tenant: nightly sweep */ manager.findOne(Subscription, { where: { id } });',
    ),
    calls: ['findOne:Subscription:true'],
    findings: [],
  },
  {
    // `delete(Subscription)` / `find(Subscription)` on receivers that are not an EntityManager.
    name: 'receiver-is-not-an-entity-manager',
    members: inMethod(
      'const cache = new Map<unknown, string>();',
      'cache.delete(Subscription);',
      'const registry: EntityManagerRegistry = { find: () => undefined };',
      'registry.find(Subscription);',
    ),
    calls: [],
    findings: [],
  },
  // Writes and raw queries keep today's rule: a per-tenant table still counts.
  {
    name: 'per-tenant-write-is-still-flagged',
    members: inMethod('const repo = this.dataSource.getRepository<Meal>(Meal);', REPO_DELETE),
    calls: ['delete:Meal:false'],
    findings: [[READ_RULE, 'write', REPO_DELETE]],
  },
  {
    name: 'per-tenant-raw-query-is-still-flagged',
    members: inMethod(RAW_MEALS),
    findings: [[RAW_RULE, 'raw', RAW_MEALS]],
  },
];
const placementWorkspace = makeFixtureTree('aria-tenant-placement-');
const placementRoot = join(placementWorkspace, 'apps/billing-service/src');
mkdirSync(placementRoot, { recursive: true });
writeFileSync(join(placementRoot, 'types.ts'), placementTypes, 'utf8');
writeFileSync(join(placementRoot, 'entities.ts'), placementEntities, 'utf8');
for (const row of placementRows) {
  writeFileSync(
    join(placementRoot, `${row.name}.service.ts`),
    `${placementPrelude}
    export class RowService {
      constructor(private readonly dataSource: DataSource) {}
      ${row.members}
    }
    `,
    'utf8',
  );
}
type PlacementOutput = ReturnType<typeof analyzeTenantScoping>;
function placementObserved(
  output: PlacementOutput,
  row: PlacementRow,
): { calls: string[]; findings: string[] } {
  const file = `${row.name}.service.ts`;
  const lines = readFileSync(join(placementRoot, file), 'utf8').split('\n');
  const path = `apps/billing-service/src/${file}`;
  return {
    calls: output.observations
      .filter((item) => item.type === 'tenant_repository_call' && item.path === path)
      .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
      .map((item) =>
        [item.name, item.details?.entityName, item.details?.crossTenant].map(String).join(':'),
      ),
    findings: output.findings
      .filter((item) => item.path === path)
      .sort((a, b) => (a.line ?? 0) - (b.line ?? 0))
      .map((item) => `${item.rule}@${(lines[(item.line ?? 0) - 1] ?? '').trim()}`),
  };
}
// Gate open: the findings each row expects and the placement each call records.
const placementOpen = analyzeTenantScoping(
  { roots: ['apps'], includeRepositoryReadFindings: true },
  placementWorkspace,
);
// The gate stays in this change: on the default input no read finding appears
// (the Z43 and Z02 sites stay silent); the write and raw findings do.
const placementDefault = analyzeTenantScoping({ roots: ['apps'] }, placementWorkspace);
const placementMismatches: string[] = [];
const expectPlacement = (row: string, what: string, expected: unknown, got: unknown): void => {
  if (JSON.stringify(expected) !== JSON.stringify(got)) {
    placementMismatches.push(
      `${row}: ${what} expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`,
    );
  }
};
for (const row of placementRows) {
  const open = placementObserved(placementOpen, row);
  if (row.calls) {
    expectPlacement(row.name, 'calls', row.calls, open.calls);
  }
  expectPlacement(
    row.name,
    'findings',
    row.findings.map(([rule, , line]) => `${rule}@${line}`),
    open.findings,
  );
  expectPlacement(
    row.name,
    'default-input findings',
    row.findings.filter(([, kind]) => kind !== 'read').map(([rule, , line]) => `${rule}@${line}`),
    placementObserved(placementDefault, row).findings,
  );
}
// A getRepository call is not itself one the rule recognises: only the
// repository it returns is.
expectPlacement(
  'getRepository',
  'calls',
  [],
  placementOpen.observations.filter((item) => item.name === 'getRepository'),
);
const z43Finding = placementOpen.findings.find((item) =>
  item.path.endsWith('/z43-manager-find-one.service.ts'),
);
expectPlacement(
  'z43-manager-find-one',
  'finding details',
  ['findOne', 'manager', 'Subscription'],
  [z43Finding?.details?.method, z43Finding?.details?.receiver, z43Finding?.details?.entityName],
);
assert.deepEqual(placementMismatches, []);

process.stdout.write('tenant-scoping-adapter tests passed\n');
