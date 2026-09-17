/**
 * Batch Entity - Üretim Partileri
 *
 * Akuakültür tesislerinde yetiştirilen canlı grupları temsil eder.
 * Bir batch:
 * - Aynı türden oluşur (speciesId)
 * - Birden fazla tank/pond'da bulunabilir (BatchLocation M2M)
 * - Dual weight tracking (theoretical vs actual)
 * - FCR takibi
 *
 * @module Batch
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  VersionColumn,
  ManyToOne,
  OneToMany,
  JoinColumn,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { DecimalScalar } from '@aquaculture/backend-common/graphql';
import { ObjectType, Field, ID, Float, Int, Directive } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
// Type-only imports to avoid circular dependency at runtime
import type { Species } from '../../species/entities/species.entity';
import type { BatchDocument } from './batch-document.entity';

// IP-3: Enums and interfaces extracted to batch.types.ts (keeps entity under 500 lines).
// Import for local use, then re-export for backward compatibility.
// All existing `import { BatchStatus } from '../entities/batch.entity'` continue to work.
import {
  BatchStatus,
  BatchInputType,
  ArrivalMethod,
  BatchType,
  OPERATIONAL_BATCH_STATUSES,
} from './batch.types';
import type {
  BatchWeight,
  BatchFCR,
  BatchFeedingSummary,
  BatchGrowthMetrics,
  BatchMortalitySummary,
} from './batch.types';

export { BatchStatus, BatchInputType, ArrivalMethod, BatchType, OPERATIONAL_BATCH_STATUSES };
export type {
  BatchWeight,
  BatchFCR,
  BatchFeedingSummary,
  BatchGrowthMetrics,
  BatchMortalitySummary,
};

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Directive('@key(fields: "id")')
@Entity('batches_v2')
@Index(['tenantId', 'batchNumber'], { unique: true })
@Index(['tenantId', 'speciesId'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'stockedAt'])
@Index(['tenantId', 'isActive'])
@Index(['tenantId', 'batchType'])
export class Batch {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  // -------------------------------------------------------------------------
  // TEMEL BİLGİLER
  // -------------------------------------------------------------------------

  @Field()
  @Column({ length: 50 })
  batchNumber!: string; // B-2024-00001

  @Field({ nullable: true })
  @Column({ length: 255, nullable: true })
  name?: string; // Opsiyonel görüntüleme adı

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  // -------------------------------------------------------------------------
  // TÜR BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  speciesId!: string;

  @ManyToOne('Species', { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'speciesId' })
  species?: Species;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  strain?: string; // Irk/çeşit

  // -------------------------------------------------------------------------
  // BESLEME PROTOKOLÜ — the batch does NOT carry one.
  //
  // A `protocolId` column used to live here, documented as "the protocol is
  // bound to the batch and follows the fish". Neither half was true: it
  // referenced the v1 `feeding_protocols` table, and NOTHING in the repo ever
  // wrote it — no create handler, no update handler, no input DTO. Feeding
  // authority is UNIT-scoped: `ProtocolAssignment.unitId` (an `Equipment.id`)
  // holds at most one active row per unit, enforced by the partial unique index
  // `(tenantId, unitId) WHERE status = 'active'`. That also matches the domain:
  // the tank owns weight, band, feed type and rate; batch identity is kept for
  // TRACEABILITY. Resolve a tank's protocol through
  // `UnitProtocolResolverService`, never through the batch.
  // -------------------------------------------------------------------------

  @Field(() => BatchInputType)
  @Column({
    type: 'enum',
    enum: BatchInputType,
    default: BatchInputType.FRY,
  })
  inputType!: BatchInputType;

  // -------------------------------------------------------------------------
  // BATCH TİPİ (Production vs Cleaner Fish)
  // -------------------------------------------------------------------------

  @Field(() => BatchType)
  @Column({
    type: 'enum',
    enum: BatchType,
    default: BatchType.PRODUCTION,
  })
  batchType!: BatchType;

  /**
   * Cleaner fish kaynak tipi
   * 'farmed' - çiftlik üretimi
   * 'wild_caught' - doğadan yakalanan
   */
  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 50, nullable: true })
  sourceType?: string;

  /**
   * Cleaner fish kaynak lokasyonu
   * Yakalama veya tedarik noktası
   */
  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  sourceLocation?: string;

  // -------------------------------------------------------------------------
  // MİKTAR TAKİBİ
  // -------------------------------------------------------------------------

  @Field(() => Int)
  @Column({ type: 'int' })
  initialQuantity!: number; // Başlangıç adedi

  @Field(() => Int)
  @Column({ type: 'int' })
  currentQuantity!: number; // Mevcut adet (mortality düşülmüş)

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  totalMortality!: number; // Toplam ölüm adedi

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  harvestedQuantity?: number; // Hasat edilen adet

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  cullCount!: number; // Ayıklama sayısı (cull)

  @Field(() => Float)
  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: new DecimalTransformer(),
  })
  totalFeedConsumed!: number; // Toplam yem tüketimi (kg)

  @Field(() => Float, {
    deprecationReason: 'Use totalFeedCostDecimal (exact decimal string, ADR-0004).',
  })
  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    default: 0,
    transformer: new DecimalTransformer(),
  })
  totalFeedCost!: number; // Toplam yem maliyeti

  /** Exact-decimal wire form of `totalFeedCost` (ADR-0004 / DATA-MEDIUM-009). */
  @Field(() => DecimalScalar)
  get totalFeedCostDecimal(): number {
    return this.totalFeedCost;
  }

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  retentionRate?: number; // Tutma oranı (%) - mortality + cull dahil

  @Field(() => Float, { nullable: true })
  @Column({
    type: 'decimal',
    precision: 5,
    scale: 4,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  sgr?: number; // Spesifik büyüme oranı (SGR)

  @Field(() => Float, {
    nullable: true,
    deprecationReason: 'Use costPerKgDecimal (exact decimal string, ADR-0004).',
  })
  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  costPerKg?: number; // kg başına maliyet

  /** Exact-decimal wire form of `costPerKg` (ADR-0004 / DATA-MEDIUM-009). */
  @Field(() => DecimalScalar, { nullable: true })
  get costPerKgDecimal(): number | null {
    return this.costPerKg ?? null;
  }

  // -------------------------------------------------------------------------
  // AĞIRLIK TAKİBİ - ÇİFT KAYIT
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  weight!: BatchWeight;

  // -------------------------------------------------------------------------
  // FCR TAKİBİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  fcr!: BatchFCR;

  // -------------------------------------------------------------------------
  // YEMLEME ÖZETİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  feedingSummary!: BatchFeedingSummary;

  // -------------------------------------------------------------------------
  // BÜYÜME METRİKLERİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  growthMetrics!: BatchGrowthMetrics;

  // -------------------------------------------------------------------------
  // MORTALITY ÖZETİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  mortalitySummary!: BatchMortalitySummary;

  // -------------------------------------------------------------------------
  // TARİHLER
  // -------------------------------------------------------------------------

  @Field()
  @Column({ type: 'date' })
  stockedAt!: Date; // Stoklama tarihi

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  expectedHarvestDate?: Date;

  @Field({ nullable: true })
  @Column({ type: 'date', nullable: true })
  actualHarvestDate?: Date;

  // -------------------------------------------------------------------------
  // TEDARİKÇİ BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  supplierId?: string;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  supplierBatchNumber?: string; // Tedarikçi parti numarası

  @Field(() => Float, {
    nullable: true,
    deprecationReason: 'Use purchaseCostDecimal (exact decimal string, ADR-0004).',
  })
  @Column({
    type: 'decimal',
    precision: 15,
    scale: 2,
    nullable: true,
    transformer: new DecimalTransformer(),
  })
  purchaseCost?: number; // Satın alma maliyeti

  /** Exact-decimal wire form of `purchaseCost` (ADR-0004 / DATA-MEDIUM-009). */
  @Field(() => DecimalScalar, { nullable: true })
  get purchaseCostDecimal(): number | null {
    return this.purchaseCost ?? null;
  }

  @Field({ nullable: true })
  @Column({ length: 3, nullable: true })
  currency?: string;

  // -------------------------------------------------------------------------
  // ULAŞIM BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => ArrivalMethod, { nullable: true })
  @Column({
    type: 'enum',
    enum: ArrivalMethod,
    nullable: true,
  })
  arrivalMethod?: ArrivalMethod;

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field(() => BatchStatus)
  @Column({
    type: 'enum',
    enum: BatchStatus,
    default: BatchStatus.QUARANTINE,
  })
  status!: BatchStatus;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  statusChangedAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  statusReason?: string;

  @Field()
  @Column({ default: true })
  @Index()
  isActive!: boolean;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  updatedBy?: string;

  @VersionColumn()
  version!: number;

  // -------------------------------------------------------------------------
  // İLİŞKİLER
  // -------------------------------------------------------------------------

  @OneToMany('BatchDocument', 'batch')
  documents?: BatchDocument[];

  // @OneToMany(() => BatchLocation, (bl) => bl.batch)
  // locations?: BatchLocation[];

  // @OneToMany(() => MortalityRecord, (mr) => mr.batch)
  // mortalityRecords?: MortalityRecord[];

  // @OneToMany(() => FeedingRecord, (fr) => fr.batch)
  // feedingRecords?: FeedingRecord[];

  // @OneToMany(() => GrowthMeasurement, (gm) => gm.batch)
  // growthMeasurements?: GrowthMeasurement[];

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // IP-3: Domain logic extracted to BatchDomainService for testability.
  // Entity methods delegate to keep backward compatibility with existing
  // callers (resolvers, handlers). New code should inject BatchDomainService.
  // -------------------------------------------------------------------------

  /** @see BatchDomainService.getCurrentBiomass */
  getCurrentBiomass(): number {
    // WHY: Current biomass is DERIVED from the live count, not read from the
    // stored weight.actual.totalBiomass snapshot. avgWeight only changes at a
    // sampling event, whereas currentQuantity is atomically decremented under
    // pessimistic_write by every removal handler (mortality, cull, harvest).
    // Deriving qty × avgWeight guarantees the displayed biomass and the
    // ledger-based FCR can never diverge from the actual live count — the
    // stored totalBiomass would go stale the moment any removal happens.
    // WHAT: kg = currentQuantity × effectiveAvgWeightG / 1000.
    const avgWeightG = this.getCurrentAvgWeight();
    return (this.currentQuantity * avgWeightG) / 1000;
  }

  /** @see BatchDomainService.getCurrentAvgWeight */
  getCurrentAvgWeight(): number {
    if (this.weight?.actual?.avgWeight) return this.weight.actual.avgWeight;
    if (this.weight?.theoretical?.avgWeight) return this.weight.theoretical.avgWeight;
    return this.weight?.initial?.avgWeight || 0;
  }

  getMortalityRate(): number {
    if (this.initialQuantity <= 0) return 0;
    return (this.totalMortality / this.initialQuantity) * 100;
  }

  getSurvivalRate(): number {
    if (this.initialQuantity <= 0) return 100;
    return ((this.initialQuantity - this.totalMortality) / this.initialQuantity) * 100;
  }

  getRetentionRate(): number {
    if (this.initialQuantity <= 0) return 100;
    return (this.currentQuantity / this.initialQuantity) * 100;
  }

  // FCR authority removed from the entity (Tier-1 one-SSoT consolidation).
  // The single FCR calculator is FcrCalculationService.calculateCumulativeFCR,
  // which reads net-exited biomass from the TankOperation ledger instead of the
  // naive `current − initial + mortalityBiomass` weight-gain estimate this
  // method used. That ledger-aware formula is the only one that does not
  // overstate FCR by undercounting the growth of biomass that left the system.

  calculateSGR(): number {
    const initialWeight = this.weight?.initial?.avgWeight || 0;
    const currentWeight = this.getCurrentAvgWeight();
    const days = this.getDaysInProduction();
    if (initialWeight <= 0 || currentWeight <= 0 || days <= 0) return 0;
    return ((Math.log(currentWeight) - Math.log(initialWeight)) / days) * 100;
  }

  getDaysInProduction(): number {
    const stockDate = new Date(this.stockedAt);
    const endDate = this.actualHarvestDate ? new Date(this.actualHarvestDate) : new Date();
    return Math.ceil(Math.abs(endDate.getTime() - stockDate.getTime()) / (1000 * 60 * 60 * 24));
  }

  canTransitionTo(newStatus: BatchStatus): boolean {
    const transitions: Record<BatchStatus, BatchStatus[]> = {
      [BatchStatus.QUARANTINE]: [BatchStatus.ACTIVE, BatchStatus.FAILED],
      [BatchStatus.ACTIVE]: [BatchStatus.GROWING, BatchStatus.TRANSFERRED, BatchStatus.FAILED],
      [BatchStatus.GROWING]: [BatchStatus.PRE_HARVEST, BatchStatus.TRANSFERRED, BatchStatus.FAILED],
      [BatchStatus.PRE_HARVEST]: [BatchStatus.HARVESTING, BatchStatus.GROWING, BatchStatus.FAILED],
      [BatchStatus.HARVESTING]: [BatchStatus.HARVESTED, BatchStatus.FAILED],
      [BatchStatus.HARVESTED]: [BatchStatus.CLOSED],
      [BatchStatus.TRANSFERRED]: [BatchStatus.CLOSED],
      [BatchStatus.FAILED]: [BatchStatus.CLOSED],
      [BatchStatus.CLOSED]: [],
    };
    return transitions[this.status]?.includes(newStatus) ?? false;
  }

  isOperational(): boolean {
    // WHY the set is not inlined here: the same four statuses gate feeding
    // (BatchDomainService.assertFeedable) and the running-FCR sweep scope
    // (LIVE_BATCH_FCR_SCOPE_SQL). Three copies drifted once already — the SQL
    // copy stopped at ('ACTIVE','GROWING'), so PRE_HARVEST/HARVESTING batches
    // could be fed but never FCR-alerted. One constant, no drift.
    return OPERATIONAL_BATCH_STATUSES.includes(this.status);
  }

  /**
   * FARM-CRITICAL-050 — the states in which the batch still holds LIVE, physically
   * present stock, so recording a death (mortality) or a cull is legitimate.
   *
   * WHY this is NOT isOperational(): isOperational() excludes QUARANTINE, but
   * quarantined fish are alive and do die / get culled — gating mortality/cull on
   * isOperational() alone would reject those legitimate removals and leave the
   * batch count inflated. So stock-mutable = operational OR quarantine. The
   * terminal states (HARVESTED / TRANSFERRED / FAILED / CLOSED) are excluded: the
   * cycle is closed and any further removal corrupts closed-cycle inventory.
   */
  isStockMutable(): boolean {
    return this.isOperational() || this.status === BatchStatus.QUARANTINE;
  }

  isCleanerFishBatch(): boolean {
    return this.batchType === BatchType.CLEANER_FISH;
  }
  isProductionBatch(): boolean {
    return this.batchType === BatchType.PRODUCTION;
  }
}
