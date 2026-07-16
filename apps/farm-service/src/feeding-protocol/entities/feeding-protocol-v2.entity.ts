/**
 * FeedingProtocolV2 — Birleşik Yemleme Protokolü (SSoT)
 *
 * Feeding-protocol SSoT döngüsünün hedef modeli: v1'de ÜÇ çakışan mekanizmaya
 * bölünmüş olan yemleme bilgisi (FeedingProtocol şablonu / FeedingProgram tank
 * ataması / FeedingTable projeksiyonu) tek varlıkta birleşir. Bir protokol,
 * ağırlık bandı başına HEM yem ürününü HEM oranı HEM beklenen FCR'ı HEM öğün
 * planını taşır; tank/pond/cage'e `ProtocolAssignment` ile atanır.
 *
 * Bantlar YALNIZ gram cinsindendir (v1'in gram/kg birim belirsizliği ölür).
 * Doğrulama kuralları `services/protocol-validation.service.ts`'te (tek
 * doğrulama SSoT'si, saf + test-first); band→oran çözümü
 * `services/protocol-rate.service.ts`'te yaşar.
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
import { ObjectType, Field, ID, registerEnumType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';

// ============================================================================
// CONSTANTS (DoS koruması + biyolojik sınırlar — validation servisi kullanır)
// ============================================================================

export const MAX_PROTOCOL_BANDS = 50;
export const MAX_FCR_TEMPERATURES = 20;
export const MAX_FCR_WEIGHTS = 30;
export const MAX_MEALS_PER_DAY = 24;
export const MIN_EXPECTED_FCR = 0.5;
export const MAX_EXPECTED_FCR = 5;
export const MAX_FEEDING_RATE_PERCENT = 15;
export const MIN_TEMP_MULTIPLIER = 0.1;
export const MAX_TEMP_MULTIPLIER = 2;

// ============================================================================
// ENUMS
// ============================================================================

export enum FeedingProtocolStatus {
  /** Taslak — plan üretmez (migration'dan gelen çözümlenmemiş protokoller dahil). */
  DRAFT = 'draft',
  /** Aktif — atamalar plan üretebilir. */
  ACTIVE = 'active',
  /** Arşiv — yeni atama yapılamaz; mevcut atamalar otomatik pause edilir. */
  ARCHIVED = 'archived',
}

registerEnumType(FeedingProtocolStatus, {
  name: 'FeedingProtocolStatus',
  description: 'Birleşik yemleme protokolü yaşam döngüsü durumu',
});

/** Snapshot'larda kullanılan FCR kaynağı provenansı (ayar `fcrSource` ile karışmaz — K-15). */
export enum FcrResolvedSource {
  OVERRIDE = 'override',
  BAND = 'band',
  MATRIX = 'matrix',
  FEED = 'feed',
}

registerEnumType(FcrResolvedSource, {
  name: 'FcrResolvedSource',
  description: 'Beklenen FCR değerinin hangi kaynaktan çözüldüğü (provenans)',
});

/** Protokol ayarı: beklenen FCR hangi kaynaktan çözülsün. */
export enum ProtocolFcrSource {
  BAND = 'band',
  MATRIX = 'matrix',
  FEED = 'feed',
}

registerEnumType(ProtocolFcrSource, {
  name: 'ProtocolFcrSource',
  description: 'Protokolün beklenen-FCR çözüm kaynağı ayarı',
});

// ============================================================================
// JSONB VALUE OBJECTS
// ============================================================================

/** Gün içi tek öğün girdisi. */
export interface MealScheduleEntry {
  /** HH:mm — site saat diliminde yorumlanır (D-4), üretim anında timestamptz'e maddileşir. */
  time: string;
  /** Günlük toplamın yüzdesi; entries toplamı 100 ± 0.01. */
  percentOfDaily: number;
}

/** Öğün planı — protokol default'u veya band override'ı. */
export interface MealSchedule {
  mealsPerDay: number;
  /** length === mealsPerDay; saatler kesin artan. */
  entries: MealScheduleEntry[];
}

/**
 * Protokolün kalbi: bir ağırlık bandı = yem ürünü + oran + beklenen FCR +
 * (opsiyonel) öğün planı. Bantlar yarı-açık [minWeightG, maxWeightG) yorumlanır,
 * kenarlarda clamp edilir; boşluk/örtüşme validation servisince reddedilir.
 */
export interface ProtocolBand {
  minWeightG: number;
  maxWeightG: number;
  feedId: string;
  feedCode: string;
  feedName: string;
  /** Günlük yem = biomass × feedingRatePercent/100 (sıcaklık çarpanı öncesi taban). */
  feedingRatePercent: number;
  /** Band varsayılanı — ünite ataması `fcrOverrides` ile override edebilir (R11). */
  expectedFcr: number;
  mealSchedule?: MealSchedule;
  notes?: string;
}

/** Sıcaklık bandı → oran çarpanı. Bantlar çakışamaz; okuma yoksa çarpan 1.0 (P-20). */
export interface TemperatureAdjustment {
  minC: number;
  maxC: number;
  rateMultiplier: number;
}

/** Sıcaklık × Ağırlık beklenen-FCR matrisi (v1 FeedingProgram.fcrTable'ın taşınmış hali). */
export interface FcrMatrix {
  temperatures: number[];
  weights: number[];
  /** fcrValues[tempIndex][weightIndex] */
  fcrValues: number[][];
}

/** Protokol davranış ayarları. */
export interface ProtocolSettings {
  /** Ağırlık banda girince yem geçişi otomatik yürütülsün mü. */
  autoTransition: boolean;
  /** Geçiş histerezisi (gram) — band sınırında ileri-geri salınımı önler. */
  transitionBufferG: number;
  /** FCR büyümesi öğün başına mı gün-sonu rollup'ta mı uygulanır. */
  growthApplicationMode: 'per_meal' | 'daily';
  /** Öğün varyansı bu eşiğin altına düşünce MealUnderfed alarmı (negatif yüzde eşiği). */
  underfeedAlertThresholdPercent: number;
  /** Beklenen FCR çözüm kaynağı (override her zaman öncelikli — §3). */
  fcrSource: ProtocolFcrSource;
  /** Otomasyon kancası: yemleme öncesi minimum çözünmüş oksijen (MealWindowUpcoming taşır). */
  minDissolvedOxygen?: number;
  adjustments?: {
    lowOxygenReduction?: number;
    postStressReduction?: number;
    preMedicationFastingHours?: number;
  };
  minFeedingRatePercent?: number;
  maxFeedingRatePercent?: number;
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType('FeedingProtocolV2')
@Entity('feeding_protocols_v2')
@Index(['tenantId', 'name'], { unique: true })
@Index(['tenantId', 'status'])
@Index(['tenantId', 'speciesId'])
@Index(['tenantId', 'isDeleted'])
export class FeedingProtocolV2 {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field(() => ID)
  @Column('uuid')
  @Index()
  tenantId!: string;

  @Field()
  @Column({ length: 200 })
  name!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  /** FK species (soft ref — v1 serbest metin türü normalize edildi). Null = tür-bağımsız protokol. */
  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  speciesId?: string;

  /** Denormalize görünüm adı (liste UI'ları için). */
  @Field({ nullable: true })
  @Column({ length: 200, nullable: true })
  speciesName?: string;

  @Field(() => FeedingProtocolStatus)
  @Column({ type: 'enum', enum: FeedingProtocolStatus, default: FeedingProtocolStatus.DRAFT })
  status!: FeedingProtocolStatus;

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  bands!: ProtocolBand[];

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  temperatureAdjustments?: TemperatureAdjustment[];

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  defaultMealSchedule!: MealSchedule;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  fcrMatrix?: FcrMatrix;

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  settings!: ProtocolSettings;

  @Field()
  @Column({ default: false })
  isDefault!: boolean;

  /** Migration'dan DRAFT gelen protokoller için operatöre gösterilen açıklama. */
  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  migrationNote?: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  updatedBy?: string;

  @VersionColumn()
  version!: number;

  @Column({ default: false })
  isDeleted!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;
}
