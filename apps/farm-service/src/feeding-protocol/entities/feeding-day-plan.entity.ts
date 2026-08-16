/**
 * FeedingDayPlan — bir ünitenin BİR günlük yemleme planı (Faz 5 motoru).
 *
 * 06:00 üretimi `(tenantId, unitId, planDate)` unique anahtarı üzerinden
 * upsert-idempotenttir; gün içi biomass/sıcaklık/atama değişimleri henüz
 * beslenmemiş öğünleri yeniden hesaplar ve `recalcLog`'a işlenir (P-31 —
 * ölüm/hasat göz ardı edilmez). `snapshot` üretim anındaki TÜM hesap
 * girdilerini taşır: sıcaklık kaynağı AÇIKÇA etiketlidir (P-20) ve beklenen
 * FCR'ın hangi kaynaktan çözüldüğü `fcrResolvedSource` ile görünür (K-15).
 *
 * `planDate` SITE saat dilimindeki takvim günüdür (D-4) — öğünlerin
 * `scheduledAt` timestamptz değerleri üretim anında aynı dilimden maddileşir.
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
import { ObjectType, Field, ID, Int, Float, registerEnumType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { FEEDING_MEAL_QUANTITY_POLICY_V1 } from '@aquaculture/feeding-contracts';

import { FcrResolvedSource } from './feeding-protocol-v2.entity';
import { FEEDING_UNIT_TYPE_DATABASE_ENUM, FeedingUnitType } from './protocol-assignment.entity';
import { FeedingMeal } from './feeding-meal.entity';
import {
  DAY_PLAN_GROWTH_APPLICATION_MODE,
  type DayPlanGrowthApplicationMode,
} from '../day-plan-growth-reconciliation.authority';
import type { DayPlanResolutionV1 } from '../protocol-resolution.contract';
export type { DayPlanResolutionV1 } from '../protocol-resolution.contract';

// ============================================================================
// ENUMS
// ============================================================================

export enum FeedingDayPlanStatus {
  PLANNED = 'planned',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  /** Oruç/ilaç penceresi (D-12) veya operatör kararıyla gün atlandı. */
  SKIPPED = 'skipped',
  /** Ünite boşaldı / atama sonlandı — kalan öğünlerle birlikte iptal (P-31). */
  CANCELLED = 'cancelled',
}

registerEnumType(FeedingDayPlanStatus, {
  name: 'FeedingDayPlanStatus',
  description: 'Günlük yemleme planının yaşam döngüsü durumu (K-7 tam enum)',
});

// ============================================================================
// JSONB VALUE OBJECTS
// ============================================================================

/** Üretim anındaki hesap girdilerinin tamamı — plan nasıl hesaplandı sorusunun cevabı. */
export interface DayPlanSnapshot {
  avgWeightG: number;
  fishCount: number;
  biomassKg: number;
  /** Etkin su sıcaklığı; kaynak yoksa null + usingDefaultTemperature=true (P-20). */
  waterTempC: number | null;
  temperatureSource: 'sensor' | 'manual' | 'none';
  usingDefaultTemperature: boolean;
  bandIndex: number;
  feed: { id: string; code: string; name: string };
  baseRatePercent: number;
  tempMultiplier: number;
  /** rateAdjustmentPercent dahil nihai oran (K-18 formülü). */
  effectiveRatePercent: number;
  expectedFcr: number;
  fcrResolvedSource: FcrResolvedSource;
  /**
   * D-2 karışık-tank görünürlüğü (FARM-MEDIUM-231): band TankBatch.avgWeightG
   * adet-ağırlıklı ortalamasından seçilir; karışım ve yüksek CV görünür kalır.
   * B3 öncesi üretilen snapshot'larda alanlar yoktur (opsiyonel bundan).
   */
  mixedBatch?: boolean;
  weightCvPercent?: number | null;
}

/** Gün içi yeniden hesap gerekçe kaydı — sessiz recalc yok. */
export interface RecalcLogEntry {
  at: string; // ISO timestamp
  reason:
    | 'mortality'
    | 'harvest'
    | 'transfer'
    | 'grading'
    | 'cull'
    | 'temperature'
    | 'protocol_change'
    | 'assignment_change'
    | 'unplanned_feed'
    | 'manual_regenerate'
    /** Öğün finalize'ındaki per_meal büyümesi sonrası kalan öğün recalc'ı. */
    | 'meal_growth'
    /** correctMealPour düzeltmesi sonrası growth-delta recalc'ı (C-11). */
    | 'pour_correction'
    | 'manual_transition'
    /** Manuel kayıt miktar düzeltmesinin growth-delta recalc'ı. */
    | 'manual_feeding_correction';
  /** Yeniden hesap sonrası kalan öğünlerin toplam planlanan kg'ı. */
  remainingPlannedKg: number;
  biomassKg?: number;
  note?: string;
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType('FeedingDayPlan')
@Entity('feeding_day_plans')
@Index(['tenantId', 'unitId', 'planDate'], { unique: true })
@Index(['tenantId', 'planDate'])
@Index(['tenantId', 'planDate'], {
  where: `"growthApplicationMode" = 'daily' AND status IN ('in_progress', 'completed')`,
})
@Index(['assignmentId', 'planDate'])
@Index(['tenantId', 'siteId', 'planDate'])
export class FeedingDayPlan {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field(() => ID)
  @Column('uuid')
  @Index()
  tenantId!: string;

  @Field(() => ID)
  @Column('uuid')
  assignmentId!: string;

  @Field(() => ID)
  @Column('uuid')
  protocolId!: string;

  /** Equipment.id — kanonik ünite kimliği. */
  @Field(() => ID)
  @Column('uuid')
  unitId!: string;

  /** Site-scoped okumalar indeksli olsun diye denormalize (K-19). */
  @Field(() => ID)
  @Column('uuid')
  siteId!: string;

  @Field(() => FeedingUnitType)
  @Column({
    type: 'enum',
    enum: FeedingUnitType,
    enumName: FEEDING_UNIT_TYPE_DATABASE_ENUM,
  })
  unitType!: FeedingUnitType;

  @Field()
  @Column({ length: 200 })
  unitName!: string;

  @Field()
  @Column({ length: 50 })
  unitCode!: string;

  /** Site saat dilimindeki takvim günü (D-4). */
  @Field()
  @Column({ type: 'date' })
  planDate!: string;

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  snapshot!: DayPlanSnapshot;

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  resolution!: DayPlanResolutionV1;

  @Field(() => Float)
  @Column({
    type: 'numeric',
    precision: FEEDING_MEAL_QUANTITY_POLICY_V1.storagePrecision,
    scale: FEEDING_MEAL_QUANTITY_POLICY_V1.storageScale,
  })
  plannedTotalKg!: number;

  /** Plan-dışı manuel yemler (D-7) — gün-sonu varyansına dahil. */
  @Field(() => Float)
  @Column({
    type: 'numeric',
    precision: FEEDING_MEAL_QUANTITY_POLICY_V1.storagePrecision,
    scale: FEEDING_MEAL_QUANTITY_POLICY_V1.storageScale,
    default: 0,
  })
  unplannedActualKg!: number;

  @Field(() => Int)
  @Column({ type: 'int' })
  mealsPlanned!: number;

  @Field(() => FeedingDayPlanStatus)
  @Column({
    type: 'enum',
    enum: FeedingDayPlanStatus,
    default: FeedingDayPlanStatus.PLANNED,
  })
  status!: FeedingDayPlanStatus;

  /** Üretim anında dondurulan, versioned growth-policy sözleşmesi. */
  @Field(() => Int, { nullable: true })
  @Column({ type: 'smallint', nullable: true })
  growthPolicyVersion?: number;

  /** Protokol güncellense bile planın growth semantiği değişmez. */
  @Field(() => DAY_PLAN_GROWTH_APPLICATION_MODE, { nullable: true })
  @Column({ type: 'varchar', length: 16, nullable: true })
  growthApplicationMode?: DayPlanGrowthApplicationMode;

  /** Büyümeye çevrilmiş kümülatif gerçek yem miktarı. */
  @Field(() => Float)
  @Column({
    type: 'numeric',
    precision: FEEDING_MEAL_QUANTITY_POLICY_V1.storagePrecision,
    scale: FEEDING_MEAL_QUANTITY_POLICY_V1.storageScale,
    default: 0,
  })
  rollupAppliedKg!: number;

  /** Denetlenebilir kümülatif growth karşılığı. */
  @Field(() => Float)
  @Column({
    type: 'numeric',
    precision: FEEDING_MEAL_QUANTITY_POLICY_V1.storagePrecision,
    scale: FEEDING_MEAL_QUANTITY_POLICY_V1.storageScale,
    default: 0,
  })
  rollupGrowthKg!: number;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  rollupLastRunAt?: Date;

  /** @deprecated Kümülatif miktar mutabakatı için yalnız blue-green izi. */
  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  rollupAppliedAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  skipReason?: string;

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb', default: () => "'[]'" })
  recalcLog!: RecalcLogEntry[];

  /** Monotonic total; recalcLog is a bounded recent projection. */
  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  recalcCount!: number;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @VersionColumn()
  version!: number;

  /**
   * Planın öğünleri — KOLON DEĞİL (soft-ref disiplini K-16); feedingDayPlans
   * sorgusu TEK toplu okuma ile doldurur (plan başına sorgu yok).
   */
  @Field(() => [FeedingMeal], { nullable: true })
  meals?: FeedingMeal[];
}
