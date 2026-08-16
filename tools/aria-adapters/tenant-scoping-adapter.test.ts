import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
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

const output = analyzeTenantScoping({ roots: ['apps/farm-service/src'], includeRepositoryReadFindings: true }, workspace);

assert.equal(output.metadata.adapter, 'tenant-scoping-adapter');
assert.equal(output.observations.some((item) => item.type === 'tenant_source'), true);
assert.equal(output.observations.some((item) => item.type === 'tenant_repository_call'), true);
assert.equal(output.observations.some((item) => item.type === 'tenant_guard_registration'), true);
assert.equal(
  output.findings.some(
    (finding) => finding.rule === 'tenant_repository_unscoped_read' && finding.path.endsWith('unsafe.service.ts'),
  ),
  true,
);
assert.equal(
  output.findings.some(
    (finding) => finding.rule === 'tenant_raw_query_missing_tenant_predicate' && finding.path.endsWith('raw-query.service.ts'),
  ),
  true,
);
assert.equal(output.findings.some((finding) => finding.path.endsWith('/safe.service.ts')), false);
assert.equal(output.findings.some((finding) => finding.path.endsWith('safe-tenant-manager.service.ts')), false);
assert.equal(output.findings.some((finding) => finding.path.endsWith('array-find.service.ts')), false);
assert.equal(output.findings.some((finding) => finding.rule === 'tenant_guard_missing'), false);

process.stdout.write('tenant-scoping-adapter tests passed\n');
