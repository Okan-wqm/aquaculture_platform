/**
 * SparePartService.update — re-homing a part goes through the ledger's
 * relocation rule (FARM-HIGH-338): the home (`storageLocationId`) is where
 * every later movement defaults to, so it cannot move away from stock.
 */
import { BadRequestException } from '@nestjs/common';
import { createMockDataSource, stub } from '@aquaculture/testing';
import type { Repository } from 'typeorm';

import { SparePart } from '../entities/spare-part.entity';
import { SparePartLedgerService } from '../services/spare-part-ledger.service';
import { SparePartService } from '../services/spare-part.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const HOME = '22222222-2222-4222-8222-222222222222';
const NEXT = '33333333-3333-4333-8333-333333333333';

function harness(relocatable: boolean): {
  service: SparePartService;
  assertRelocatable: jest.Mock;
  assertLocation: jest.Mock;
  save: jest.Mock;
} {
  const { mockDataSource, mockManager } = createMockDataSource();
  const part = stub<SparePart>({
    id: 'part-1',
    code: 'SP-1',
    tenantId: TENANT,
    storageLocationId: HOME,
  });
  const save = jest.fn();
  save.mockImplementation(async (row: SparePart) => row);
  const create = jest.fn();
  create.mockImplementation((row: SparePart) => row);
  const repo = stub<Repository<SparePart>>({
    findOne: jest.fn().mockResolvedValue(part),
    save,
    create,
  });
  (mockManager.getRepository as jest.Mock).mockImplementation((entity: unknown): unknown => {
    if (entity !== SparePart) throw new Error(`unexpected repository ${String(entity)}`);
    return repo;
  });
  const assertLocation = jest.fn().mockResolvedValue(undefined);
  const assertRelocatable = jest.fn();
  assertRelocatable.mockImplementation(async () => {
    if (!relocatable)
      throw new BadRequestException('transfer that stock before changing the location');
  });
  const service = new SparePartService(
    mockDataSource,
    stub<SparePartLedgerService>({ assertLocation, assertRelocatable }),
  );
  return { service, assertRelocatable, assertLocation, save };
}

describe('SparePartService.update — relocation', () => {
  it('asks the ledger before re-homing, and re-homes when the old home is empty', async () => {
    // SCENARIO: re-home to NEXT, old home empty. EXPECTS: location validated,
    // relocation checked against NEXT, part saved with the new home.
    const { service, assertLocation, assertRelocatable, save } = harness(true);
    await service.update(TENANT, { id: 'part-1', storageLocationId: NEXT }, 'user-1');

    expect(assertLocation).toHaveBeenCalledWith(expect.anything(), TENANT, NEXT);
    expect(assertRelocatable).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      expect.objectContaining({ id: 'part-1' }),
      NEXT,
    );
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ storageLocationId: NEXT }));
  });

  it('refuses to re-home (or clear the home) while stock still sits there', async () => {
    // SCENARIO: old home holds stock; re-home to NEXT, then clear the home.
    // EXPECTS: both rejected by the ledger rule, nothing saved.
    const moved = harness(false);
    await expect(
      moved.service.update(TENANT, { id: 'part-1', storageLocationId: NEXT }, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(moved.save).not.toHaveBeenCalled();

    const cleared = harness(false);
    await expect(
      cleared.service.update(TENANT, { id: 'part-1', storageLocationId: null }, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(cleared.assertRelocatable).toHaveBeenCalledWith(
      expect.anything(),
      TENANT,
      expect.objectContaining({ id: 'part-1' }),
      null,
    );
    expect(cleared.save).not.toHaveBeenCalled();
  });
});
