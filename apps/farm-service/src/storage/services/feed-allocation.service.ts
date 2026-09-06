/**
 * FeedAllocationService — yem düşümünün ÇOK-LOTLU FEFO tahsis motoru
 * (W2, FARM-CRITICAL-245 + FARM-CRITICAL-237).
 *
 * ## Neden var
 *
 * Düşüm tek `storage_inventory` SATIRI seçiyordu (`resolveFeedDeductionLocation`
 * → `.getOne()`), sonra `decreaseInventory` o satırda yetersizlik görünce tüm
 * tenant transaction'ını geri alıyordu. Satır anahtarı (lokasyon + lot)
 * olduğundan bu, lot numarası hiç kullanmayan bir tenant'ta bile rutin bir
 * durumdur: depo + silo iki satır demektir ve `round3` döküm aritmetiği düzenli
 * olarak 0.2–2 kg'lık artıklar bırakır. Sonuç: sitede 3000 kg yem varken
 * 150 kg'lık öğün "Insufficient stock. Available: 0.3 kg" ile REDDEDİLİYOR;
 * mobil çevrimdışıda ise kuyruk 5 denemede kalıcı `failed` olduğu için balık
 * fiziksel olarak beslendiği hâlde öğün kalıcı kayboluyordu.
 *
 * Güvenlik ağı da tam burada kapalıydı: tenant-geneli fallback YALNIZ
 * site-kapsamlı sorgu `null` dönerse çalışıyordu; 0.3 kg'lık artık satır
 * `quantity > 0` koşulunu sağladığı için fallback hiç denenmiyordu.
 *
 * ## Model
 *
 * Yetersizlik kararı SATIRDAN değil HAVUZ TOPLAMINDAN verilir; düşüm FEFO
 * sırayla birden çok lota kaskad eder ve her dilim ayrı bir immutable
 * `stock_movements` satırı yazar — EU 178/2002 lot izlenebilirliği korunur
 * (tek satıra "toplulaştırmak" izlenebilirliği yok ederdi).
 *
 * Havuz kapsamı (kullanıcı kararı: TEK TENANT HAVUZU, fallback meşru):
 * önce ünitenin sitesindeki lotlar tüketilir; site yetmezse tenant-geneli
 * lotlarla DEVAM edilir (eskiden "site hiç yoksa" tümden fallback vardı).
 * Bu, düşümün fiilen kullandığı havuzla forecast'in okuduğu havuzu aynı
 * gerçeğe bağlar (W6 kapsam simetrisi bunun üzerine kurulur).
 *
 * @module Storage/Services
 */
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';

import { StorageInventory, StorageItemType } from '../entities/storage-inventory.entity';
import { StorageLocation } from '../entities/storage-location.entity';
import { StockMutationLockAuthority } from './stock-mutation-lock.authority';
// Stok kolonları numeric(15,2) — tahsis aritmetiği TAM SAYI hundredths üzerinde
// yapılır, float toleransı ile değil.
import { stockQuantityFromUnits, stockQuantityUnits } from './stock-quantity';

/** Tek lot/lokasyondan düşülecek pay. */
export interface FeedAllocationSlice {
  storageLocationId: string;
  lotNumber?: string;
  quantityKg: number;
  /** İade sırasında orijinal son-kullanma taşınabilsin diye (FARM-MEDIUM-254). */
  expiryDate?: Date | null;
}

export interface FeedAllocationResult {
  slices: FeedAllocationSlice[];
  /** Site havuzu yetmediği için tenant-geneli lot kullanıldı (D-9 belgeli). */
  usedSiteFallback: boolean;
  /** Havuzda bulunan toplam (tanılama + mesaj). */
  poolTotalKg: number;
}

/** Havuz toplamı yetersiz — fail-closed, mesaj GERÇEK havuz toplamını taşır. */
export class InsufficientFeedStockError extends BadRequestException {
  constructor(feedId: string, requestedKg: number, poolTotalKg: number, lotNumber?: string) {
    super(
      lotNumber
        ? `Feed ${feedId} lot "${lotNumber}" has ${poolTotalKg}kg usable stock; ` +
            `${requestedKg}kg requested.`
        : `Feed ${feedId} has ${poolTotalKg}kg usable stock across the pool; ` +
            `${requestedKg}kg requested.`,
    );
  }
}

/** Tahsis derleyicisinin girdisi — I/O'dan arındırılmış aday satır. */
export interface FeedAllocationCandidate {
  storageLocationId: string;
  lotNumber?: string;
  quantityKg: number;
  expiryDate: Date | null;
  siteId: string;
}

/**
 * SAF FEFO derleyicisi — veritabanına dokunmaz.
 *
 * Ayrı bir fonksiyon olmasının sebebi test kolaylığı değil, ARİTMETİK: dağıtım
 * tam sayı hundredths üzerinde yapılır, dolayısıyla "kalan sıfır mı" sorusu
 * `=== 0` ile yanıtlanır. Eski hâl float `round2` ile toplayıp `KG_EPSILON`
 * toleransıyla karşılaştırıyordu; tolerans, "neredeyse tahsis edildi"nin
 * "tahsis edildi" diye geçebildiği yerdir ve gizlediği artık, FARM-CRITICAL-245'in
 * konusu olan 0.2–2 kg sınıfının ta kendisidir.
 *
 * Havuz sırası: önce ünitenin sitesi (D-9), sonra tenant-geneli — ikisi de
 * çağıranın verdiği FEFO sırasında.
 */
export function compileFeedAllocation(
  candidates: readonly FeedAllocationCandidate[],
  requestedKg: number,
  params: { feedId: string; lotNumber?: string; siteId?: string },
): FeedAllocationResult {
  const requestedUnits = stockQuantityUnits(requestedKg, 'Feed allocation quantity');
  const withUnits = candidates.map((candidate) => ({
    candidate,
    units: stockQuantityUnits(candidate.quantityKg, 'Inventory quantity', { allowZero: true }),
  }));
  const poolUnits = withUnits.reduce((total, entry) => total + entry.units, 0);
  const poolTotalKg = stockQuantityFromUnits(poolUnits);

  if (poolUnits < requestedUnits) {
    throw new InsufficientFeedStockError(params.feedId, requestedKg, poolTotalKg, params.lotNumber);
  }

  const ordered = params.siteId
    ? [
        ...withUnits.filter((entry) => entry.candidate.siteId === params.siteId),
        ...withUnits.filter((entry) => entry.candidate.siteId !== params.siteId),
      ]
    : withUnits;

  const slices: FeedAllocationSlice[] = [];
  let remainingUnits = requestedUnits;
  let usedSiteFallback = false;

  for (const { candidate, units } of ordered) {
    if (remainingUnits === 0) break;
    const takeUnits = Math.min(units, remainingUnits);
    if (takeUnits === 0) continue;
    slices.push({
      storageLocationId: candidate.storageLocationId,
      lotNumber: candidate.lotNumber,
      quantityKg: stockQuantityFromUnits(takeUnits),
      expiryDate: candidate.expiryDate,
    });
    if (params.siteId && candidate.siteId !== params.siteId) usedSiteFallback = true;
    remainingUnits -= takeUnits;
  }

  if (remainingUnits !== 0) {
    // Havuz toplamı yeterliydi ama dağıtım tamamlanamadı — sessiz kısmi düşüm
    // YERİNE fail-closed. Tam sayı aritmetiğinde bu yol yalnız aday listesi ile
    // toplamı üreten liste ayrışırsa görülebilir, yani gerçek bir kusurdur.
    throw new InsufficientFeedStockError(params.feedId, requestedKg, poolTotalKg, params.lotNumber);
  }

  return { slices, usedSiteFallback, poolTotalKg };
}

@Injectable()
export class FeedAllocationService {
  private readonly logger = new Logger(FeedAllocationService.name);

  constructor(private readonly mutationLocks: StockMutationLockAuthority) {}

  /**
   * FEFO sırayla `quantityKg`'yi kilitlenmiş satırlara dağıtır. Havuz toplamı
   * yetmezse HİÇBİR yazım yapılmadan fail-closed atar (çağıran transaction'ı
   * geri alır).
   *
   * Kilit protokolü İKİ katmanlıdır ve sırası önemlidir:
   *  1. `StockMutationLockAuthority` ile `(tenant, FEED, feedId)` advisory
   *     kilidi — satır YOKKEN de var olan tek fence budur; aksi hâlde iki
   *     eşzamanlı yazar aynı fiziksel anahtar için ayrı satır yaratabilir;
   *  2. aday satırlar üzerinde `FOR UPDATE` — aynı lotu iki kez taahhüt etmeyi
   *     engeller.
   */
  async allocateForDeduction(
    manager: EntityManager,
    tenantId: string,
    params: {
      feedId: string;
      quantityKg: number;
      asOf: Date;
      lotNumber?: string;
      siteId?: string;
    },
  ): Promise<FeedAllocationResult> {
    if (!Number.isFinite(params.quantityKg) || params.quantityKg <= 0) {
      throw new BadRequestException('Tahsis miktarı pozitif olmalıdır');
    }

    await this.mutationLocks.acquire(manager, tenantId, [
      { itemType: StorageItemType.FEED, itemId: params.feedId },
    ]);

    const candidates = await this.loadCandidates(manager, tenantId, params);
    const result = compileFeedAllocation(candidates, params.quantityKg, {
      feedId: params.feedId,
      lotNumber: params.lotNumber,
      siteId: params.siteId,
    });

    if (result.usedSiteFallback) {
      this.logger.warn(
        `Feed allocation crossed the site boundary: site ${params.siteId} pool was short for ` +
          `feed ${params.feedId} (${params.quantityKg}kg); tenant-wide lots covered the remainder.`,
      );
    }

    return result;
  }

  /**
   * FEFO adayları — `FOR UPDATE` kilitli. Süresi geçmiş ve yemleme anından
   * SONRA gelen lotlar dışlanır (geriye dönük kayıt, sonradan gelen lotu
   * tüketemez); lot verildiyse yalnız o lot.
   */
  private async loadCandidates(
    manager: EntityManager,
    tenantId: string,
    params: { feedId: string; asOf: Date; lotNumber?: string },
  ): Promise<FeedAllocationCandidate[]> {
    // Envanter satırları JOIN'siz okunur ve KİLİTLENİR. JOIN + FOR UPDATE,
    // lokasyon satırlarını da kilitleyip ilgisiz yazarları bloke ederdi;
    // ayrıca ham join şartları FARM-CRITICAL-242'nin bug sınıfını doğuran
    // yüzeydi. Site bilgisi ikinci, kilitsiz bir okumadan gelir.
    const query = tenantManagerRepo(manager, StorageInventory, tenantId)
      .createQueryBuilder('inv')
      .andWhere('inv.itemType = :itemType', { itemType: StorageItemType.FEED })
      .andWhere('inv.itemId = :itemId', { itemId: params.feedId })
      .andWhere('inv.quantity > 0')
      // FARM: the operation's own moment, not the wall clock. `asOf` is what
      // the neighbouring receivedDate clause already binds, and a deduction
      // recorded retroactively must see the pool as it stood THEN — reading
      // `new Date()` here meant a backdated record was judged against now, so
      // a lot that was valid at feeding time and expired since silently left
      // the pool. The remaining day-boundary question (this compares a DATE
      // column against an instant in UTC, while the platform's day semantics
      // are the site's local day) is tracked, not fixed here: resolving the
      // zone needs FeedingClockService, and feeding-protocol already imports
      // storage, so injecting it here would close a module cycle.
      .andWhere('(inv.expiryDate IS NULL OR inv.expiryDate > :expiryAsOf)', {
        expiryAsOf: params.asOf,
      })
      .andWhere('(inv.receivedDate IS NULL OR inv.receivedDate <= :asOf)', { asOf: params.asOf });
    if (params.lotNumber) {
      query.andWhere('inv.lotNumber = :lotNumber', { lotNumber: params.lotNumber });
    }

    const inventory = await query
      .orderBy('inv.expiryDate', 'ASC', 'NULLS LAST')
      .addOrderBy('inv.receivedDate', 'ASC', 'NULLS LAST')
      .addOrderBy('inv.lotNumber', 'ASC')
      .setLock('pessimistic_write')
      .getMany();
    if (inventory.length === 0) return [];

    const locationIds = [...new Set(inventory.map((row) => row.storageLocationId))];
    const locations = await tenantManagerRepo(manager, StorageLocation, tenantId).find({
      where: locationIds.map((id) => ({ id, tenantId })),
    });
    const siteByLocation = new Map(locations.map((loc) => [loc.id, loc]));

    return (
      inventory
        // Silinmiş lokasyondaki stok tahsis edilemez (forecast tarafıyla aynı
        // filtre — havuz iki tarafta aynı gerçeği okumalı).
        .filter((row) => {
          const location = siteByLocation.get(row.storageLocationId);
          return location !== undefined && !location.isDeleted;
        })
        .map((row): FeedAllocationCandidate => {
          const location = siteByLocation.get(row.storageLocationId);
          if (!location) {
            // Filtrelenmiş listede olamaz; olursa sessizce atlamak yerine
            // patlar — havuz toplamı ile dilimler ayrışamaz.
            throw new BadRequestException(
              `Inventory ${row.id} references an unavailable storage location`,
            );
          }
          return {
            storageLocationId: row.storageLocationId,
            lotNumber: row.lotNumber ?? undefined,
            quantityKg: Number(row.quantity),
            expiryDate: row.expiryDate ?? null,
            siteId: location.siteId,
          };
        })
    );
  }
}
