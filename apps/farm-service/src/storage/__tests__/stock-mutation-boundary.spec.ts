import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(__dirname, '..', '..', '..', '..', '..');

const read = (relativePath: string): string =>
  readFileSync(resolve(repoRoot, relativePath), 'utf8');

describe('stock mutation authority boundary', () => {
  it.each([
    'apps/farm-service/src/storage/handlers/transfer-stock.handler.ts',
    'apps/farm-service/src/storage/handlers/approve-inventory-count.handler.ts',
  ])('%s delegates physical changes without owning projection or movement repositories', (path) => {
    const source = read(path);
    expect(source).toContain('stockMovementService.recordMovement(');
    expect(source).not.toMatch(/tenantManagerRepo\([^,]+,\s*StorageInventory/);
    expect(source).not.toMatch(/tenantManagerRepo\([^,]+,\s*StockMovement/);
    expect(source).not.toMatch(/inventoryRepo\.(save|remove|update|delete)\(/);
    expect(source).not.toMatch(/movementRepo\.(save|remove|update|delete)\(/);
  });

  it('keeps FEFO qualification and mutation in one public authority operation', () => {
    const source = read('apps/farm-service/src/storage/services/stock-movement.service.ts');
    expect(source).toContain('async recordFeedDeduction(');
    expect(source).not.toContain('async resolveFeedDeductionLocation(');
    expect(source).not.toContain('async feedHasStoragePresence(');
  });

  it('uses the immutable count-item identity without exceeding the movement key schema', () => {
    const source = read(
      'apps/farm-service/src/storage/handlers/approve-inventory-count.handler.ts',
    );
    expect(source).toContain('idempotencyKey: `inventory-count:${item.id}`');
    expect(`inventory-count:${'0'.repeat(36)}`).toHaveLength(52);
  });
});
