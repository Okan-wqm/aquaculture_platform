/**
 * Create/UpdateConsumableHandler — the catalog stock projection (FARM-HIGH-337).
 *
 * WHY: the handlers were a second writer of `consumables.quantity` / stock
 * status, and a minStock edit left the derived band stale. WHAT this pins:
 *   - neither handler writes `quantity` itself;
 *   - create calls CatalogStockProjector.project(manager, tenant, CONSUMABLE, id)
 *     AFTER its own save; update saves inside StockTierWatch (V-B1-5), which
 *     re-projects after the save — both inside the same transaction;
 *   - the returned row is the projected one.
 */
import { collaborator, createMockDataSource, stub, stubMember } from '@aquaculture/testing';
import type { Repository } from 'typeorm';

import { CreateConsumableCommand } from '../commands/create-consumable.command';
import { UpdateConsumableCommand } from '../commands/update-consumable.command';
import { Consumable, ConsumableCategory, ConsumableStatus } from '../entities/consumable.entity';
import { CreateConsumableHandler } from '../handlers/create-consumable.handler';
import { UpdateConsumableHandler } from '../handlers/update-consumable.handler';
import { FinanceSettingsService } from '../../finance/services/finance-settings.service';
import { CatalogStockProjector } from '../../storage/services/catalog-stock-projector.service';
import { StockTierWatch } from '../../storage/services/low-stock/stock-tier-watch.service';
import type { TierWatchScope } from '../../storage/services/low-stock/stock-tier-watch.service';
import { StorageItemType } from '../../storage/entities/storage-inventory.entity';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONSUMABLE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

/** An in-memory table: `findOne` by `where.id`, `save` stores a copy. */
function tableDouble<T extends { id: string }>(rows: T[], newId: string) {
  const store = new Map<string, T>(rows.map((row) => [row.id, row]));
  const save = jest.fn(async (entity: T) => {
    const row = { ...entity, id: entity.id ?? newId };
    store.set(row.id, row);
    return row;
  });
  const findOne = jest.fn(async (options: { where: { id?: unknown } }) =>
    typeof options.where.id === 'string' ? (store.get(options.where.id) ?? null) : null,
  );
  const repo = stub<Repository<T>>({
    findOne: stubMember<Repository<T>['findOne']>(findOne),
    create: stubMember<Repository<T>['create']>(jest.fn((entity: T) => entity)),
    save: stubMember<Repository<T>['save']>(save),
  });
  return { repo, save, store };
}

function harness(consumables: Consumable[]) {
  const { mockDataSource, mockManager, mockQueryRunner } = createMockDataSource();
  const table = tableDouble<Consumable>(consumables, CONSUMABLE_ID);
  mockManager.getRepository.mockImplementation(
    stubMember<typeof mockManager.getRepository>((target: unknown) =>
      target === Consumable
        ? table.repo
        : collaborator<Repository<Consumable>>({}, `Repository<${String(target)}>`),
    ),
  );
  // Stands in for the ledger: rewrites quantity + band like the projector.
  const project = jest.fn(async (_m: unknown, _t: string, _type: StorageItemType, id: string) => {
    const row = table.store.get(id);
    if (!row) return;
    row.quantity = 6;
    row.status = ConsumableStatus.LOW_STOCK;
  });
  const projector = collaborator<CatalogStockProjector>({ project }, 'CatalogStockProjector');
  // The tier-watch double runs the command, then re-projects every watched
  // item the way StockTierWatch does (its crossings are pinned in
  // storage/__tests__/stock-tier-watch.service.spec.ts).
  const around = jest.fn();
  around.mockImplementation(
    async (
      manager: unknown,
      tenantId: string,
      scope: TierWatchScope<unknown>,
      command: () => Promise<unknown>,
    ): Promise<unknown> => {
      const result = await command();
      for (const item of scope.items) await project(manager, tenantId, item.itemType, item.itemId);
      return result;
    },
  );
  const tierWatch = collaborator<StockTierWatch>({ around }, 'StockTierWatch');
  const finance = collaborator<FinanceSettingsService>(
    { getDefaultCurrency: jest.fn().mockResolvedValue('NOK') },
    'FinanceSettingsService',
  );
  return {
    create: new CreateConsumableHandler(mockDataSource, finance, projector),
    update: new UpdateConsumableHandler(mockDataSource, tierWatch),
    mockManager,
    mockQueryRunner,
    table,
    project,
    around,
  };
}

const EXISTING = stub<Consumable>({
  id: CONSUMABLE_ID,
  tenantId: TENANT,
  name: 'Nitrile Gloves',
  code: 'PPE-01',
  quantity: 6,
  minStock: 2,
  status: ConsumableStatus.AVAILABLE,
});

describe('Consumable handlers — catalog stock projection (FARM-HIGH-337)', () => {
  it('update: re-projects CONSUMABLE after a minStock change and never writes quantity', async () => {
    // SCENARIO: minStock moves 2 → 10 over 6 on hand. EXPECTS: saved quantity
    // untouched (6), project(CONSUMABLE) after the save, LOW_STOCK row returned.
    const h = harness([EXISTING]);

    const result = await h.update.execute(
      new UpdateConsumableCommand(CONSUMABLE_ID, { id: CONSUMABLE_ID, minStock: 10 }, TENANT, USER),
    );

    expect(h.table.save.mock.calls[0]![0]).toMatchObject({ minStock: 10, quantity: 6 });
    expect(h.project).toHaveBeenCalledWith(
      h.mockManager,
      TENANT,
      StorageItemType.CONSUMABLE,
      CONSUMABLE_ID,
    );
    // V-B1-5: the save runs inside StockTierWatch, scoped to this item and
    // caused by it, so a raised minStock signals its pool crossing.
    expect(h.around).toHaveBeenCalledWith(
      h.mockManager,
      TENANT,
      expect.objectContaining({
        items: [{ itemType: StorageItemType.CONSUMABLE, itemId: CONSUMABLE_ID }],
      }),
      expect.any(Function),
    );
    expect(h.around.mock.calls[0]![2].causationId(undefined)).toBe(CONSUMABLE_ID);
    expect(h.table.save.mock.invocationCallOrder[0]).toBeLessThan(
      h.project.mock.invocationCallOrder[0]!,
    );
    expect(result.status).toBe(ConsumableStatus.LOW_STOCK);
  });

  it('update: a projector failure rolls the edit back', async () => {
    // SCENARIO: the projection throws. EXPECTS: rollback, no commit — same transaction.
    const h = harness([EXISTING]);
    h.project.mockRejectedValueOnce(new Error('ledger read failed'));

    await expect(
      h.update.execute(
        new UpdateConsumableCommand(
          CONSUMABLE_ID,
          { id: CONSUMABLE_ID, status: ConsumableStatus.DISCONTINUED },
          TENANT,
          USER,
        ),
      ),
    ).rejects.toThrow('ledger read failed');
    expect(h.mockQueryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(h.mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('create: writes no quantity and projects CONSUMABLE after the save', async () => {
    // SCENARIO: a new consumable. EXPECTS: no `quantity` in the insert, then
    // project(CONSUMABLE, newId), projected row returned.
    const h = harness([]);

    const result = await h.create.execute(
      new CreateConsumableCommand(
        { name: 'Rope 12mm', code: 'rp-12', category: ConsumableCategory.ROPE, unit: 'm' },
        TENANT,
        USER,
      ),
    );

    expect(h.table.save.mock.calls[0]![0]).not.toHaveProperty('quantity');
    expect(h.project).toHaveBeenCalledWith(
      h.mockManager,
      TENANT,
      StorageItemType.CONSUMABLE,
      CONSUMABLE_ID,
    );
    expect(result).toMatchObject({ id: CONSUMABLE_ID, status: ConsumableStatus.LOW_STOCK });
  });
});
