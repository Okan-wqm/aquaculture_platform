import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

const paths = {
  updateStatusHandler: 'apps/farm-service/src/batch/handlers/update-batch-status.handler.ts',
  closeBatchHandler: 'apps/farm-service/src/batch/handlers/close-batch.handler.ts',
  deleteBatchHandler: 'apps/farm-service/src/batch/handlers/delete-batch.handler.ts',
  recordMortalityHandler: 'apps/farm-service/src/batch/handlers/record-mortality.handler.ts',
  recordCullHandler: 'apps/farm-service/src/batch/handlers/record-cull.handler.ts',
  lifecyclePolicy: 'apps/farm-service/src/batch/services/batch-lifecycle-policy.service.ts',
  mortalityCullPolicy: 'apps/farm-service/src/batch/services/mortality-cull-policy.service.ts',
  batchDomainService: 'apps/farm-service/src/batch/services/batch-domain.service.ts',
};

const rawBatchFindOneHandlers = [
  'apps/farm-service/src/batch/handlers/allocate-to-tank.handler.ts',
  'apps/farm-service/src/batch/handlers/record-cull.handler.ts',
  'apps/farm-service/src/batch/handlers/record-mortality.handler.ts',
  'apps/farm-service/src/batch/handlers/transfer-batch.handler.ts',
  'apps/farm-service/src/batch/handlers/update-batch.handler.ts',
];

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

function findOneCalls(source: string): string[] {
  const calls: string[] = [];
  let index = 0;
  while ((index = source.indexOf('findOne(', index)) !== -1) {
    let depth = 0;
    let end = index;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (char === '(') depth += 1;
      if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    calls.push(source.slice(index, end));
    index = end;
  }
  return calls;
}

function batchHandlerPaths(): string[] {
  const dir = resolve(REPO_ROOT, 'apps/farm-service/src/batch/handlers');
  return readdirSync(dir)
    .filter((file) => file.endsWith('.handler.ts'))
    .map((file) => `apps/farm-service/src/batch/handlers/${file}`);
}

describe('INVARIANT: farm batch lifecycle and transaction SSOT', () => {
  const updateStatusSource = read(paths.updateStatusHandler);
  const closeBatchSource = read(paths.closeBatchHandler);
  const deleteBatchSource = read(paths.deleteBatchHandler);
  const recordMortalitySource = read(paths.recordMortalityHandler);
  const recordCullSource = read(paths.recordCullHandler);
  const lifecyclePolicySource = read(paths.lifecyclePolicy);
  const mortalityCullPolicySource = read(paths.mortalityCullPolicy);
  const batchDomainServiceSource = read(paths.batchDomainService);

  it('keeps batch lifecycle rules in BatchLifecyclePolicyService', () => {
    expect(lifecyclePolicySource).toMatch(/class BatchLifecyclePolicyService/);
    expect(lifecyclePolicySource).toMatch(/statusTransitions/);
    expect(lifecyclePolicySource).toMatch(/closeReasonPreviousStatuses/);
    expect(lifecyclePolicySource).toMatch(/assertCanTransitionStatus/);
    expect(lifecyclePolicySource).toMatch(/assertCanCloseForReason/);

    expect(updateStatusSource).toMatch(/BatchLifecyclePolicyService/);
    expect(updateStatusSource).toMatch(/assertCanTransitionStatus/);
    expect(updateStatusSource).not.toMatch(/\.canTransitionTo\(/);

    expect(closeBatchSource).toMatch(/BatchLifecyclePolicyService/);
    expect(closeBatchSource).toMatch(/assertCanCloseForReason/);
    expect(closeBatchSource).not.toMatch(/allowedPreviousStatuses/);

    expect(batchDomainServiceSource).toMatch(/BatchLifecyclePolicyService/);
    expect(batchDomainServiceSource).toMatch(/canTransitionStatus/);
    expect(batchDomainServiceSource).not.toMatch(/validTransitions/);
  });

  it('keeps mortality/cull quantity rules in MortalityCullPolicyService', () => {
    expect(mortalityCullPolicySource).toMatch(/class MortalityCullPolicyService/);
    expect(mortalityCullPolicySource).toMatch(/assertQuantityWithinCurrent/);

    for (const source of [recordMortalitySource, recordCullSource]) {
      expect(source).toMatch(/MortalityCullPolicyService/);
      expect(source).toMatch(/assertQuantityWithinCurrent/);
      expect(source).not.toMatch(/payload\.quantity\s*>\s*batch\.currentQuantity/);
    }
  });

  it('uses canonical tenant transaction and tenant repository helpers for status/close/delete writes', () => {
    for (const source of [updateStatusSource, closeBatchSource, deleteBatchSource]) {
      expect(source).toMatch(/runInTenantTransaction\(this\.dataSource, 'farm', tenantId/);
      expect(source).toMatch(/tenantManagerRepo\(queryRunner\.manager, Batch, tenantId\)/);
      expect(source).not.toMatch(/this\.dataSource\.createQueryRunner\(/);
      expect(source).not.toMatch(/queryRunner\.manager\.findOne\(Batch/);
      expect(source).not.toMatch(/queryRunner\.manager\.save\(Batch/);
    }
  });

  it('keeps remaining raw Batch findOne calls explicitly tenant-scoped until migrated', () => {
    for (const path of rawBatchFindOneHandlers) {
      const source = read(path);
      const calls = source.match(new RegExp('queryRunner\\.manager\\.findOne\\(Batch,[\\s\\S]*?\\n\\s*\\}\\);', 'g')) ?? [];
      for (const call of calls) {
        expect(call).toMatch(/where:\s*\{[\s\S]*tenantId/);
      }
    }
  });


  it('keeps every batch handler findOne where-clause tenant scoped', () => {
    const missingTenantScope: string[] = [];
    for (const path of batchHandlerPaths()) {
      for (const call of findOneCalls(read(path))) {
        if (call.includes('where:') && !/where:\s*\{[\s\S]*tenantId/.test(call)) {
          missingTenantScope.push(`${path}: ${call.replace(/\s+/g, ' ').slice(0, 180)}`);
        }
      }
    }
    expect(missingTenantScope).toEqual([]);
  });

  it('routes mortality/cull writes through the canonical fail-closed tenant transaction boundary', () => {
    for (const source of [recordMortalitySource, recordCullSource]) {
      // FARM-HIGH-060: mortality/cull are now migrated off the raw
      // `this.dataSource.createQueryRunner()` path onto the asserting boundary.
      // runInTenantTransaction sets AND verifies search_path + the RLS GUC
      // against the expected tenant schema before any write, so a stale pooled
      // session or missing AsyncLocalStorage frame cannot write source-schema data.
      expect(source).toMatch(/runInTenantTransaction\(this\.dataSource, 'farm', tenantId/);
      expect(source).not.toMatch(/this\.dataSource\.createQueryRunner\(/);
      // Defense-in-depth: every Batch read still carries tenantId in its where
      // clause (ORM-level isolation beneath the schema route).
      expect(source).toMatch(/where:\s*\{[\s\S]*tenantId/);
      // Outbox row is enqueued through the transactional manager so it commits
      // or rolls back atomically with the domain writes.
      expect(source).toMatch(/outboxPublisher\.enqueue\([\s\S]*queryRunner\.manager/);
    }
  });
});
