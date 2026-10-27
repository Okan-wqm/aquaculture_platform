import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeFixtureTree } from '../gates/fixture-tree';

import { analyzeTenantScoping } from './tenant-scoping-adapter';

const workspace = makeFixtureTree('aria-tenant-scoping-adapter-');
const root = join(workspace, 'apps/farm-service/src');
mkdirSync(root, { recursive: true });

writeFileSync(
  join(root, 'batch.entity.ts'),
  `
    function Entity(name: string) { return () => undefined; }
    @Entity('batches')
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

process.stdout.write('tenant-scoping-adapter tests passed\n');
