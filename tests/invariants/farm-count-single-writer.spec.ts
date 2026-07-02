/**
 * INVARIANT: the tank fish-COUNT (Tank/Equipment.currentCount) has a SINGLE
 * writer — TankBatchService.applyBatchDelta — never an independent
 * compute-then-write inside a stock-mutation handler.
 *
 * WHY: the same physical tank stock is counted by two denormalized fields —
 * tank_batches.totalQuantity (the SSoT; mobile reads it via batchMetrics.pieces)
 * and equipment/tank.currentCount (web reads it via equipmentList.currentCount).
 * When each handler decremented currentCount itself (`newCount = current - qty`)
 * independently of tank_batches, the two drifted — the operator saw 900 on mobile
 * and 719 on web for the SAME tank (FARM-HIGH-104). The fix routes currentCount
 * through applyBatchDelta, which derives it = totalQuantity in the same
 * transaction, so the two can never diverge. This invariant fails the build if a
 * stock-mutation handler reintroduces its own currentCount write. Comments (which
 * legitimately mention the removed pattern) are stripped before scanning.
 *
 * Scope: the handlers that mutate a tank's stock and route through applyBatchDelta.
 * allocate-to-tank / create-batch derive currentCount = totalQuantity directly at
 * initial stocking (not a drift, not compute-then-write) and are intentionally not
 * in scope; their consolidation is tracked separately.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

// Stock-mutation handlers that route the count change through applyBatchDelta —
// they must NOT also write Tank/Equipment.currentCount themselves.
const SINGLE_WRITER_HANDLERS = [
  'apps/farm-service/src/batch/handlers/record-mortality.handler.ts',
  'apps/farm-service/src/batch/handlers/record-cull.handler.ts',
  'apps/farm-service/src/batch/handlers/transfer-batch.handler.ts',
  'apps/farm-service/src/harvest/handlers/create-harvest-record.handler.ts',
  'apps/farm-service/src/harvest/handlers/delete-harvest-record.handler.ts',
];

// A WRITE to currentCount: an assignment (`x.currentCount = ...`) or an object
// property in a QueryBuilder `.set({ currentCount: ... })`. A READ (`x.currentCount`
// with no following `=`/`:`) is allowed. `==`/`===` comparisons are excluded.
const CURRENT_COUNT_WRITE = /currentCount\s*[:=](?!=)/;

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '') // block + JSDoc comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1'); // line comments (not URLs)
}

describe('INVARIANT: tank fish-count has a single writer (applyBatchDelta)', () => {
  it('no stock-mutation handler writes Tank/Equipment.currentCount independently', () => {
    const violations = SINGLE_WRITER_HANDLERS.filter((rel) => {
      const content = stripComments(readFileSync(resolve(REPO_ROOT, rel), 'utf-8'));
      return CURRENT_COUNT_WRITE.test(content);
    });

    expect(violations).toEqual([]);
  });

  it('each in-scope handler routes its count change through applyBatchDelta', () => {
    const missing = SINGLE_WRITER_HANDLERS.filter((rel) => {
      const content = readFileSync(resolve(REPO_ROOT, rel), 'utf-8');
      return !/applyBatchDelta\s*\(/.test(content);
    });

    expect(missing).toEqual([]);
  });
});
