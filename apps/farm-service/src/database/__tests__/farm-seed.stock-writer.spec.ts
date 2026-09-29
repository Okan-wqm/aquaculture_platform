/**
 * FarmSeedService — demo stock enters through THE storage-ledger sink
 * (V-B1-14 of the B1a-1 verifier round).
 *
 * The seed used to INSERT storage_inventory + stock_movements rows and UPDATE
 * feeds.quantity/status with its own status CASE: a second writer of the
 * catalog projection and a second copy of the band rule. These cases pin that
 * every demo lot is one StockMovementService.recordMovement (IN) on the seed's
 * transaction, and that the seed's SQL never writes a stock table again.
 */
import { readFileSync } from 'fs';
import * as path from 'path';

import { BypassRlsService } from '@aquaculture/backend-common/database';
import { stub } from '@aquaculture/testing';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';

import { MovementType } from '../../storage/entities/stock-movement.entity';
import { StorageItemType } from '../../storage/entities/storage-inventory.entity';
import { StockMovementService } from '../../storage/services/stock-movement.service';
import { FarmSeedService } from '../services/farm-seed.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const SITE = '22222222-2222-4222-8222-222222222222';
const DEPARTMENT = '33333333-3333-4333-8333-333333333333';
const LOCATION = '44444444-4444-4444-8444-444444444444';
const FEED_A = '55555555-5555-4555-8555-555555555555';
const FEED_B = '66666666-6666-4666-8666-666666666666';

describe('FarmSeedService demo stock (V-B1-14)', () => {
  it('books every demo lot as one ledger IN movement on the seed transaction', async () => {
    // SCENARIO: no demo stock yet, two feeds seeded. EXPECTS: one recordMovement
    // (IN, FEED, lot, expiry, idempotency key) per feed at the seed depot, on the
    // seed's own manager; no raw write to a stock table.
    const recordMovement = jest.fn().mockResolvedValue(undefined);
    const query = jest.fn();
    query.mockResolvedValueOnce([]); // no existing demo stock
    query.mockResolvedValueOnce([{ id: LOCATION }]); // the seed depot
    const manager = stub<EntityManager>({});
    const queryRunner = stub<QueryRunner>({ query, manager });
    const service = new FarmSeedService(
      stub<DataSource>({}),
      stub<BypassRlsService>({}),
      stub<StockMovementService>({ recordMovement }),
    );

    await service['seedFeedInventory'](queryRunner, TENANT, SITE, DEPARTMENT, [FEED_A, FEED_B]);

    expect(recordMovement).toHaveBeenCalledTimes(2);
    expect(recordMovement).toHaveBeenNthCalledWith(
      1,
      manager,
      expect.objectContaining({
        movementType: MovementType.IN,
        itemType: StorageItemType.FEED,
        itemId: FEED_A,
        quantity: 500,
        toLocationId: LOCATION,
        lotNumber: 'LOT-2024-001',
        idempotencyKey: 'seed-feed-LOT-2024-001',
        expiryDate: expect.any(Date),
      }),
      { tenantId: TENANT, userId: '00000000-0000-0000-0000-000000000000' },
    );
    expect(recordMovement.mock.calls[1][1]).toMatchObject({ itemId: FEED_B, quantity: 2000 });
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(
      statements.some((sql) => /stock_movements|INSERT INTO storage_inventory/.test(sql)),
    ).toBe(false);
  });

  it('keeps no raw write to a stock table or the catalog projection in the seed source', () => {
    // SCENARIO: the seed's SQL text. EXPECTS: no INSERT into storage_inventory or
    // stock_movements and no UPDATE of a catalog quantity/status — the ledger sink
    // and CatalogStockProjector are their only writers.
    const source = readFileSync(
      path.resolve(__dirname, '..', 'services', 'farm-seed.service.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/INSERT\s+INTO\s+(storage_inventory|stock_movements)/i);
    expect(source).not.toMatch(/UPDATE\s+(feeds|chemicals|consumables)\s+SET\s+(quantity|status)/i);
  });
});
