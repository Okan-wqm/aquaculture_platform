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
  currentFeedId: string | null;
  transitions: ForecastUnitTransition[];
}

export interface ForecastAlert {
  type: 'STOCKOUT_FORECAST' | 'TRANSITION_COVERAGE_GAP' | 'REORDER_NOW';
  feedId: string;
  unitId?: string;
  days: number;
}

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
