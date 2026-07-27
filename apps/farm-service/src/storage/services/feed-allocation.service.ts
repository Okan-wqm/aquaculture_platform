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

interface CandidateRow {
  id: string;
  storageLocationId: string;
  lotNumber?: string;
  quantity: number;
  expiryDate: Date | null;
  siteId: string;
}

/** kg toleransı — numeric(15,2) kolon hassasiyetinin altında kalan artıklar. */
const KG_EPSILON = 0.001;

@Injectable()
export class FeedAllocationService {
  private readonly logger = new Logger(FeedAllocationService.name);

  /**
   * FEFO sırayla `quantityKg`'yi kilitlenmiş satırlara dağıtır. Havuz toplamı
   * yetmezse HİÇBİR yazım yapılmadan fail-closed atar (çağıran transaction'ı
   * geri alır). Kilitler `FOR UPDATE` ile alınır: eşzamanlı iki düşüm aynı
   * lotu iki kez taahhüt edemez.
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

    const candidates = await this.loadCandidates(manager, tenantId, params);
    const poolTotalKg = round2(candidates.reduce((sum, row) => sum + row.quantity, 0));

    if (poolTotalKg + KG_EPSILON < params.quantityKg) {
      throw new InsufficientFeedStockError(
        params.feedId,
        params.quantityKg,
        poolTotalKg,
        params.lotNumber,
      );
    }

    // Site havuzu ÖNCE (D-9), sonra tenant-geneli — ikisi de FEFO sırada.
    const ordered = params.siteId
      ? [
          ...candidates.filter((row) => row.siteId === params.siteId),
          ...candidates.filter((row) => row.siteId !== params.siteId),
        ]
      : candidates;

    const slices: FeedAllocationSlice[] = [];
    let remaining = params.quantityKg;
    let usedSiteFallback = false;

    for (const row of ordered) {
      if (remaining <= KG_EPSILON) break;
      const take = round2(Math.min(remaining, row.quantity));
      if (take <= 0) continue;
      slices.push({
        storageLocationId: row.storageLocationId,
        lotNumber: row.lotNumber,
        quantityKg: take,
        expiryDate: row.expiryDate,
      });
      if (params.siteId && row.siteId !== params.siteId) usedSiteFallback = true;
      remaining = round2(remaining - take);
    }

    if (remaining > KG_EPSILON) {
      // Havuz toplamı yeterliydi ama dağıtım tamamlanamadı — yuvarlama ya da
      // eşzamanlılık; sessiz kısmi düşüm YERİNE fail-closed.
      throw new InsufficientFeedStockError(
        params.feedId,
        params.quantityKg,
        poolTotalKg,
        params.lotNumber,
      );
    }

    if (usedSiteFallback) {
      this.logger.warn(
        `Feed allocation crossed the site boundary: site ${params.siteId} pool was short for ` +
          `feed ${params.feedId} (${params.quantityKg}kg); tenant-wide lots covered the remainder.`,
      );
    }

    return { slices, usedSiteFallback, poolTotalKg };
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
  ): Promise<CandidateRow[]> {
    // Envanter satırları JOIN'siz okunur ve KİLİTLENİR. JOIN + FOR UPDATE,
    // lokasyon satırlarını da kilitleyip ilgisiz yazarları bloke ederdi;
    // ayrıca ham join şartları FARM-CRITICAL-242'nin bug sınıfını doğuran
    // yüzeydi. Site bilgisi ikinci, kilitsiz bir okumadan gelir.
    const query = tenantManagerRepo(manager, StorageInventory, tenantId)
      .createQueryBuilder('inv')
      .andWhere('inv.itemType = :itemType', { itemType: StorageItemType.FEED })
      .andWhere('inv.itemId = :itemId', { itemId: params.feedId })
      .andWhere('inv.quantity > 0')
      .andWhere('(inv.expiryDate IS NULL OR inv.expiryDate > :today)', { today: new Date() })
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
        .map((row) => ({
          id: row.id,
          storageLocationId: row.storageLocationId,
          lotNumber: row.lotNumber ?? undefined,
          quantity: Number(row.quantity),
          expiryDate: row.expiryDate ?? null,
          siteId: siteByLocation.get(row.storageLocationId)!.siteId,
        }))
    );
  }
}

/** Stok kolonları numeric(15,2) — tahsis aritmetiği aynı hassasiyette. */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
