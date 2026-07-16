/**
 * FeedingMeal — day plan'ın tek öğünü; kısmi dökümler `pours[]`'ta (D-8).
 *
 * Bir öğün birden çok dökümle beslenebilir (balık iştahı kesilip devam
 * edebilir): her döküm `pours[]`'a eklenir ve bir `feeding_records` satırı
 * üretir (tekillik `(mealId, pourIndex)` unique partial index ile — P-05
 * invariantı döküm granülünde YAPISALDIR). Öğün operatör onayıyla veya pencere
 * kapanışında finalize olur; varyans finalize'da hesaplanır.
 *
 * `scheduledAt` timestamptz'dir — site saat diliminde üretim anında
 * maddileştirilir (D-4); 15dk pencere cron'u saat dilimi hesabı yapmadan
 * timestamptz karşılaştırır ve `windowNotifiedAt` ile idempotenttir.
 * `dayPlanId → feeding_records.mealId` yönü SOFT referanstır (K-16 —
 * retention bağımsızlığı; FK yok).
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

// ============================================================================
// ENUMS
// ============================================================================

export enum FeedingMealStatus {
  SCHEDULED = 'scheduled',
  FED = 'fed',
  /** En az bir döküm var ama öğün finalize edilmedi (D-8). */
  PARTIALLY_FED = 'partially_fed',
  SKIPPED = 'skipped',
  /** Penceresi geçti, hiç döküm yok — 05:30 süpürmesi işaretler (MealMissed). */
  MISSED = 'missed',
  CANCELLED = 'cancelled',
}

registerEnumType(FeedingMealStatus, {
  name: 'FeedingMealStatus',
  description: 'Öğün yaşam döngüsü durumu (K-7 + D-8 tam enum)',
});

// ============================================================================
// JSONB VALUE OBJECTS
// ============================================================================

/** Tek döküm — kümülatif actualKg'nin denetlenebilir parçası. */
export interface MealPour {
  pourIndex: number;
  kg: number;
  at: string; // ISO timestamp
  by: string; // userId
  feedingMethod?: string;
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType('FeedingMeal')
@Entity('feeding_meals')
@Index(['dayPlanId', 'mealIndex'], { unique: true })
@Index(['tenantId', 'dayPlanId'])
@Index(['tenantId', 'scheduledAt'], {
  where: `"status" = 'scheduled' AND "windowNotifiedAt" IS NULL`,
})
@Index(['tenantId', 'unitId', 'scheduledAt'])
export class FeedingMeal {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field(() => ID)
  @Column('uuid')
  @Index()
  tenantId!: string;

  @Field(() => ID)
  @Column('uuid')
  dayPlanId!: string;

  /** Denorm: meal board + 15dk cron sorguları day-plan join'i olmadan koşar (K-12). */
  @Field(() => ID)
  @Column('uuid')
  unitId!: string;

  @Field(() => ID)
  @Column('uuid')
  siteId!: string;

  @Field(() => Int)
  @Column({ type: 'int' })
  mealIndex!: number;

  /** Site saat diliminden maddileşmiş mutlak an (D-4). */
  @Field()
  @Column({ type: 'timestamptz' })
  scheduledAt!: Date;

  @Field(() => Float)
  @Column({ type: 'numeric', precision: 6, scale: 2 })
  percentOfDaily!: number;

  @Field(() => Float)
  @Column({ type: 'numeric', precision: 12, scale: 3 })
  plannedKg!: number;

  @Field(() => FeedingMealStatus)
  @Column({ type: 'enum', enum: FeedingMealStatus, default: FeedingMealStatus.SCHEDULED })
  status!: FeedingMealStatus;

  /** Kümülatif gerçekleşen kg (Σ pours[].kg). */
  @Field(() => Float)
  @Column({ type: 'numeric', precision: 12, scale: 3, default: 0 })
  actualKg!: number;

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb', default: () => "'[]'" })
  pours!: MealPour[];

  /** Finalize'da hesaplanır (D-8) — öncesinde null. */
  @Field(() => Float, { nullable: true })
  @Column({ type: 'numeric', precision: 12, scale: 3, nullable: true })
  varianceKg?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'numeric', precision: 7, scale: 2, nullable: true })
  variancePercent?: number;

  /** Öğünün yemi (band geçişi/ilaç penceresi kalan öğünlerde değiştirebilir). */
  @Field(() => ID)
  @Column('uuid')
  feedId!: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  fedAt?: Date;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  fedBy?: string;

  /** P-24: kayıt yolundan düşürülmez — hem burada hem FeedingRecord'da persist. */
  @Field({ nullable: true })
  @Column({ length: 50, nullable: true })
  feedingMethod?: string;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  recalculatedAt?: Date;

  /** MealWindowUpcoming bildirimi idempotency damgası. */
  @Column({ type: 'timestamptz', nullable: true })
  windowNotifiedAt?: Date;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @VersionColumn()
  version!: number;
}
