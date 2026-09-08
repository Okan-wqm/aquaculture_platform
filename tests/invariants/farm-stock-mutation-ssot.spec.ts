/**
 * INVARIANT (FARM-CRITICAL-050): stock mutations use MortalityCullPolicyService SSoT.
 *
 * Mortality, cull and cleaner-mortality must run the policy guards — batch is
 * mutable, quantity within current, aggregate within initial — BEFORE they
 * touch a stock counter. Otherwise a removal larger than the batch holds is
 * persisted and only discovered as a negative count downstream.
 *
 * This used to be asserted in two places: the three CQRS handlers, and
 * `BatchService.recordOperation` — a second write path that carried its own
 * copy of the guard chain. That path had no production caller and was deleted
 * (FARM-HIGH-109 / FARM-LOW-211), so its assertion went with it. The guarantee
 * did not: every surviving entry point is covered below, and
 * `farm-stock-mutation-central-only.spec.ts` fails the build if a bypass is
 * reintroduced.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..');

function read(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

describe('INVARIANT (FARM-CRITICAL-050): stock mutations use MortalityCullPolicyService SSoT', () => {
  const recordMortalityHandler = read(
    'apps/farm-service/src/batch/handlers/record-mortality.handler.ts',
  );
  const recordCullHandler = read('apps/farm-service/src/batch/handlers/record-cull.handler.ts');
  const recordCleanerMortalityHandler = read(
    'apps/farm-service/src/batch/handlers/record-cleaner-mortality.handler.ts',
  );

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
