/**
 * FeedingRecordAttributionQuarantine — attribute edilemeyen tarihsel yem kaydı
 * (W0, FARM-HIGH-240).
 *
 * `1806600000000` backfill'i legacy execution'ları `feeding_records`'a
 * taşırken batch'i tankın ANLIK doluluğundan çözüyordu. `1806800000000`
 * attribution'ı `batch_locations` (occupancy geçmişi) üzerinden yeniden
 * çözer; ünitenin occupancy geçmişi VAR ama yemleme tarihini kapsayan satır
 * YOKSA kayıt gerçekten hiçbir batch'e bağlanamaz.
 *
 * Böyle satırlar SİLİNMEZ — buraya taşınır: yanlış batch'e yazılmış bir yem
 * kaydı FCR'ı biyolojik olarak imkânsız değerlere taşır, ama veriyi yok etmek
 * de incelemeyi ve olası geri alımı imkânsız kılar. Karantina ikisinin de
 * önüne geçer: `feeding_records` yalnız attribute edilebilir satırları taşır
 * (FCR/finans okumaları değişmeden doğrulanır), kayıt ise durur.
 *
 * Tenant-scoped tablo — `schema:` YOK (search_path `tenant_<uuid>`'ye yönlendirir).
 *
 * @module Feeding/Entities
 */
import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, Index } from 'typeorm';

@Entity('feeding_record_attribution_quarantine')
@Index(['tenantId', 'feedingRecordId'])
export class FeedingRecordAttributionQuarantine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid')
  tenantId!: string;

  /** Karantinaya alınan `feeding_records` satırının id'si (soft ref). */
  @Column('uuid')
  feedingRecordId!: string;

  /** Satırın karantina anındaki (güvenilmeyen) batch attribution'ı. */
  @Column('uuid')
  batchId!: string;

  @Column('uuid', { nullable: true })
  tankId?: string;

  @Column({ type: 'date' })
  feedingDate!: string;

  @Column({ type: 'numeric', precision: 10, scale: 3 })
  actualAmount!: number;

  @Column({ type: 'numeric', precision: 12, scale: 2, nullable: true })
  feedCost?: number;

  @Column({ type: 'varchar', length: 3, nullable: true })
  currency?: string;

  @Column('uuid', { nullable: true })
  feedId?: string;

  @Column('uuid', { nullable: true })
  sourceExecutionId?: string;

  /** Neden attribute edilemedi (şimdilik tek değer: no_occupancy_on_feeding_date). */
  @Column({ type: 'varchar', length: 64 })
  reason!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  quarantinedAt!: Date;
}
