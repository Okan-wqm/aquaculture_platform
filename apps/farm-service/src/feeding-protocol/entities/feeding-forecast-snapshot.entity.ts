/**
 * FeedingForecastSnapshot — materyalize tükenme-tahmini satırı (Faz 7, K-10).
 *
 * 07:00 cron'u (ve D-6 event-driven yenileme) MAKS ufukta (120 gün) hesaplar
 * ve immutable generation exact-set'i olarak yazar;
 * `protocolFeedForecast` sorgusu ile mobil `warehouseSummary` AYNI satırı
 * okur ve istenen ufka DİLİMLER — sorgu anında yeniden hesap yoktur
 * (belirlenebilir bayatlık: `computedAt` UI'da tazelik göstergesidir).
 *
 * `siteScopeKey`: TENANT otoritesi için `tenant`, bilgi projeksiyonu için Site
 * UUID'sidir; `poolScope` bu semantiği fail-closed taşır. jsonb kolonları grafik-hazır
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
import type {
  FeedingForecastAlertV1,
  FeedingForecastBandPathV1,
  FeedingForecastMortalityProvenanceV1,
  FeedingForecastPoolScope,
} from '@aquaculture/feeding-contracts';

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
  /** Day-zero feed selected before the simulation advances biomass. */
  currentFeedId: FeedingForecastBandPathV1['currentFeedId'];
  /** Feed selected at the end of the simulated horizon. */
  terminalFeedId: FeedingForecastBandPathV1['terminalFeedId'];
  transitions: ForecastUnitTransition[];
}

export type ForecastAlert = FeedingForecastAlertV1;

/** TENANT is the coverage authority; SITE is an informational transfer view. */
export type ForecastPoolScope = FeedingForecastPoolScope;

/** Exact, per-unit provenance; a global boolean cannot represent mixed pools. */
export type ForecastMortalityAssumption = FeedingForecastMortalityProvenanceV1;

// ============================================================================
// ENTITY
// ============================================================================

@Entity('feeding_forecast_snapshots')
@Index(['tenantId', 'generationId', 'siteScopeKey'], { unique: true })
@Index(['computedAt'])
export class FeedingForecastSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  @Index()
  tenantId!: string;

  /** Tenant authority key or informational Site UUID. */
  @Column({ length: 100 })
  siteScopeKey!: string;

  /** Null is reserved for byte-preserved pre-generation quarantine rows. */
  @Column({ type: 'varchar', length: 8, nullable: true })
  poolScope!: ForecastPoolScope | null;

  @Column('uuid')
  generationId!: string;

  @Column({ type: 'char', length: 64 })
  payloadDigest!: string;

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
