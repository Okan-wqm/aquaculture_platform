/**
 * ProtocolAssignment — Protokolün üniteye (tank/pond/cage) atanması
 *
 * Ünite kimliği `Equipment.id`'dir (plan §1.2 kararı): TankBatch.tankId,
 * eski FeedingProgramTank.equipmentId ve site-yetkilendirme sink'i
 * (`resolveTankSiteId`) zaten bu kimliği kullanır — kimlik migration'ı
 * gerektirmez ve SEC-HIGH-051 deseni değişmeden çalışır.
 *
 * Bir ünitede aynı anda TEK aktif atama olabilir (partial unique index).
 * Operasyonel override'lar (vardiya kaydırma, öğün sayısı, oran ayarı,
 * ünite-bazlı beklenen-FCR override'ları — R11) ve oruç/ilaçlı-yem
 * pencereleri (D-12) atamada yaşar; protokol şablonu değişmez.
 *
 * Sıcaklık sensörü ataması BURADA DEĞİLDİR — mevcut
 * `equipment.temperatureSensorId` kolonu tek bağlama yeridir (C-3).
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
import { ObjectType, Field, ID, Int, registerEnumType } from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';

// ============================================================================
// ENUMS
// ============================================================================

export enum FeedingUnitType {
  TANK = 'tank',
  POND = 'pond',
  CAGE = 'cage',
}

registerEnumType(FeedingUnitType, {
  name: 'FeedingUnitType',
  description: 'Yemleme ünitesi türü (fiziksel yapı)',
});

export enum ProtocolAssignmentStatus {
  ACTIVE = 'active',
  /** Duraklatıldı — boş ünite (otomatik) veya operatör kararı; plan üretilmez. */
  PAUSED = 'paused',
  /** Sonlandı — tarihsel kayıt (traceability bu geçmişi okur, C-4). */
  ENDED = 'ended',
}

registerEnumType(ProtocolAssignmentStatus, {
  name: 'ProtocolAssignmentStatus',
  description: 'Protokol atamasının yaşam döngüsü durumu',
});

// ============================================================================
// JSONB VALUE OBJECTS
// ============================================================================

/** Ünite-bazlı beklenen-FCR override'ı (R11): protokol bandındaki varsayılanı ezer. */
export interface FcrOverride {
  feedId: string;
  expectedFcr: number;
}

/** Atama override'ları — yalnız operasyonel ayarlar; biyoloji protokolde kalır. */
export interface AssignmentOverrides {
  /** Tüm öğün saatlerini kaydırır (vardiya); EN SON uygulanır (K-18/D-15). */
  mealTimeOffsetMinutes?: number;
  /** Öğün SAYISINI ezer; saatler protokol penceresine eşit aralıkla türetilir (D-15). */
  mealsPerDayOverride?: number;
  /** Hesaplanan orana ±% ayar (veteriner/operasyon direktifi). */
  rateAdjustmentPercent?: number;
  /** Ünite-bazlı beklenen-FCR override'ları — çözüm sırasında her kaynaktan önce gelir (§3). */
  fcrOverrides?: FcrOverride[];
  /**
   * Kaçırılan öğün telafi yüzdesi — protokol ayarını bu ÜNİTE için ezer
   * (W5). Tanımsız = protokol ayarı; protokolde de tanımsız = 0 (dağıtım yok).
   */
  missedMealCatchUpPercent?: number;
}

/** Oruç / ilaçlı-yem penceresi (D-12) — generator pencere içinde skipped plan üretir. */
export interface AssignmentSuspension {
  /** ISO tarih (dahil). */
  from: string;
  /** ISO tarih (dahil). */
  to: string;
  type: 'fasting' | 'medication';
  reason: string;
  /** type === 'medication' iken pencere boyunca öğünlerin yemi bu ürüne döner. */
  medicatedFeedId?: string;
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType('ProtocolAssignment')
@Entity('feeding_protocol_assignments')
// Ünite başına tek CANLI atama (active + paused). Yalnız 'active'i kapsayan
// eski kısıt paused birikimine izin veriyordu: sahte UnfedUnitDetected akışı,
// resume'da ham duplicate-key 500'ü ve aktivasyon migration'ında index ihlali
// (FARM-MEDIUM-256/250a). Migration: 1808800000000.
@Index(['tenantId', 'unitId'], { unique: true, where: `"status" <> 'ended'` })
@Index(['tenantId', 'protocolId'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'unitId', 'effectiveFrom'])
export class ProtocolAssignment {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field(() => ID)
  @Column('uuid')
  @Index()
  tenantId!: string;

  /** Equipment.id — kanonik ünite kimliği. */
  @Field(() => ID)
  @Column('uuid')
  unitId!: string;

  @Field(() => FeedingUnitType)
  // Bu tablo tipin SAHİBİ; TypeORM aynı adı zaten türetirdi, ama adı açık
  // yazmak paylaşımı görünür kılar — `feeding_day_plans.unitType` de bu tipi
  // kullanıyor ve orada türetme YANLIŞ ada gidiyordu.
  @Column({
    type: 'enum',
    enum: FeedingUnitType,
    enumName: 'feeding_protocol_assignments_unittype_enum',
  })
  unitType!: FeedingUnitType;

  /** Denormalize görünüm alanları (liste/timeline UI'ları — repo deseni). */
  @Field()
  @Column({ length: 200 })
  unitName!: string;

  @Field()
  @Column({ length: 50 })
  unitCode!: string;

  /** Site-scoped okumalar indeksli olsun diye denormalize (K-19 emsali). */
  @Field(() => ID)
  @Column('uuid')
  @Index()
  siteId!: string;

  @Field(() => ID)
  @Column('uuid')
  protocolId!: string;

  @Field(() => ProtocolAssignmentStatus)
  @Column({
    type: 'enum',
    enum: ProtocolAssignmentStatus,
    default: ProtocolAssignmentStatus.ACTIVE,
  })
  status!: ProtocolAssignmentStatus;

  @Field()
  @Column({ type: 'date' })
  effectiveFrom!: Date;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  endedAt?: Date;

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb', default: () => "'{}'" })
  overrides!: AssignmentOverrides;

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb', default: () => "'[]'" })
  suspensions!: AssignmentSuspension[];

  // ── Geçiş durumu (eski FeedingProgramTank.currentFeed* alanlarının yerine) ──

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  currentFeedId?: string;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  currentBandIndex?: number;

  /**
   * Operatörün ELLE sabitlediği band (FARM-MEDIUM-251) — `currentBandIndex`'ten
   * AYRI bir olgudur.
   *
   * `currentBandIndex` "şu an hangi banddayız" demektir ve histerezisin
   * çapasıdır; bu alan "bir insan açıkça şu bandı seçti" demektir. İkisi tek
   * alanda tutulduğunda manuel geçiş kendi transaction'ında geri alınıyordu:
   * çözücü çapayı yalnız histerezis çapası sayıp ağırlık bandına dönüyor,
   * operatörün seçtiği yemi hem atamadan hem kalan öğünlerden siliyordu.
   *
   * Yaşam süresi: balık sabitlenen bandın ÜSTÜNE çıkana kadar geçerli
   * (`weightResolved.index > manualBandIndex`); o noktada otomatik geçiş
   * operatörün seçimini geçersiz kılar ve pin temizlenir. Balık küçülürse pin
   * KORUNUR — açık bir insan kararını, ağırlık düştü diye iptal etmek için bir
   * gerekçe yoktur.
   */
  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  manualBandIndex?: number;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  lastTransitionAt?: Date;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  totalTransitions!: number;

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
}
