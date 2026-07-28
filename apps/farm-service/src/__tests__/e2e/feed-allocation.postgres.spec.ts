/**
 * FEFO feed allocation against a REAL PostgreSQL (W2 / FARM-CRITICAL-245).
 *
 * ## Why this suite has to hit a real database
 *
 * Every defect this engine has shipped lived precisely where a mock cannot see:
 *
 *   - FARM-CRITICAL-242: the site-scoped FEFO join compared `inv."storageLocationId"`
 *     and `loc."siteId"`. The real columns are `storage_location_id` / `site_id`
 *     (both entities declare explicit `name:` mappings), so every deduction
 *     carrying a siteId raised 42703 — and every existing test was green,
 *     because they all used mock repositories.
 *   - FARM-HIGH-300: a raw predicate asked for `"movement_type" = 'OUT'` while
 *     the column holds `'out'`. Silent zero rows, not an error.
 *
 * Both are invisible to a double and obvious to Postgres. The suite therefore
 * builds the two entities the allocator actually reads and lets TypeORM emit
 * the SQL, so the column names under test are the ones production uses.
 *
 * ## Scope
 *
 * The allocator DECIDES; it writes nothing. That is why this file seeds
 * inventory directly and asserts the returned slices: the ledger write is
 * `StockMovementService`'s job and is covered separately. Keeping the boundary
 * here means a failure names the allocator rather than the whole feeding path.
 *
 * NOTE ON LOCKS: `loadCandidates` takes `pessimistic_write`, so every call runs
 * inside a transaction. No assertion here depends on lock CONTENTION — the
 * harness sets no `lock_timeout`, so a contended probe would hang until the
 * Jest timeout rather than failing, which reads as a flake instead of a result.
 */
import 'reflect-metadata';
import { randomBytes } from 'crypto';

import { bootPostgresContainer, HarnessContext, shutdownHarness } from '@platform/migration-harness';
import { DataSource } from 'typeorm';

import {
  FeedAllocationService,
  InsufficientFeedStockError,
} from '../../storage/services/feed-allocation.service';
import {
  StorageInventory,
  StorageItemType,
} from '../../storage/entities/storage-inventory.entity';
import { StorageLocation } from '../../storage/entities/storage-location.entity';

jest.setTimeout(120_000);

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '99999999-9999-4999-8999-999999999999';
const FEED = '22222222-2222-4222-8222-222222222222';
const OTHER_FEED = '33333333-3333-4333-8333-333333333333';

const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const LOC_A1 = 'a1111111-1111-4111-8111-111111111111';
const LOC_A2 = 'a2222222-2222-4222-8222-222222222222';
const LOC_B1 = 'b1111111-1111-4111-8111-111111111111';
const LOC_DELETED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

/** Yemleme anı — `receivedDate <= asOf` filtresi buna göre değerlendirilir. */
const AS_OF = new Date('2026-06-15T08:00:00Z');

/**
 * TAHSİS SORGUSU İKİ FARKLI SAATİ KULLANIR — fixture'ların bunu yansıtması şart.
 *
 * `loadCandidates` içinde `receivedDate` **`asOf`**'a göre süzülür (geçmişe
 * dönük bir kayıt gelecekteki stoğu tüketemez), ama `expiryDate` **`new Date()`**
 * ile, yani GERÇEK duvar saatiyle karşılaştırılır (bugün süresi dolmuş yem
 * bugün yedirilemez). İkisi aynı sorguda yaşıyor.
 *
 * Bu yüzden son kullanma tarihleri MUTLAK yazılamaz: ilk sürümde `AS_OF`'un
 * (2026-06-15) yakınına sabitlenmişlerdi ve süit 2026-07-01'de kendiliğinden
 * kırmızıya döndü — takvim ilerledikçe lotlar teker teker "süresi dolmuş"
 * sayılıp havuzdan düştü. Daha kötüsü, DIŞLANMASI beklenen lotlar (silinmiş
 * depo, başka tenant) da süresi dolduğu için dışlanıyordu: assertion'lar test
 * ettikleri filtre yüzünden değil, YANLIŞ SEBEPLE geçerdi.
 *
 * Kural bu yüzden tek yerde: görünmesi gereken her lot gerçek "şimdi"ye göre
 * İLERİ bir tarih alır; dışlanması gereken lot yalnızca test edilen filtreyle
 * (silinmişlik, tenant, feed, receivedDate, pinlenmiş lot) dışlanır.
 */
function expiryInDays(days: number): string {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return date.toISOString().slice(0, 10);
}

/** Lot-izlenebilirliği vakasının hem fixture'ı hem beklentisi — tek kaynak. */
const EXPIRY_PROPAGATION_DATE = expiryInDays(120);

interface LotSeed {
  id: string;
  locationId: string;
  quantity: number;
  /** Entity kolonları nullable-optional (`?: T`), bu yüzden yokluk `undefined`. */
  lotNumber?: string;
  expiryDate?: string;
  receivedDate?: string;
  tenantId?: string;
  itemId?: string;
}

describe('FeedAllocationService.allocateForDeduction — real Postgres', () => {
  let pg: HarnessContext;
  let dataSource: DataSource;
  const service = new FeedAllocationService();

  beforeAll(async () => {
    pg = await bootPostgresContainer({ startTimeoutMs: 90_000 });
    await pg.dataSource.query('CREATE SCHEMA farm');

    dataSource = new DataSource({
      type: 'postgres',
      ...pg.connectionOptions,
      name: `farm-service-feed-allocation-${randomBytes(4).toString('hex')}`,
      entities: [StorageLocation, StorageInventory],
      synchronize: true,
      logging: false,
      extra: { options: '-c search_path=farm,public' },
    });
    await dataSource.initialize();

    // Seed EntityManager üzerinden yazılır: ham repository erişimi CLAUDE.md'de
    // yasaklıdır (tenant izolasyonunu baypas eder) ve kapı spec dosyalarını
    // muaf tutmaz — `manager.save(Entity, rows)` o yüzeye hiç dokunmaz.
    // `usedCapacity` AÇIKÇA verilir. Kolon `default: 0` taşır ama aynı zamanda
    // bir `DecimalTransformer`'ı vardır: TypeORM transformer'ı insert'ten ÖNCE
    // uygular, `undefined` NULL'a döner ve satıra açık NULL yazılır — DB
    // default'u hiç devreye girmez, NOT NULL kısıtı patlar. Üretimdeki
    // `CreateStorageLocationHandler` de bu yüzden alanı elle 0 veriyor
    // (create-storage-location.handler.ts:54), yani burada onu atlamak
    // fixture'ı üretimden farklı kılardı.
    await dataSource.manager.save(StorageLocation, [
      { id: LOC_A1, tenantId: TENANT, siteId: SITE_A, code: 'A1', name: 'Site A depo 1', usedCapacity: 0 },
      { id: LOC_A2, tenantId: TENANT, siteId: SITE_A, code: 'A2', name: 'Site A depo 2', usedCapacity: 0 },
      { id: LOC_B1, tenantId: TENANT, siteId: SITE_B, code: 'B1', name: 'Site B depo', usedCapacity: 0 },
      {
        id: LOC_DELETED,
        tenantId: TENANT,
        siteId: SITE_A,
        code: 'DEL',
        name: 'Kapatılmış depo',
        usedCapacity: 0,
        isDeleted: true,
      },
    ]);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
    await shutdownHarness(pg);
  });

  /**
   * Her senaryo kendi lot kümesiyle başlar. Temizlik `clear()` ile yapılır:
   * `delete(Entity, {})` boş kriteri sayılır ve TypeORM onu — tam-tablo
   * silmeyi kazara yapmayı önlemek için — hata ile reddeder.
   */
  async function seedLots(lots: LotSeed[]): Promise<void> {
    await dataSource.manager.clear(StorageInventory);
    await dataSource.manager.save(
      StorageInventory,
      lots.map((lot) => ({
        id: lot.id,
        tenantId: lot.tenantId ?? TENANT,
        storageLocationId: lot.locationId,
        itemType: StorageItemType.FEED,
        itemId: lot.itemId ?? FEED,
        quantity: lot.quantity,
        unit: 'kg',
        lotNumber: lot.lotNumber,
        expiryDate: lot.expiryDate ? new Date(lot.expiryDate) : undefined,
        receivedDate: lot.receivedDate ? new Date(lot.receivedDate) : undefined,
      })),
    );
  }

  function allocate(params: {
    quantityKg: number;
    siteId?: string;
    lotNumber?: string;
  }): Promise<Awaited<ReturnType<FeedAllocationService['allocateForDeduction']>>> {
    return dataSource.transaction((manager) =>
      service.allocateForDeduction(manager, TENANT, {
        feedId: FEED,
        asOf: AS_OF,
        ...params,
      }),
    );
  }

  it('cascades across lots in FEFO order instead of demanding one big enough row', async () => {
    // Plan §W2'nin senaryosu: 0.3 kg'lık artık lot yüzünden 3000 kg stokta
    // 150 kg'lık öğün reddediliyordu.
    await seedLots([
      {
        id: '00000000-0000-4000-8000-000000000001',
        locationId: LOC_A1,
        lotNumber: 'LOT-ESKI',
        quantity: 0.3,
        expiryDate: expiryInDays(30),
        receivedDate: '2026-05-01T00:00:00Z',
      },
      {
        id: '00000000-0000-4000-8000-000000000002',
        locationId: LOC_A1,
        lotNumber: 'LOT-YENI',
        quantity: 3000,
        expiryDate: expiryInDays(180),
        receivedDate: '2026-06-01T00:00:00Z',
      },
    ]);

    const result = await allocate({ quantityKg: 150 });

    expect(result.slices).toHaveLength(2);
    // Önce SÜRESİ ÖNCE DOLAN lot tüketilir — FEFO'nun tanımı.
    expect(result.slices[0]).toMatchObject({ lotNumber: 'LOT-ESKI', quantityKg: 0.3 });
    expect(result.slices[1]).toMatchObject({ lotNumber: 'LOT-YENI', quantityKg: 149.7 });
    expect(result.poolTotalKg).toBe(3000.3);
    expect(result.usedSiteFallback).toBe(false);
  });

  it('decides insufficiency on the POOL total, not on any single row', async () => {
    await seedLots([
      {
        id: '00000000-0000-4000-8000-000000000003',
        locationId: LOC_A1,
        lotNumber: 'L1',
        quantity: 40,
        expiryDate: expiryInDays(30),
        receivedDate: '2026-05-01T00:00:00Z',
      },
      {
        id: '00000000-0000-4000-8000-000000000004',
        locationId: LOC_A2,
        lotNumber: 'L2',
        quantity: 35,
        expiryDate: expiryInDays(60),
        receivedDate: '2026-05-02T00:00:00Z',
      },
    ]);

    // 75 kg havuzda var (40 + 35) — hiçbir tek satır yetmese de tahsis olur.
    const ok = await allocate({ quantityKg: 75 });
    expect(ok.slices.map((s) => s.quantityKg)).toEqual([40, 35]);

    // 75.01 kg havuzu aşar → hiçbir yazım yapılmadan fail-closed.
    await expect(allocate({ quantityKg: 75.01 })).rejects.toBeInstanceOf(
      InsufficientFeedStockError,
    );
  });

  it('drains the requested site first, then falls back to the tenant pool and says so', async () => {
    await seedLots([
      {
        id: '00000000-0000-4000-8000-000000000005',
        locationId: LOC_A1,
        lotNumber: 'SITE-A',
        quantity: 10,
        // Site B lotu DAHA ÖNCE doluyor: saf FEFO onu önce seçerdi. Site
        // kapsamı FEFO'dan önce gelir (D-9), bu yüzden sıra A → B olmalı.
        expiryDate: expiryInDays(180),
        receivedDate: '2026-05-01T00:00:00Z',
      },
      {
        id: '00000000-0000-4000-8000-000000000006',
        locationId: LOC_B1,
        lotNumber: 'SITE-B',
        quantity: 100,
        expiryDate: expiryInDays(30),
        receivedDate: '2026-05-01T00:00:00Z',
      },
    ]);

    const result = await allocate({ quantityKg: 30, siteId: SITE_A });

    expect(result.slices[0]).toMatchObject({ lotNumber: 'SITE-A', quantityKg: 10 });
    expect(result.slices[1]).toMatchObject({ lotNumber: 'SITE-B', quantityKg: 20 });
    expect(result.usedSiteFallback).toBe(true);
  });

  it('never allocates from a soft-deleted location, and excludes it from the pool total', async () => {
    await seedLots([
      {
        id: '00000000-0000-4000-8000-000000000007',
        locationId: LOC_DELETED,
        lotNumber: 'OLU-DEPO',
        quantity: 5000,
        expiryDate: expiryInDays(180),
        receivedDate: '2026-05-01T00:00:00Z',
      },
      {
        id: '00000000-0000-4000-8000-000000000008',
        locationId: LOC_A1,
        lotNumber: 'CANLI',
        quantity: 20,
        expiryDate: expiryInDays(200),
        receivedDate: '2026-05-01T00:00:00Z',
      },
    ]);

    const result = await allocate({ quantityKg: 20 });
    expect(result.slices).toEqual([
      expect.objectContaining({ lotNumber: 'CANLI', quantityKg: 20 }),
    ]);
    // Silinmiş depodaki 5000 kg havuza SAYILMAZ — forecast tarafıyla aynı
    // filtre; iki taraf aynı gerçeği okumazsa kapsama yalan söyler.
    expect(result.poolTotalKg).toBe(20);

    await expect(allocate({ quantityKg: 21 })).rejects.toBeInstanceOf(InsufficientFeedStockError);
  });

  it('carries the lot expiry into the slice so the ledger can record it', async () => {
    await seedLots([
      {
        id: '00000000-0000-4000-8000-000000000009',
        locationId: LOC_A1,
        lotNumber: 'EXP',
        quantity: 12,
        // Beklenen değer fixture ile AYNI ifadeden türer: elle yazılmış bir
        // tarih, gerçek "şimdi" onu geçtiği gün lotu havuzdan düşürür ve bu
        // vaka takvim yüzünden kırmızıya döner.
        expiryDate: EXPIRY_PROPAGATION_DATE,
        receivedDate: '2026-05-01T00:00:00Z',
      },
    ]);

    const result = await allocate({ quantityKg: 12 });
    // EU 178/2002 lot izlenebilirliği: iade ve geri çağırma bu alana dayanır.
    expect(result.slices[0]?.expiryDate).toBeTruthy();
    expect(String(result.slices[0]?.expiryDate)).toContain(EXPIRY_PROPAGATION_DATE);
  });

  it('honours a pinned lot number and refuses to silently spill into other lots', async () => {
    await seedLots([
      {
        id: '00000000-0000-4000-8000-00000000000a',
        locationId: LOC_A1,
        lotNumber: 'PIN',
        quantity: 5,
        expiryDate: expiryInDays(30),
        receivedDate: '2026-05-01T00:00:00Z',
      },
      {
        id: '00000000-0000-4000-8000-00000000000b',
        locationId: LOC_A1,
        lotNumber: 'DIGER',
        quantity: 500,
        expiryDate: expiryInDays(60),
        receivedDate: '2026-05-01T00:00:00Z',
      },
    ]);

    const ok = await allocate({ quantityKg: 5, lotNumber: 'PIN' });
    expect(ok.slices).toEqual([expect.objectContaining({ lotNumber: 'PIN', quantityKg: 5 })]);

    // Pinlenen lot yetmiyorsa yanındaki 500 kg'a TAŞMAZ.
    await expect(allocate({ quantityKg: 6, lotNumber: 'PIN' })).rejects.toBeInstanceOf(
      InsufficientFeedStockError,
    );
  });

  it('ignores lots received after the feeding moment (a backdated record cannot consume future stock)', async () => {
    await seedLots([
      {
        id: '00000000-0000-4000-8000-00000000000c',
        locationId: LOC_A1,
        lotNumber: 'GELECEK',
        quantity: 900,
        expiryDate: expiryInDays(180),
        // AS_OF = 2026-06-15; bu lot teslimattan SONRA gelmiş.
        receivedDate: '2026-07-01T00:00:00Z',
      },
      {
        id: '00000000-0000-4000-8000-00000000000d',
        locationId: LOC_A1,
        lotNumber: 'MEVCUT',
        quantity: 8,
        expiryDate: expiryInDays(200),
        receivedDate: '2026-06-01T00:00:00Z',
      },
    ]);

    const result = await allocate({ quantityKg: 8 });
    expect(result.slices).toEqual([
      expect.objectContaining({ lotNumber: 'MEVCUT', quantityKg: 8 }),
    ]);
    expect(result.poolTotalKg).toBe(8);
  });

  it('never reaches another tenant stock, even for the same feed', async () => {
    await seedLots([
      {
        id: '00000000-0000-4000-8000-00000000000e',
        locationId: LOC_A1,
        lotNumber: 'BIZIM',
        quantity: 4,
        expiryDate: expiryInDays(180),
        receivedDate: '2026-05-01T00:00:00Z',
      },
      {
        id: '00000000-0000-4000-8000-00000000000f',
        locationId: LOC_A1,
        lotNumber: 'BASKA-TENANT',
        quantity: 9999,
        expiryDate: expiryInDays(200),
        receivedDate: '2026-05-01T00:00:00Z',
        tenantId: OTHER_TENANT,
      },
    ]);

    const result = await allocate({ quantityKg: 4 });
    expect(result.poolTotalKg).toBe(4);
    await expect(allocate({ quantityKg: 5 })).rejects.toBeInstanceOf(InsufficientFeedStockError);
  });

  it('never reaches another feed item', async () => {
    await seedLots([
      {
        id: '00000000-0000-4000-8000-000000000010',
        locationId: LOC_A1,
        lotNumber: 'DOGRU-YEM',
        quantity: 3,
        expiryDate: expiryInDays(180),
        receivedDate: '2026-05-01T00:00:00Z',
      },
      {
        id: '00000000-0000-4000-8000-000000000011',
        locationId: LOC_A1,
        lotNumber: 'BASKA-YEM',
        quantity: 7000,
        expiryDate: expiryInDays(200),
        receivedDate: '2026-05-01T00:00:00Z',
        itemId: OTHER_FEED,
      },
    ]);

    const result = await allocate({ quantityKg: 3 });
    expect(result.poolTotalKg).toBe(3);
  });

  it('rejects a non-positive request before touching the database', async () => {
    await seedLots([]);
    await expect(allocate({ quantityKg: 0 })).rejects.toThrow(/pozitif/);
    await expect(allocate({ quantityKg: -5 })).rejects.toThrow(/pozitif/);
  });
});
