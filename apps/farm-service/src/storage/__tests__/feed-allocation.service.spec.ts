/**
 * FeedAllocationService pinleri (FARM-CRITICAL-245).
 *
 * Denetimin C-2 senaryosu: sitede F yemi iki satırda — LOT-A 0.3 kg artık,
 * LOT-B 3000 kg. Operatör 150 kg'lık öğünü kaydeder. Eski yol FEFO sırasında
 * LOT-A'yı seçip (istenen miktarla KIYAS YAPMADAN) tüm tenant transaction'ını
 * "Insufficient stock. Available: 0.3 kg" ile geri alıyordu; mobil çevrimdışıda
 * kuyruk 5 denemede kalıcı `failed` olduğu için öğün kalıcı kayboluyordu.
 *
 * Yeni model: yetersizlik kararı SATIRDAN değil HAVUZ TOPLAMINDAN verilir ve
 * düşüm FEFO sırayla birden çok lota kaskad eder.
 */
import { EntityManager } from 'typeorm';

import {
  FeedAllocationService,
  InsufficientFeedStockError,
} from '../services/feed-allocation.service';
import { StorageInventory } from '../entities/storage-inventory.entity';
import { StorageLocation } from '../entities/storage-location.entity';
import { stub } from '@aquaculture/testing';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FEED = '22222222-2222-4222-8222-222222222222';
const SITE_A = '33333333-3333-4333-8333-333333333333';
const SITE_B = '44444444-4444-4444-8444-444444444444';

interface Row {
  id: string;
  storageLocationId: string;
  lotNumber?: string;
  quantity: number;
  /** Entity alanı `Date | undefined` — fixture da aynı şekli kullanır. */
  expiryDate?: Date;
}

/**
 * FEFO sırası servis içinde SQL'e bırakıldığı için harness satırları
 * verildiği sırada döndürür (spec fixture'ları zaten FEFO sıralı).
 */
function makeHarness(rows: Row[], locations: Record<string, string>) {
  // TenantScopedRepository önce tenant predikatını `where` ile kurar, sonra
  // predicate-resetter'ları KAPATIR (qb.where artık fırlatır). Bu yüzden her
  // createQueryBuilder çağrısı TAZE bir builder döndürmeli — tek nesne
  // paylaşmak ikinci çağrıda sahte bir hata üretirdi.
  const builders: Array<Record<string, jest.Mock>> = [];
  const makeQueryBuilder = () => {
    const qb: Record<string, jest.Mock> = {
      where: jest.fn(() => qb as never),
      andWhere: jest.fn(() => qb as never),
      orderBy: jest.fn(() => qb as never),
      addOrderBy: jest.fn(() => qb as never),
      setLock: jest.fn(() => qb as never),
      getMany: jest.fn().mockResolvedValue(rows.map((row) => stub<StorageInventory>(row))),
    };
    builders.push(qb);
    return qb;
  };
  // TenantScopedRepository tenant kolon adını metadata'dan çözer.
  const metadata = { findColumnWithPropertyName: () => ({ databaseName: 'tenant_id' }) };
  const inventoryRepo = {
    metadata,
    createQueryBuilder: jest.fn(() => makeQueryBuilder()),
  };
  const locationRepo = {
    metadata,
    find: jest
      .fn()
      .mockResolvedValue(
        Object.entries(locations).map(([id, siteId]) =>
          stub<StorageLocation>({ id, siteId, isDeleted: false }),
        ),
      ),
  };

  const manager = stub<EntityManager>({
    getRepository: jest.fn((entity: unknown) => {
      if (entity === StorageInventory) return inventoryRepo;
      if (entity === StorageLocation) return locationRepo;
      throw new Error('unexpected repository');
    }) as never,
  });

  // `builders` çağrı SONRASI okunur (destructuring anında henüz boştur).
  return { service: new FeedAllocationService(), manager, builders };
}

describe('FeedAllocationService.allocateForDeduction', () => {
  it('C-2 senaryosu: 0.3 kg artık lot 150 kg öğünü ARTIK reddetmez, FEFO kaskadı yapar', async () => {
    const { service, manager } = makeHarness(
      [
        { id: 'i1', storageLocationId: 'loc-1', lotNumber: 'LOT-A', quantity: 0.3 },
        { id: 'i2', storageLocationId: 'loc-2', lotNumber: 'LOT-B', quantity: 3000 },
      ],
      { 'loc-1': SITE_A, 'loc-2': SITE_A },
    );

    const result = await service.allocateForDeduction(manager, TENANT, {
      feedId: FEED,
      quantityKg: 150,
      asOf: new Date('2026-07-01T08:00:00Z'),
      siteId: SITE_A,
    });

    expect(result.slices).toEqual([
      expect.objectContaining({ lotNumber: 'LOT-A', quantityKg: 0.3 }),
      expect.objectContaining({ lotNumber: 'LOT-B', quantityKg: 149.7 }),
    ]);
    // Toplam istenen kadar — ne eksik ne fazla.
    expect(result.slices.reduce((sum, slice) => sum + slice.quantityKg, 0)).toBeCloseTo(150);
    expect(result.usedSiteFallback).toBe(false);
  });

  it('tek lot yetiyorsa TEK dilim üretir (eski idempotency anahtarı korunur)', async () => {
    const { service, manager } = makeHarness(
      [{ id: 'i1', storageLocationId: 'loc-1', lotNumber: 'LOT-A', quantity: 500 }],
      { 'loc-1': SITE_A },
    );

    const result = await service.allocateForDeduction(manager, TENANT, {
      feedId: FEED,
      quantityKg: 150,
      asOf: new Date(),
      siteId: SITE_A,
    });

    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]!.quantityKg).toBe(150);
  });

  it('site havuzu yetmezse tenant havuzuyla DEVAM eder (tek havuz kararı) ve bayrak taşır', async () => {
    const { service, manager } = makeHarness(
      [
        { id: 'i1', storageLocationId: 'loc-1', lotNumber: 'LOT-A', quantity: 40 },
        { id: 'i2', storageLocationId: 'loc-9', lotNumber: 'LOT-Z', quantity: 500 },
      ],
      { 'loc-1': SITE_A, 'loc-9': SITE_B },
    );

    const result = await service.allocateForDeduction(manager, TENANT, {
      feedId: FEED,
      quantityKg: 100,
      asOf: new Date(),
      siteId: SITE_A,
    });

    expect(result.slices.map((slice) => slice.quantityKg)).toEqual([40, 60]);
    expect(result.usedSiteFallback).toBe(true);
  });

  it('site lotları FEFO sırasını korumakla birlikte tenant lotlarından ÖNCE tüketilir', async () => {
    const { service, manager } = makeHarness(
      [
        // Daha erken son-kullanma başka sitede; site kapsamı yine de önce gelir.
        { id: 'i9', storageLocationId: 'loc-9', lotNumber: 'LOT-EARLY', quantity: 500 },
        { id: 'i1', storageLocationId: 'loc-1', lotNumber: 'LOT-A', quantity: 500 },
      ],
      { 'loc-1': SITE_A, 'loc-9': SITE_B },
    );

    const result = await service.allocateForDeduction(manager, TENANT, {
      feedId: FEED,
      quantityKg: 100,
      asOf: new Date(),
      siteId: SITE_A,
    });

    expect(result.slices).toHaveLength(1);
    expect(result.slices[0]!.lotNumber).toBe('LOT-A');
    expect(result.usedSiteFallback).toBe(false);
  });

  it('havuz TOPLAMI yetmiyorsa fail-closed ve mesaj gerçek havuz toplamını taşır', async () => {
    const { service, manager } = makeHarness(
      [
        { id: 'i1', storageLocationId: 'loc-1', lotNumber: 'LOT-A', quantity: 0.3 },
        { id: 'i2', storageLocationId: 'loc-2', lotNumber: 'LOT-B', quantity: 10 },
      ],
      { 'loc-1': SITE_A, 'loc-2': SITE_A },
    );

    await expect(
      service.allocateForDeduction(manager, TENANT, {
        feedId: FEED,
        quantityKg: 150,
        asOf: new Date(),
        siteId: SITE_A,
      }),
    ).rejects.toBeInstanceOf(InsufficientFeedStockError);

    await expect(
      service.allocateForDeduction(manager, TENANT, {
        feedId: FEED,
        quantityKg: 150,
        asOf: new Date(),
        siteId: SITE_A,
      }),
    ).rejects.toThrow('10.3kg usable stock');
  });

  it('hiç uygun lot yoksa fail-closed (sessiz kısmi düşüm YOK)', async () => {
    const { service, manager } = makeHarness([], {});

    await expect(
      service.allocateForDeduction(manager, TENANT, {
        feedId: FEED,
        quantityKg: 5,
        asOf: new Date(),
      }),
    ).rejects.toBeInstanceOf(InsufficientFeedStockError);
  });

  it('lot verilirse yalnız o lot tahsis edilir (operatörün beyan ettiği fiziksel lot)', async () => {
    const { service, manager, builders } = makeHarness(
      [{ id: 'i1', storageLocationId: 'loc-1', lotNumber: 'LOT-X', quantity: 90 }],
      { 'loc-1': SITE_A },
    );

    await service.allocateForDeduction(manager, TENANT, {
      feedId: FEED,
      quantityKg: 90,
      asOf: new Date(),
      lotNumber: 'LOT-X',
    });

    expect(builders[0]!['andWhere']).toHaveBeenCalledWith('inv.lotNumber = :lotNumber', {
      lotNumber: 'LOT-X',
    });
  });
});
