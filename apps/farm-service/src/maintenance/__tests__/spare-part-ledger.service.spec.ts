/**
 * SparePartLedgerService — every spare-part stock change goes through the ONE
 * storage ledger sink (FARM-HIGH-338). London School: the sink
 * (StockMovementService) is doubled; its own fail-closed behaviour is pinned
 * in storage/__tests__/stock-movement.service.spec.ts and the PG lane.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { stub } from '@aquaculture/testing';
import { EntityManager, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';

import { MovementType } from '../../storage/entities/stock-movement.entity';
import { StorageInventory, StorageItemType } from '../../storage/entities/storage-inventory.entity';
import { StorageLocation } from '../../storage/entities/storage-location.entity';
import { StockMovementService } from '../../storage/services/stock-movement.service';
import { StockMutationLockAuthority } from '../../storage/services/stock-mutation-lock.authority';
import { SparePart } from '../entities/spare-part.entity';
import { SparePartLedgerService } from '../services/spare-part-ledger.service';
import type { StockMovementInput } from '../dto/spare-part.dto';

const TENANT = '11111111-1111-4111-8111-111111111111';
const LOC = 'loc-1';
const OTHER_LOC = 'loc-2';
const USER = 'user-1';

function tenantMetadata<T extends ObjectLiteral>(): Repository<T>['metadata'] {
  const tenantColumn = stub<
    NonNullable<ReturnType<Repository<T>['metadata']['findColumnWithPropertyName']>>
  >({ databaseName: 'tenant_id' });
  return stub<Repository<T>['metadata']>({
    findColumnWithPropertyName: jest.fn((name: string) =>
      name === 'tenantId' ? tenantColumn : undefined,
    ),
  });
}

function part(over: Partial<SparePart> = {}): SparePart {
  return stub<SparePart>({
    id: 'part-1',
    code: 'SP-000001',
    tenantId: TENANT,
    storageLocationId: LOC,
    ...over,
  });
}

interface Row {
  storageLocationId: string;
  quantity: number;
  lotNumber?: string;
  receivedDate?: Date;
}

function harness(opts: { atLocation?: string; parts?: SparePart[]; siteRows?: Row[] } = {}): {
  ledger: SparePartLedgerService;
  manager: EntityManager;
  recordMovement: jest.Mock;
  partSave: jest.Mock;
  acquire: jest.Mock;
  order: string[];
} {
  // Shared call log: proves the lock is taken BEFORE the count baseline is read.
  const order: string[] = [];
  const recordMovement = jest.fn().mockResolvedValue({ lowStockCrossings: [] });
  const acquire = jest.fn();
  acquire.mockImplementation(async () => {
    order.push('lock');
  });
  const qb = stub<SelectQueryBuilder<StorageInventory>>({});
  qb.where = jest.fn(() => qb);
  qb.andWhere = jest.fn(() => qb);
  qb.select = jest.fn(() => qb);
  const getRawOne = jest.fn();
  getRawOne.mockImplementation(async () => {
    order.push('read');
    return { total: opts.atLocation ?? '0' };
  });
  qb.getRawOne = getRawOne;
  const partSave = jest.fn();
  partSave.mockImplementation(async (rows: unknown) => rows);
  const partCreate = jest.fn();
  partCreate.mockImplementation((rows: unknown) => rows);
  const repos = new Map<unknown, unknown>([
    [
      StorageInventory,
      stub<Repository<StorageInventory>>({
        metadata: tenantMetadata<StorageInventory>(),
        createQueryBuilder: jest.fn(() => qb),
        // The work-order draw candidates at the site (V-B1-9).
        find: jest.fn().mockResolvedValue(
          (opts.siteRows ?? []).map((row) => ({
            ...row,
            lotNumber: row.lotNumber ?? null,
            receivedDate: row.receivedDate ?? null,
            expiryDate: null,
          })),
        ),
      }),
    ],
    [
      StorageLocation,
      stub<Repository<StorageLocation>>({
        metadata: tenantMetadata<StorageLocation>(),
        // The part's home location lies at site-1.
        findOne: jest.fn().mockResolvedValue({ id: LOC, siteId: 'site-1' }),
        // The live locations of site-1.
        find: jest.fn().mockResolvedValue(
          [...new Set((opts.siteRows ?? []).map((row) => row.storageLocationId))].map((id) => ({
            id,
          })),
        ),
      }),
    ],
    [
      SparePart,
      stub<Repository<SparePart>>({
        metadata: tenantMetadata<SparePart>(),
        find: jest.fn().mockResolvedValue(opts.parts ?? []),
        save: partSave,
        create: partCreate,
      }),
    ],
  ]);
  const getRepository = jest.fn();
  getRepository.mockImplementation((entity: unknown): unknown => {
    const repo = repos.get(entity);
    if (!repo) throw new Error(`unexpected repository ${String(entity)}`);
    return repo;
  });
  const ledger = new SparePartLedgerService(
    stub<StockMovementService>({ recordMovement }),
    stub<StockMutationLockAuthority>({ acquire }),
  );
  return {
    ledger,
    manager: stub<EntityManager>({ getRepository }),
    recordMovement,
    partSave,
    acquire,
    order,
  };
}

const actor = { userId: USER };
const movement = (over: Partial<StockMovementInput>): StockMovementInput => ({
  sparePartId: 'part-1',
  quantity: 3,
  movementType: 'in',
  ...over,
});

describe('SparePartLedgerService — every writer produces a ledger movement', () => {
  it('books an opening balance as one IN movement at the part location', async () => {
    // SCENARIO: part registered with 5 on hand. EXPECTS: IN 5 → LOC, item type spare_part.
    const { ledger, manager, recordMovement } = harness();
    await ledger.recordOpeningBalance(manager, TENANT, part(), 5, actor);

    expect(recordMovement).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        movementType: MovementType.IN,
        itemType: StorageItemType.SPARE_PART,
        itemId: 'part-1',
        quantity: 5,
        toLocationId: LOC,
        reference: 'Opening balance',
      }),
      { tenantId: TENANT, userId: USER, siteAuthorization: undefined },
    );
  });

  it('records in and out at the part location, or at an explicit location', async () => {
    // SCENARIO: IN 3 at the home location; OUT 2 at OTHER_LOC. EXPECTS: two movements, dates stamped.
    const { ledger, manager, recordMovement } = harness();
    const sparePart = part();
    await ledger.recordMovement(
      manager,
      TENANT,
      sparePart,
      movement({ movementType: 'in' }),
      actor,
    );
    await ledger.recordMovement(
      manager,
      TENANT,
      sparePart,
      movement({
        movementType: 'out',
        quantity: 2,
        storageLocationId: OTHER_LOC,
        workOrderId: 'wo-9',
      }),
      actor,
    );

    expect(recordMovement.mock.calls[0][1]).toMatchObject({
      movementType: MovementType.IN,
      quantity: 3,
      toLocationId: LOC,
    });
    expect(recordMovement.mock.calls[1][1]).toMatchObject({
      movementType: MovementType.OUT,
      quantity: 2,
      fromLocationId: OTHER_LOC,
      reference: 'WO:wo-9',
    });
    expect(sparePart.lastOrderDate).toBeInstanceOf(Date);
    expect(sparePart.lastUsedDate).toBeInstanceOf(Date);
  });

  it('relocates stock as ONE ledger TRANSFER movement with the operator site scope', async () => {
    // SCENARIO: a manager moves 2 of part-1 from its home LOC to OTHER_LOC through the
    // spare-part door (transferStock refuses SPARE_PART). EXPECTS: one TRANSFER movement,
    // both legs named, the operator's site scope handed to the sink (it checks both legs).
    const { ledger, manager, recordMovement } = harness();
    const siteAuthorization = { sub: USER, roles: [], assignedSiteIds: ['site-1'] };
    await ledger.recordMovement(
      manager,
      TENANT,
      part(),
      movement({ movementType: 'transfer', quantity: 2, toStorageLocationId: OTHER_LOC }),
      { userId: USER, siteAuthorization },
    );

    expect(recordMovement).toHaveBeenCalledTimes(1);
    expect(recordMovement).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        movementType: MovementType.TRANSFER,
        itemType: StorageItemType.SPARE_PART,
        quantity: 2,
        fromLocationId: LOC,
        toLocationId: OTHER_LOC,
      }),
      { tenantId: TENANT, userId: USER, siteAuthorization },
    );
  });

  it('refuses a transfer without a destination or quantity', async () => {
    // SCENARIO: transfer with no toStorageLocationId; transfer of 0. EXPECTS: 400, no movement.
    const { ledger, manager, recordMovement } = harness();
    await expect(
      ledger.recordMovement(manager, TENANT, part(), movement({ movementType: 'transfer' }), actor),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      ledger.recordMovement(
        manager,
        TENANT,
        part(),
        movement({ movementType: 'transfer', quantity: 0, toStorageLocationId: OTHER_LOC }),
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('turns a counted adjustment into the signed difference at that location', async () => {
    // SCENARIO: 4 on the shelf, counted 7 → +3 IN side; counted 1 → −3 OUT side; counted 4 → nothing.
    // EXPECTS: the signed difference, with the baseline read under the item lock.
    const up = harness({ atLocation: '4' });
    await up.ledger.recordMovement(
      up.manager,
      TENANT,
      part(),
      movement({ movementType: 'adjustment', quantity: 7 }),
      actor,
    );
    expect(up.recordMovement.mock.calls[0][1]).toMatchObject({
      movementType: MovementType.ADJUSTMENT,
      quantity: 3,
      toLocationId: LOC,
    });

    const down = harness({ atLocation: '4' });
    await down.ledger.recordMovement(
      down.manager,
      TENANT,
      part(),
      movement({ movementType: 'adjustment', quantity: 1 }),
      actor,
    );
    expect(down.recordMovement.mock.calls[0][1]).toMatchObject({
      movementType: MovementType.ADJUSTMENT,
      quantity: 3,
      fromLocationId: LOC,
    });

    // The baseline is read under the item lock, never before it.
    expect(down.acquire).toHaveBeenCalledWith(down.manager, TENANT, [
      { itemType: StorageItemType.SPARE_PART, itemId: 'part-1' },
    ]);
    expect(down.order).toEqual(['lock', 'read']);

    const same = harness({ atLocation: '4' });
    await same.ledger.recordMovement(
      same.manager,
      TENANT,
      part(),
      movement({ movementType: 'adjustment', quantity: 4 }),
      actor,
    );
    expect(same.recordMovement).not.toHaveBeenCalled();
  });

  it('receives a bulk delivery as one IN per item', async () => {
    // SCENARIO: two parts received. EXPECTS: two IN movements at each part's location.
    const { ledger, manager, recordMovement } = harness();
    const parts = [part(), part({ id: 'part-2', storageLocationId: OTHER_LOC })];
    await ledger.receiveMany(
      manager,
      TENANT,
      parts,
      [
        { sparePartId: 'part-1', quantity: 4 },
        { sparePartId: 'part-2', quantity: 6, notes: 'box damaged' },
      ],
      'PO-17',
      actor,
    );

    expect(recordMovement.mock.calls.map((call) => call[1])).toEqual([
      expect.objectContaining({
        itemId: 'part-1',
        quantity: 4,
        toLocationId: LOC,
        reason: 'PO-17',
      }),
      expect.objectContaining({
        itemId: 'part-2',
        quantity: 6,
        toLocationId: OTHER_LOC,
        reason: 'PO-17 — box damaged',
      }),
    ]);
  });

  it('consumes work-order materials as OUT movements, without the operator site gate', async () => {
    // SCENARIO: WO uses 2 of part-1, the home holds 4. EXPECTS: OUT 2 from LOC,
    // reference WO:<id>, ctx has no siteAuthorization, the part lock taken, part saved.
    const { ledger, manager, recordMovement, partSave, acquire } = harness({
      parts: [part()],
      siteRows: [{ storageLocationId: LOC, quantity: 4 }],
    });
    await ledger.consumeForWorkOrder(
      manager,
      TENANT,
      { id: 'wo-1' },
      [{ sparePartId: 'part-1', quantity: 2 }],
      USER,
    );

    expect(acquire).toHaveBeenCalledWith(manager, TENANT, [
      { itemType: StorageItemType.SPARE_PART, itemId: 'part-1' },
    ]);
    expect(recordMovement).toHaveBeenCalledWith(
      manager,
      expect.objectContaining({
        movementType: MovementType.OUT,
        quantity: 2,
        fromLocationId: LOC,
        reference: 'WO:wo-1',
      }),
      { tenantId: TENANT, userId: USER },
    );
    expect(partSave).toHaveBeenCalled();
  });

  it('draws across the site: home location first, then the oldest received store (V-B1-9)', async () => {
    // SCENARIO: the home LOC holds 2, OTHER_LOC 5 (received in January), a third
    // store 5 (received in February), all at the part's site; the WO uses 8.
    // EXPECTS: three OUT slices — 2 from home, 5 from OTHER_LOC, 1 from the third.
    const { ledger, manager, recordMovement } = harness({
      parts: [part()],
      siteRows: [
        { storageLocationId: 'loc-3', quantity: 5, receivedDate: new Date('2026-02-01') },
        { storageLocationId: OTHER_LOC, quantity: 5, receivedDate: new Date('2026-01-01') },
        { storageLocationId: LOC, quantity: 2, receivedDate: new Date('2026-03-01') },
      ],
    });

    await ledger.consumeForWorkOrder(
      manager,
      TENANT,
      { id: 'wo-1' },
      [{ sparePartId: 'part-1', quantity: 8 }],
      USER,
    );

    expect(
      recordMovement.mock.calls.map(([, input]) => [input.fromLocationId, input.quantity]),
    ).toEqual([
      [LOC, 2],
      [OTHER_LOC, 5],
      ['loc-3', 1],
    ]);
  });

  it('fails only when the whole site holds too little, before any movement', async () => {
    // SCENARIO: the site holds 1 + 2 = 3; the WO uses 4. EXPECTS: 400 naming the
    // site total, no movement booked (the completion rolls back).
    const { ledger, manager, recordMovement } = harness({
      parts: [part()],
      siteRows: [
        { storageLocationId: LOC, quantity: 1 },
        { storageLocationId: OTHER_LOC, quantity: 2 },
      ],
    });

    await expect(
      ledger.consumeForWorkOrder(
        manager,
        TENANT,
        { id: 'wo-1' },
        [{ sparePartId: 'part-1', quantity: 4 }],
        USER,
      ),
    ).rejects.toThrow('Available: 3, requested: 4');
    expect(recordMovement).not.toHaveBeenCalled();
  });
});

describe('SparePartLedgerService — fail-closed', () => {
  it('propagates the sink refusal on insufficient stock (no clamping to zero)', async () => {
    // SCENARIO: the sink rejects an OUT larger than the shelf. EXPECTS: the error surfaces, so the
    // caller's transaction (work-order completion) rolls back.
    const { ledger, manager, recordMovement } = harness({
      parts: [part()],
      siteRows: [{ storageLocationId: LOC, quantity: 2 }],
    });
    recordMovement.mockRejectedValueOnce(
      new BadRequestException('Insufficient stock. Available: 1 piece, Requested: 2 piece'),
    );

    await expect(
      ledger.consumeForWorkOrder(
        manager,
        TENANT,
        { id: 'wo-1' },
        [{ sparePartId: 'part-1', quantity: 2 }],
        USER,
      ),
    ).rejects.toThrow('Insufficient stock');
  });

  it('refuses to move stock of a part that has no storage location', async () => {
    // SCENARIO: part without storageLocationId and no explicit location. EXPECTS: 400, no movement.
    const { ledger, manager, recordMovement } = harness();
    await expect(
      ledger.recordMovement(
        manager,
        TENANT,
        part({ storageLocationId: undefined }),
        movement({}),
        actor,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(recordMovement).not.toHaveBeenCalled();
  });

  it('refuses a zero-quantity in/out and an unknown work-order material', async () => {
    // SCENARIO: IN 0; WO material id not in this tenant. EXPECTS: 400; 404.
    const { ledger, manager } = harness({ parts: [] });
    await expect(
      ledger.recordMovement(manager, TENANT, part(), movement({ quantity: 0 }), actor),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      ledger.consumeForWorkOrder(
        manager,
        TENANT,
        { id: 'wo-1' },
        [{ sparePartId: 'ghost', quantity: 1 }],
        USER,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SparePartLedgerService.assertRelocatable — stock never stranded by a re-home', () => {
  it('refuses to move the home while stock still sits there, reading under the item lock', async () => {
    // SCENARIO: 4 on hand at the current home LOC; the manager re-points it to OTHER_LOC.
    // EXPECTS: BadRequest (transfer first), the baseline read taken after the item lock.
    const { ledger, manager, acquire, order } = harness({ atLocation: '4' });
    await expect(ledger.assertRelocatable(manager, TENANT, part(), OTHER_LOC)).rejects.toThrow(
      /transfer that stock \(spare-part movement type "transfer"\) before changing the location/,
    );
    expect(acquire).toHaveBeenCalledWith(manager, TENANT, [
      { itemType: StorageItemType.SPARE_PART, itemId: 'part-1' },
    ]);
    expect(order).toEqual(['lock', 'read']);
  });

  it('allows the re-home of an empty home, a first home and a no-op', async () => {
    // SCENARIO: home empty; part without a home; same home again.
    // EXPECTS: all resolve; the last two read nothing at all.
    const empty = harness({ atLocation: '0' });
    await expect(
      empty.ledger.assertRelocatable(empty.manager, TENANT, part(), null),
    ).resolves.toBeUndefined();

    const first = harness({ atLocation: '9' });
    await first.ledger.assertRelocatable(
      first.manager,
      TENANT,
      part({ storageLocationId: null }),
      OTHER_LOC,
    );
    const same = harness({ atLocation: '9' });
    await same.ledger.assertRelocatable(same.manager, TENANT, part(), LOC);
    expect(first.order).toEqual([]);
    expect(same.order).toEqual([]);
  });
});
