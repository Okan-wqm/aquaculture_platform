/**
 * FeedingForecastSnapshot — materyalize tükenme-tahmini satırı (Faz 7, K-10).
 *
 * 07:00 cron'u (ve D-6 event-driven yenileme) MAKS ufukta (120 gün) hesaplar
 * ve `(tenantId, siteScopeKey)` unique anahtarı üzerinden upsert eder;
 * `protocolFeedForecast` sorgusu ile mobil `warehouseSummary` AYNI satırı
 * okur ve istenen ufka DİLİMLER — sorgu anında yeniden hesap yoktur
 * (belirlenebilir bayatlık: `computedAt` UI'da tazelik göstergesidir).
 *
 * `siteScopeKey`: site UUID'si; sitesiz (belgeli tenant-geneli fallback, D-9)
 * kapsam için sabit 'tenant'. jsonb kolonları plan §5'in grafik-hazır
 * serilerini taşır — bunlar SORGU sonucu değil ÇIKTI deposudur; tel şekli
 * Faz 7 GraphQL katmanında tipli DTO'larla açılır.
 *
 * @module FeedingProtocol/Entities
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
} from 'typeorm';

// ============================================================================
// JSONB VALUE OBJECTS — plan §5 forecast çıktı şekilleri
// ============================================================================

export interface ForecastPerFeed {
  feedId: string;
  feedCode: string;
  feedName: string;
  currentStockKg: number;
  /** Gün 0..H-1 günlük tüketim (kg). */
  dailyConsumptionSeries: number[];
  /** Gün 0..H-1 kalan stok (kg) — grafik-hazır seri. */
  remainingStockSeries: number[];
  stockoutDate: string | null;
  daysOfCover: number | null;
  firstConsumptionDate: string | null;
  /** İlk tüketim gününden tükenişe gün ("B 6 gün yeter"). */
  coverageFromAdoptionDays: number | null;
  reorderDate: string | null;
  reorderQuantityKg: number | null;
  /** Uygulanan tedarik süresi + kaynağı (K-17 — sessiz default yok). */
  procurementLeadTimeDays: number;
  leadTimeSource: 'feed' | 'default';
}

export interface ForecastUnitTransition {
  fromFeedId: string;
  toFeedId: string;
  estimatedDate: string;
  daysFromNow: number;
}

export interface ForecastPerUnit {
  unitId: string;
  unitName: string;
  unitCode: string;
  /**
   * Ünitenin BUGÜN kullandığı yem (gün-0 bandı). Eski hâl bu alana
   * simülasyonun SON gününün yemini yazıyordu (FARM-LOW-265): 120 günlük
   * ufukta iki band atlayan bir ünite için ekran "şu an B3 yiyor" diyordu,
   * oysa tank hâlâ B1'deydi — operatör yanlış pelleti sipariş ediyordu.
   */
  currentFeedId: string | null;
  /** Ufuk sonunda ulaşılan yem (simülasyonun SON bandı) — ayrı alan. */
  terminalFeedId: string | null;
  transitions: ForecastUnitTransition[];
}

export interface ForecastAlert {
  /**
   * `SITE_TRANSFER_NEEDED` (W6): havuz genelinde yem YETERLİ ama bu sitenin
   * yerel stoğu kendi tüketimini tedarik süresi boyunca karşılamıyor —
   * satın alma değil TAŞIMA ihtiyacıdır. Kapsama kararı tenant havuzundan
   * verildiği için (kullanıcı kararı 1) bu ihtiyaç aksi hâlde görünmez
   * kalırdı.
   */
  type:
    | 'STOCKOUT_FORECAST'
    | 'TRANSITION_COVERAGE_GAP'
    | 'REORDER_NOW'
    | 'SITE_TRANSFER_NEEDED';
  feedId: string;
  unitId?: string;
  /**
   * Tipe özgü BÜYÜKLÜK: stockout/reorder için kapsama günü, geçiş açığı için
   * eksik gün sayısı, taşıma ihtiyacı için yerel kapsama günü.
   */
  days: number;
  /**
   * Alarmın işaret ettiği GÜN İNDEKSİ (0 = bugün). Dilimleme bunu kullanır:
   * eski hâl `days`'i ufka karşı süzüyordu ve `TRANSITION_COVERAGE_GAP`'te
   * `days` bir gün indeksi DEĞİL eksik-gün büyüklüğüydü — 3 günlük bir açık
   * "gün 3" sayılıp 7 günlük pencerede hep görünüyor, 100 günlük açık ise
   * 90 günlük pencerede kayboluyordu (FARM-LOW-266).
   */
  atDay: number;
}

/**
 * Kapsamın YEM HAVUZU semantiği (W6, kullanıcı kararı 1).
 *
 * `TENANT`: kapsama/alarm kararının verildiği OTORİTE kapsam — tüm ünitelerin
 * tüketimi tenant havuzunun TOPLAM stoğuna karşı simüle edilir. Fiziksel
 * gerçek budur: deposu olmayan bir sitenin öğünü başka sitenin lotunu tüketir.
 *
 * `SITE`: BİLGİLENDİRİCİ kapsam — sitenin kendi üniteleri kendi deposuna karşı
 * gösterilir, ama alarm ÜRETMEZ (`SITE_TRANSFER_NEEDED` hariç). Aksi hâlde
 * aynı fiziksel kg hem site hem tenant kapsamında taahhüt edilir ve tedarik
 * uyarı penceresi sistematik olarak erirdi (FARM-HIGH-249).
 */
export type ForecastPoolScope = 'TENANT' | 'SITE';

/** Ölüm projeksiyonu varsayımı — çıktıda AÇIKÇA işaretlenir (K-17). */
export interface ForecastMortalityAssumption {
  applied: boolean;
  source: 'species_survival_rate' | 'none';
}

// ============================================================================
// ENTITY
// ============================================================================

@Entity('feeding_forecast_snapshots')
@Index(['tenantId', 'siteScopeKey'], { unique: true })
@Index(['computedAt'])
export class FeedingForecastSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  @Index()
  tenantId!: string;

  /** Site UUID'si ya da belgeli tenant-geneli fallback için 'tenant' (D-9). */
  @Column({ length: 100 })
  siteScopeKey!: string;

  /**
   * Kapsamın havuz semantiği (W6). `TENANT` satırı otoritedir; `SITE`
   * satırları bilgilendiricidir ve alarm üretmez.
   */
  @Column({ type: 'varchar', length: 8, default: 'SITE' })
  poolScope!: ForecastPoolScope;

  /** Hesaplanan MAKS ufuk (120) — sorgular bunun altına dilimler (K-10). */
  @Column({ type: 'int' })
  horizonDays!: number;

  @Column({ type: 'timestamptz' })
  computedAt!: Date;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  perFeed!: ForecastPerFeed[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  perUnit!: ForecastPerUnit[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  alerts!: ForecastAlert[];

  @Column({ type: 'jsonb', default: () => "'{}'" })
  mortalityAssumption!: ForecastMortalityAssumption;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @VersionColumn()
  version!: number;
}
