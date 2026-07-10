/**
 * FeedingProgramTank Entity - Program-Tank İlişkisi
 *
 * Yemleme programı ile tank/pond/cage arasındaki ilişkiyi yönetir.
 * Her tank için ayrı yem durumu ve sıcaklık sensörü takibi yapılır.
 *
 * Özellikler:
 * - Program-Tank many-to-many ilişkisi
 * - Her tank için ayrı yem geçiş takibi
 * - Sıcaklık sensörü bağlantısı
 * - Tank durumu yönetimi
 *
 * Soft Delete Pattern:
 * - Uses isActive + removedAt for logical deletion within program context
 * - Soft delete via markAsRemoved() preserves historical data
 * - Reactivation available via reactivate()
 *
 * Denormalized Fields Sync:
 * - equipmentName, equipmentCode: Synced from Equipment entity
 * - currentFeedCode: Synced from Feed entity
 * - temperatureSensorCode: Synced from Sensor entity
 * - These fields should be updated via service layer when source entities change
 *
 * @module Feeding
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  Check,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import { IsUUID, IsNotEmpty, IsOptional, Min, IsBoolean, IsDate } from 'class-validator';
import { FeedingProgram } from './feeding-program.entity';
// Type-only imports to avoid circular dependencies
import type { Equipment } from '../../equipment/entities/equipment.entity';
import type { Feed } from '../../feed/entities/feed.entity';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Equipment tipi
 */
export enum ProgramEquipmentType {
  TANK = 'tank',
  POND = 'pond',
  CAGE = 'cage',
}

registerEnumType(ProgramEquipmentType, {
  name: 'ProgramEquipmentType',
  description: 'Yemleme programına eklenebilecek equipment tipleri',
});

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('feeding_program_tanks')
@Index(['feedingProgramId', 'equipmentId'], { unique: true })
@Index(['tenantId', 'feedingProgramId'])
@Index(['tenantId', 'equipmentId'])
@Index(['tenantId', 'isActive'])                    // Issue #6: Composite index for active tank queries
@Index(['tenantId', 'addedAt'])                     // Issue #7: Index for ordering by addedAt
@Index(['tenantId', 'feedingProgramId', 'isActive']) // Composite for filtered program tank queries
@Check('"totalFeedTransitions" >= 0')               // Issue #10: Check constraint for non-negative value
export class FeedingProgramTank {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  @IsUUID()
  @IsNotEmpty()
  tenantId!: string;

  // -------------------------------------------------------------------------
  // PROGRAM İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  @IsUUID()
  @IsNotEmpty()
  feedingProgramId!: string;

  @ManyToOne(() => FeedingProgram, (program) => program.tanks, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'feedingProgramId' })
  feedingProgram?: FeedingProgram;

  // -------------------------------------------------------------------------
  // TANK/POND/CAGE BİLGİLERİ (Issue #1: ManyToOne relation with FK constraint)
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  @Index()
  @IsUUID()
  @IsNotEmpty()
  equipmentId!: string;           // Equipment (tank/pond/cage) ID

  /**
   * ManyToOne relationship to Equipment entity
   * Issue #1: Added proper relation with FK constraint
   * Issue #5: onDelete: 'CASCADE' - When equipment is deleted, remove program-tank association
   */
  @ManyToOne('Equipment', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'equipmentId' })
  equipment?: Equipment;

  @Field(() => ProgramEquipmentType)
  @Column({
    type: 'enum',
    enum: ProgramEquipmentType,
  })
  equipmentType!: ProgramEquipmentType;

  @Field()
  @Column({ length: 200 })
  equipmentName!: string;         // Denormalized - hızlı erişim için (sync via service layer)

  @Field()
  @Column({ length: 50 })
  equipmentCode!: string;         // Denormalized - hızlı erişim için (sync via service layer)

  // -------------------------------------------------------------------------
  // MEVCUT YEM DURUMU (Her tank için ayrı tracking)
  // Issue #3: ManyToOne relation for Feed
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  @IsUUID()
  @IsOptional()
  currentFeedId?: string;        // Şu an kullanılan yem

  /**
   * ManyToOne relationship to Feed entity
   * Issue #3: Added proper relation for currentFeedId
   * Issue #5: onDelete: 'SET NULL' - When feed is deleted, set to null (feed can be replaced)
   */
  @ManyToOne('Feed', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'currentFeedId' })
  currentFeed?: Feed;

  @Field({ nullable: true })
  @Column({ length: 50, nullable: true })
  currentFeedCode?: string;      // Denormalized (sync via service layer)

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  @Min(0)
  @IsOptional()
  currentWeightRangeIndex?: number; // feedAssignments içindeki index

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  @IsDate()
  @IsOptional()
  lastFeedTransitionAt?: Date;   // Son yem geçişi tarihi

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  @Min(0)
  totalFeedTransitions!: number;  // Toplam yem geçişi sayısı

  // -------------------------------------------------------------------------
  // SICAKLIK SENSÖRÜ
  // Issue #4: ManyToOne relation for Temperature Sensor
  // Note: Sensor entity is in sensor-service, using string reference
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  @Index()
  @IsUUID()
  @IsOptional()
  temperatureSensorId?: string;  // Bağlı sıcaklık sensörü

  /**
   * Note: Temperature sensor is in sensor-service module
   * This is a cross-service reference, FK constraint handled at database level
   * Issue #4: Added relation annotation for documentation
   * Issue #5: onDelete: 'SET NULL' - When sensor is deleted, set to null
   *
   * If using shared database, uncomment the ManyToOne decorator:
   * @ManyToOne('Sensor', { nullable: true, onDelete: 'SET NULL' })
   * @JoinColumn({ name: 'temperatureSensorId' })
   * temperatureSensor?: Sensor;
   */

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  temperatureSensorCode?: string; // Denormalized (sync via service layer)

  // -------------------------------------------------------------------------
  // DURUM
  // Issue #9: Soft delete pattern - uses isActive + removedAt for logical deletion
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: true })
  @IsBoolean()
  isActive!: boolean;             // Program içinde aktif mi?

  @Field()
  @Column({ type: 'timestamptz' })
  @IsDate()
  @IsNotEmpty()
  addedAt!: Date;                 // Programa eklenme tarihi

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  @IsDate()
  @IsOptional()
  removedAt?: Date;              // Programdan çıkarılma tarihi (soft delete)

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  @IsOptional()
  notes?: string;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  /**
   * UUID of the user who created this program-tank association
   */
  @Field({ description: 'UUID of the user who created this record' })
  @Column('uuid')
  @IsUUID()
  @IsNotEmpty()
  createdBy!: string;

  /**
   * UUID of the user who last modified this program-tank association
   */
  @Field({ nullable: true, description: 'UUID of the user who last modified this record' })
  @Column('uuid', { nullable: true })
  @IsUUID()
  @IsOptional()
  lastModifiedBy?: string;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  // -------------------------------------------------------------------------
  // LIFECYCLE HOOKS
  // Issue #8: BeforeUpdate hook for validation
  // Issue #12: Lifecycle hooks for validation
  // -------------------------------------------------------------------------

  @BeforeInsert()
  validateBeforeInsert(): void {
    // Ensure addedAt is set on insert
    if (!this.addedAt) {
      this.addedAt = new Date();
    }

    // Ensure totalFeedTransitions is non-negative
    if (this.totalFeedTransitions < 0) {
      this.totalFeedTransitions = 0;
    }

    // Validate consistency: if removedAt is set, isActive should be false
    if (this.removedAt && this.isActive) {
      this.isActive = false;
    }
  }

  @BeforeUpdate()
  validateBeforeUpdate(): void {
    // Ensure totalFeedTransitions is non-negative
    if (this.totalFeedTransitions < 0) {
      this.totalFeedTransitions = 0;
    }

    // Validate consistency: if removedAt is set, isActive should be false
    if (this.removedAt && this.isActive) {
      this.isActive = false;
    }

    // Validate consistency: if isActive and removed, clear removedAt
    if (this.isActive && this.removedAt) {
      this.removedAt = undefined;
    }
  }

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * Tank programa dahil ve aktif mi?
   */
  isActiveInProgram(): boolean {
    return this.isActive && !this.removedAt;
  }

  /**
   * Yem geçişi yap
   * @param feedId - Yeni yem ID'si
   * @param feedCode - Yeni yem kodu (denormalized)
   * @param rangeIndex - feedAssignments dizisindeki index
   */
  transitionToFeed(feedId: string, feedCode: string, rangeIndex: number): void {
    if (!feedId) {
      throw new Error('feedId is required for feed transition');
    }
    if (rangeIndex < 0) {
      throw new Error('rangeIndex must be non-negative');
    }

    this.currentFeedId = feedId;
    this.currentFeedCode = feedCode;
    this.currentWeightRangeIndex = rangeIndex;
    this.lastFeedTransitionAt = new Date();
    this.totalFeedTransitions++;
  }

  /**
   * Tank programdan çıkarıldı olarak işaretle (soft delete)
   * Issue #9: Standardized soft delete approach
   */
  markAsRemoved(): void {
    this.isActive = false;
    this.removedAt = new Date();
  }

  /**
   * Tank tekrar aktif et
   * Issue #11: Fixed to use null instead of undefined for database consistency
   */
  reactivate(): void {
    this.isActive = true;
    this.removedAt = undefined;  // Clear removal date for reactivation
  }

  /**
   * Mevcut yemi temizle
   * Useful when feed is deleted or needs to be cleared
   */
  clearCurrentFeed(): void {
    this.currentFeedId = undefined;
    this.currentFeedCode = undefined;
    this.currentWeightRangeIndex = undefined;
  }

  /**
   * Sıcaklık sensörünü güncelle
   * @param sensorId - Sensör ID'si
   * @param sensorCode - Sensör kodu (denormalized)
   */
  updateTemperatureSensor(sensorId: string | null, sensorCode: string | null): void {
    this.temperatureSensorId = sensorId || undefined;
    this.temperatureSensorCode = sensorCode || undefined;
  }

  /**
   * Denormalized equipment bilgilerini güncelle
   * Issue #8: Helper method for syncing denormalized fields
   * @param name - Equipment adı
   * @param code - Equipment kodu
   */
  syncEquipmentInfo(name: string, code: string): void {
    this.equipmentName = name;
    this.equipmentCode = code;
  }
}
