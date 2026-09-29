/**
 * Create/UpdateChemicalHandler — the catalog stock projection (FARM-HIGH-337).
 *
 * WHY: the handlers were a second writer of `chemicals.quantity` / stock
 * status, and a minStock edit left the derived band stale. WHAT this pins:
 *   - neither handler writes `quantity` itself;
 *   - both call CatalogStockProjector.project(manager, tenant, CHEMICAL, id)
 *     AFTER their own save, inside the same transaction;
 *   - the returned row is the projected one.
 */
import { collaborator, createMockDataSource, stub, stubMember } from '@aquaculture/testing';
import type { Repository } from 'typeorm';

import { CreateChemicalCommand } from '../../commands/create-chemical.command';
import { UpdateChemicalCommand } from '../../commands/update-chemical.command';
import { Chemical, ChemicalStatus, ChemicalType } from '../../entities/chemical.entity';
import { ChemicalSite } from '../../entities/chemical-site.entity';
import { CreateChemicalHandler } from '../../handlers/create-chemical.handler';
import { UpdateChemicalHandler } from '../../handlers/update-chemical.handler';
import { Site } from '../../../site/entities/site.entity';
import { FinanceSettingsService } from '../../../finance/services/finance-settings.service';
import { CatalogStockProjector } from '../../../storage/services/catalog-stock-projector.service';
import { StorageItemType } from '../../../storage/entities/storage-inventory.entity';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CHEMICAL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SITE_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

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

function harness(chemicals: Chemical[]) {
  const { mockDataSource, mockManager, mockQueryRunner } = createMockDataSource();
  const chemicalTable = tableDouble<Chemical>(chemicals, CHEMICAL_ID);
  const chemicalSiteTable = tableDouble<ChemicalSite>([], 'chemical-site-1');
  const siteTable = tableDouble<Site>(
    [stub<Site>({ id: SITE_ID, tenantId: TENANT, isDeleted: false })],
    SITE_ID,
  );
  const repos = new Map<unknown, unknown>([
    [Chemical, chemicalTable.repo],
    [ChemicalSite, chemicalSiteTable.repo],
    [Site, siteTable.repo],
  ]);
  mockManager.getRepository.mockImplementation(
    stubMember<typeof mockManager.getRepository>(
      (target: unknown) =>
        repos.get(target) ??
        collaborator<Repository<Chemical>>({}, `Repository<${String(target)}>`),
    ),
  );
  // Stands in for the ledger: rewrites quantity + band like the projector.
  const project = jest.fn(async (_m: unknown, _t: string, _type: StorageItemType, id: string) => {
    const row = chemicalTable.store.get(id);
    if (!row) return;
    row.quantity = 0;
    row.status = ChemicalStatus.OUT_OF_STOCK;
  });
  const projector = collaborator<CatalogStockProjector>({ project }, 'CatalogStockProjector');
  const finance = collaborator<FinanceSettingsService>(
    { getDefaultCurrency: jest.fn().mockResolvedValue('NOK') },
    'FinanceSettingsService',
  );
  return {
    create: new CreateChemicalHandler(mockDataSource, finance, projector),
    update: new UpdateChemicalHandler(mockDataSource, projector),
    mockManager,
    mockQueryRunner,
    chemicalTable,
    chemicalSiteTable,
    project,
  };
}

const EXISTING = stub<Chemical>({
  id: CHEMICAL_ID,
  tenantId: TENANT,
  name: 'Hydrogen Peroxide',
  code: 'H2O2-01',
  quantity: 12,
  minStock: 5,
  status: ChemicalStatus.AVAILABLE,
});

describe('Chemical handlers — catalog stock projection (FARM-HIGH-337)', () => {
  it('update: re-projects CHEMICAL after a minStock change and never writes quantity', async () => {
    // SCENARIO: minStock moves 5 → 30. EXPECTS: saved quantity untouched (12),
    // project(CHEMICAL) after the save, projected row returned.
    const h = harness([EXISTING]);

    const result = await h.update.execute(
      new UpdateChemicalCommand(CHEMICAL_ID, { id: CHEMICAL_ID, minStock: 30 }, TENANT, USER),
    );

    const saved = h.chemicalTable.save.mock.calls[0]![0];
    expect(saved).toMatchObject({ minStock: 30, quantity: 12 });
    expect(h.project).toHaveBeenCalledWith(
      h.mockManager,
      TENANT,
      StorageItemType.CHEMICAL,
      CHEMICAL_ID,
    );
    expect(h.chemicalTable.save.mock.invocationCallOrder[0]).toBeLessThan(
      h.project.mock.invocationCallOrder[0]!,
    );
    expect(result.status).toBe(ChemicalStatus.OUT_OF_STOCK);
  });

  it('update: a projector failure rolls the edit back', async () => {
    // SCENARIO: the projection throws. EXPECTS: rollback, no commit — same transaction.
    const h = harness([EXISTING]);
    h.project.mockRejectedValueOnce(new Error('ledger read failed'));

    await expect(
      h.update.execute(
        new UpdateChemicalCommand(
          CHEMICAL_ID,
          { id: CHEMICAL_ID, status: ChemicalStatus.EXPIRED },
          TENANT,
          USER,
        ),
      ),
    ).rejects.toThrow('ledger read failed');
    expect(h.mockQueryRunner.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(h.mockQueryRunner.commitTransaction).not.toHaveBeenCalled();
  });

  it('create: writes no quantity and projects CHEMICAL after the catalog rows', async () => {
    // SCENARIO: a new chemical. EXPECTS: no `quantity` in the insert, then
    // project(CHEMICAL, newId) after the chemical-site save, projected row returned.
    const h = harness([]);

    const result = await h.create.execute(
      new CreateChemicalCommand(
        {
          name: 'Formalin',
          code: 'fm-01',
          type: ChemicalType.TREATMENT,
          unit: 'L',
          siteId: SITE_ID,
        },
        TENANT,
        USER,
      ),
    );

    expect(h.chemicalTable.save.mock.calls[0]![0]).not.toHaveProperty('quantity');
    expect(h.project).toHaveBeenCalledWith(
      h.mockManager,
      TENANT,
      StorageItemType.CHEMICAL,
      CHEMICAL_ID,
    );
    expect(h.chemicalSiteTable.save.mock.invocationCallOrder[0]).toBeLessThan(
      h.project.mock.invocationCallOrder[0]!,
    );
    expect(result).toMatchObject({ id: CHEMICAL_ID, status: ChemicalStatus.OUT_OF_STOCK });
  });
});
