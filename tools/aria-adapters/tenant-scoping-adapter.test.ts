import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { analyzeTenantScoping } from './tenant-scoping-adapter';

const workspace = mkdtempSync(join(tmpdir(), 'aria-tenant-scoping-adapter-'));
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

process.stdout.write('tenant-scoping-adapter tests passed\n');

// ARIA-LOW-593 — the analysis program was built on TypeScript's default
// compiler host (ts.sys), which reads every imported module by following
// symlinks. A factory behind a tracked symlink typed the receiver, and the
// outside signature's class name — which happens to match a WALKED entity —
// made the adapter report an unscoped read of that entity: a verdict row
// derived from content the workspace does not hold. The program must be
// built on adapter-fs's contained compiler host: nothing behind a workspace
// symlink is resolved, so a boundary that only outside content establishes
// is not reported. A REAL local factory keeps the finding — containment
// refuses the symlink, not the pattern.
{
  const base = mkdtempSync(join(tmpdir(), 'aria-tenant-scoping-link-'));
  const linkedWorkspace = join(base, 'repo');
  const outside = join(base, 'outside');
  const src = join(linkedWorkspace, 'apps/farm-service/src');
  mkdirSync(src, { recursive: true });
  mkdirSync(outside, { recursive: true });
  const factoryBody = [
    'export interface Repository<T> { findOne(input: unknown): Promise<T | null>; }',
    'export class Batch { id!: string; tenantId!: string; }',
    'export function makeRepo(): Repository<Batch> {',
    '  return { findOne: () => Promise.resolve(null) };',
    '}',
    '',
  ].join('\n');
  // The factory lives outside; the inside path naming it is a symlink, so
  // the contained walk never lists it either.
  writeFileSync(join(outside, 'factory.ts'), factoryBody, 'utf8');
  symlinkSync(join(outside, 'factory.ts'), join(src, 'linked-factory.ts'));
  // The walked entity: a DIFFERENT class that shares the outside factory's
  // return-type name.
  writeFileSync(
    join(src, 'batch.entity.ts'),
    [
      'function Entity(name: string) { return () => undefined; }',
      "@Entity('batches')",
      'export class Batch { id!: string; tenantId!: string; }',
      '',
    ].join('\n'),
    'utf8',
  );
  const serviceBody = (factory: string): string =>
    [
      `import { makeRepo } from './${factory}';`,
      'export class UnsafeService {',
      '  load(id: string, tenantId: string) {',
      '    const repo = makeRepo();',
      '    return repo.findOne({ where: { id } });',
      '  }',
      '}',
      '',
    ].join('\n');
  writeFileSync(join(src, 'unsafe.service.ts'), serviceBody('linked-factory'), 'utf8');
  writeFileSync(join(src, 'local-factory.ts'), factoryBody, 'utf8');
  writeFileSync(join(src, 'local.service.ts'), serviceBody('local-factory'), 'utf8');
  try {
    const linked = analyzeTenantScoping(
      { roots: ['apps/farm-service/src'], includeRepositoryReadFindings: true },
      linkedWorkspace,
    );
    const linkedFindings = linked.findings.filter(
      (finding) => finding.rule === 'tenant_repository_unscoped_read',
    );
    assert.equal(
      linkedFindings.some((finding) => finding.path.endsWith('unsafe.service.ts')),
      false,
      'no unscoped-read finding whose receiver type was read through a symlink',
    );
    assert.equal(
      linkedFindings.some((finding) => finding.path.endsWith('local.service.ts')),
      true,
      'a real in-workspace factory still establishes the boundary',
    );
    for (const row of linked.observations) {
      const details = row.details ?? {};
      const typeEvidence = typeof details.typeEvidence === 'string' ? details.typeEvidence : '';
      if (row.path.endsWith('unsafe.service.ts')) {
        assert.doesNotMatch(
          typeEvidence,
          /Repository</,
          `${row.id}: no type evidence for the linked factory, whose signature is not workspace content`,
        );
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

process.stdout.write('tenant-scoping-adapter containment tests passed\n');
