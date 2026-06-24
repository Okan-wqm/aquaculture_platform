import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

function expectBefore(source: string, before: string, after: string, label: string): void {
  const beforeIndex = source.indexOf(before);
  const afterIndex = source.indexOf(after);
  expect(beforeIndex).toBeGreaterThanOrEqual(0);
  expect(afterIndex).toBeGreaterThanOrEqual(0);
  expect(beforeIndex).toBeLessThan(afterIndex);
  if (beforeIndex >= afterIndex) {
    throw new Error(`${label}: expected "${before}" before "${after}"`);
  }
}

describe('INVARIANT (FARM-CRITICAL-050): stock mutations use MortalityCullPolicyService SSoT', () => {
  const batchService = read('apps/farm-service/src/batch/services/batch.service.ts');
  const recordMortalityHandler = read(
    'apps/farm-service/src/batch/handlers/record-mortality.handler.ts',
  );
  const recordCullHandler = read('apps/farm-service/src/batch/handlers/record-cull.handler.ts');
  const recordCleanerMortalityHandler = read(
    'apps/farm-service/src/batch/handlers/record-cleaner-mortality.handler.ts',
  );

  it('guards the legacy BatchService recordOperation path before operation persistence', () => {
    expect(batchService).toMatch(/MortalityCullPolicyService/);
    expect(batchService).toMatch(/private readonly mortalityCullPolicy: MortalityCullPolicyService/);
    expect(batchService).toMatch(/private assertStockRemovalAllowed\(/);
    expect(batchService).toMatch(/assertStockMutable\(batch\)/);
    expect(batchService).toMatch(/assertQuantityWithinCurrent\(\{/);
    expect(batchService).toMatch(/assertAggregateWithinInitial\(\{/);
    expectBefore(
      batchService,
      'this.assertStockRemovalAllowed(batch, input);',
      'const operation = this.operationRepository.create',
      'BatchService.recordOperation',
    );
    expectBefore(
      batchService,
      'this.assertStockRemovalAllowed(batch, input);',
      'await this.updateBatchAfterOperation(batch, input);',
      'BatchService.recordOperation',
    );
  });

  it('guards every CQRS mortality/cull entry point before mutating stock counters', () => {
    for (const [label, source] of [
      ['record-mortality.handler.ts', recordMortalityHandler],
      ['record-cull.handler.ts', recordCullHandler],
      ['record-cleaner-mortality.handler.ts', recordCleanerMortalityHandler],
    ] as const) {
      expect(source).toMatch(/MortalityCullPolicyService/);
      expect(source).toMatch(/assertStockMutable\(/);
      expect(source).toMatch(/assertQuantityWithinCurrent\(\{/);
      expect(source).toMatch(/assertAggregateWithinInitial\(\{/);

      const firstMutation = Math.min(
        ...[
          source.indexOf('totalMortality +='),
          source.indexOf('cullCount +='),
          source.indexOf('currentQuantity -='),
          source.indexOf('cleanerFishQuantity ='),
        ].filter((index) => index >= 0),
      );
      expect(firstMutation).toBeGreaterThanOrEqual(0);
      expect(source.indexOf('assertStockMutable')).toBeLessThan(firstMutation);
      if (source.indexOf('assertStockMutable') >= firstMutation) {
        throw new Error(`${label}: stock mutation occurs before assertStockMutable`);
      }
    }
  });
});
