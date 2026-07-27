/**
 * `FeedingLedgerService.applyStockCorrection` — düzeltmenin stok ayağı.
 *
 * ## Neyi kapatıyor
 *
 * Fonksiyon, düzeltilecek kaydın ORİJİNAL düşümlerini bulmak için ham SQL
 * atıyor ve bulamazsa erken çıkıyor. O sorgu hareket tipini string literal
 * olarak arıyordu (`"movement_type" = 'OUT'`), oysa kolona TypeORM
 * `MovementType.OUT`'un DEĞERİNİ yazıyor: `'out'`. Kolon `varchar(20)` —
 * PG enum değil — dolayısıyla hiçbir zımni harf eşitlemesi yok.
 *
 * Sonuç: sorgu HER ZAMAN sıfır satır dönüyordu, fonksiyon erken çıkışa
 * düşüyordu ve düzeltmenin stok ayağı **iki yönde de** sessizce atlanıyordu —
 * erken çıkış, yukarı-düzeltme dalından da önce geliyor. Öğün düzeltmesi
 * `actualKg`'yi, büyümeyi ve batch toplamını değiştirmeye devam ederken stok
 * hiç kıpırdamıyordu: defter ile depo kalıcı olarak ayrışıyordu.
 *
 * ## Bu spec neden bu şekilde
 *
 * Kusur mevcut testlerin kör noktasındaydı: `MealExecutionService` spec'i
 * `applyStockCorrection`'ı komple `jest.fn()` ile mock'luyor, yani içindeki
 * SQL hiç koşmuyor. `FeedingLedgerService`'in ise hiç spec'i yoktu.
 *
 * Bu yüzden sahte `manager.query` Postgres'in HARF DUYARLILIĞINI kodluyor:
 * satırları yalnız bağlanan hareket-tipi parametresi kolonda saklanan değere
 * (`'out'`) BİREBİR eşitse döner. Literal'e geri dönen herhangi bir düzenleme
 * sıfır satır alır ve buradaki davranış assert'leri düşer — yorum değil, test.
 */
import { EntityManager } from 'typeorm';

import { OutboxPublisher } from '@platform/outbox';

import { FeedingLedgerService } from '../services/feeding-ledger.service';
import { FeedAllocationService } from '../../storage/services/feed-allocation.service';
import { MovementType } from '../../storage/entities/stock-movement.entity';
import { StockMovementService } from '../../storage/services/stock-movement.service';
import { FinanceSettingsService } from '../../finance/services/finance-settings.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FEED = '22222222-2222-4222-8222-222222222222';
const LOCATION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCATION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Kardeş spec'lerdeki (meal-execution.service.spec.ts) ev deseni. */
function mock<T>(impl: Partial<T>): T {
  return impl as T;
}

interface StoredMovement {
  fromLocationId: string;
  lotNumber: string;
  quantity: number;
  /** Kolonda FİİLEN duran değer — TypeORM enum DEĞERİNİ yazar. */
  movementType: string;
}

/**
 * `stock_movements` üzerinde iki OUT dilimi: FEFO ile önce A lotundan 0.3 kg,
 * sonra B lotundan 149.7 kg çekilmiş bir 150 kg'lık öğün.
 */
const STORED: StoredMovement[] = [
  { fromLocationId: LOCATION_A, lotNumber: 'LOT-A', quantity: 0.3, movementType: 'out' },
  { fromLocationId: LOCATION_B, lotNumber: 'LOT-B', quantity: 149.7, movementType: 'out' },
];

interface Harness {
  service: FeedingLedgerService;
  recordMovement: jest.Mock;
  allocateForDeduction: jest.Mock;
  manager: EntityManager;
  boundParams: unknown[][];
}

function makeHarness(): Harness {
  const boundParams: unknown[][] = [];

  // Postgres semantiği: `varchar` karşılaştırması harf duyarlıdır.
  // `EntityManager.query` generic (`query<T>(...): Promise<T>`) olduğu için
  // implementasyon `mockImplementation` ile verilir — böylece double, üretim
  // imzasına hiçbir cast olmadan oturur.
  const query = jest.fn();
  query.mockImplementation(async (_sql: string, params: unknown[] = []) => {
    boundParams.push(params);
    const wantedType = params[2];
    return STORED.filter((row) => row.movementType === wantedType).map((row) => ({
      fromLocationId: row.fromLocationId,
      lotNumber: row.lotNumber,
      quantity: row.quantity,
    }));
  });

  const recordMovement = jest.fn().mockResolvedValue(undefined);
  const allocateForDeduction = jest.fn().mockResolvedValue({ slices: [], usedSiteScope: false });

  const service = new FeedingLedgerService(
    mock<StockMovementService>({ recordMovement }),
    mock<FinanceSettingsService>({}),
    mock<OutboxPublisher>({}),
    mock<FeedAllocationService>({ allocateForDeduction }),
  );

  return {
    service,
    recordMovement,
    allocateForDeduction,
    manager: mock<EntityManager>({ query }),
    boundParams,
  };
}

const BASE_PARAMS = {
  feedId: FEED,
  deductionKeyBase: 'meal-deduct-meal-1-0',
  correctionKey: 'feeding-correct-rec-1-2',
  reference: 'MEAL-1',
};

describe('FeedingLedgerService.applyStockCorrection — hareket tipi bağlanması', () => {
  it('orijinal düşümleri BULUR: hareket tipi kolonda saklanan değerle eşleşir', async () => {
    const h = makeHarness();

    await h.service.applyStockCorrection(h.manager, TENANT, 'user-1', {
      ...BASE_PARAMS,
      deltaKg: -10,
    });

    // Literal 'OUT' ile bu filtre sıfır satır döner ve aşağıdaki iade HİÇ olmaz.
    expect(h.boundParams[0]?.[2]).toBe(MovementType.OUT);
    expect(h.recordMovement).toHaveBeenCalled();
  });

  it('aşağı düzeltmeyi LIFO ile en son çekilen lota iade eder', async () => {
    const h = makeHarness();

    await h.service.applyStockCorrection(h.manager, TENANT, 'user-1', {
      ...BASE_PARAMS,
      deltaKg: -10,
    });

    expect(h.recordMovement).toHaveBeenCalledTimes(1);
    const [, input] = h.recordMovement.mock.calls[0] ?? [];
    expect(input).toMatchObject({
      movementType: MovementType.IN,
      quantity: 10,
      // LIFO: EN SON çekilen B lotu, orijinal A lotu değil.
      toLocationId: LOCATION_B,
      lotNumber: 'LOT-B',
    });
  });

  it('yukarı düzeltmeyi çok-lotlu tahsis motorundan geçirir (erken çıkışa düşmez)', async () => {
    const h = makeHarness();
    h.allocateForDeduction.mockResolvedValue({
      slices: [{ storageLocationId: LOCATION_A, lotNumber: 'LOT-A', quantityKg: 5 }],
      usedSiteScope: false,
    });

    await h.service.applyStockCorrection(h.manager, TENANT, 'user-1', {
      ...BASE_PARAMS,
      deltaKg: 5,
    });

    // Erken çıkış YUKARI dalından da önce geliyordu; eski hâlde bu hiç çağrılmazdı.
    expect(h.allocateForDeduction).toHaveBeenCalledTimes(1);
    expect(h.recordMovement).toHaveBeenCalledWith(
      h.manager,
      expect.objectContaining({ movementType: MovementType.OUT, quantity: 5 }),
      expect.objectContaining({ tenantId: TENANT }),
    );
  });

  it('sıfır delta hiçbir sorgu atmaz', async () => {
    const h = makeHarness();

    await h.service.applyStockCorrection(h.manager, TENANT, 'user-1', {
      ...BASE_PARAMS,
      deltaKg: 0,
    });

    expect(h.boundParams).toHaveLength(0);
    expect(h.recordMovement).not.toHaveBeenCalled();
  });

  it('düşülenden fazla iade istenirse fail-closed reddeder', async () => {
    const h = makeHarness();

    // Toplam düşüm 150 kg; 200 kg iade defteri uyduramaz.
    await expect(
      h.service.applyStockCorrection(h.manager, TENANT, 'user-1', {
        ...BASE_PARAMS,
        deltaKg: -200,
      }),
    ).rejects.toThrow(/İade miktarı/);
  });
});
