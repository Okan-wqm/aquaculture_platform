/**
 * FeedingProtocol Entity - Besleme protokolleri
 * Belirli türler ve aşamalar için özelleştirilmiş besleme programları
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
  VersionColumn,
} from 'typeorm';
import { Feed, FeedType } from './feed.entity';

export interface TemperatureRange {
  min: number;
  max: number;
  unit: 'celsius' | 'fahrenheit';
  feedingMultiplier: number; // Normal besleme oranına çarpan
}

export interface FeedingScheduleEntry {
  time: string; // "08:00", "12:00", etc.
  percentOfDaily: number; // Günlük miktarın yüzdesi
  notes?: string;
}

export interface FeedingSchedule {
  totalMealsPerDay: number;
  schedule: FeedingScheduleEntry[];
  adjustments?: {
    lowOxygenReduction?: number;    // %
    postStressReduction?: number;   // %
    preMedicationFasting?: number;  // Saat
  };
}

export interface GrowthStageProtocol {
  minWeight: number;
  maxWeight: number;
  weightUnit: 'gram' | 'kg';
  feedPercent: number;
  schedule: FeedingSchedule;
  notes?: string;
}

@Entity('feeding_protocols')
@Index(['tenantId', 'name'], { unique: true })
@Index(['tenantId', 'species'])
@Index(['tenantId', 'stage'])
@Index(['tenantId', 'feedId'])
export class FeedingProtocol {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @Index()
  tenantId: string;

  @Column({ length: 255 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column('uuid', { nullable: true })
  feedId?: string;

  @ManyToOne(() => Feed, { nullable: true })
  @JoinColumn({ name: 'feedId' })
  feed?: Feed;

  @Column({ length: 100 })
  species: string;

  @Column({
    type: 'enum',
    enum: FeedType,
    default: FeedType.GROWER,
  })
  stage: FeedType;

  /**
   * Sıcaklık aralıkları ve besleme çarpanları
   */
  @Column({ type: 'jsonb', nullable: true })
  temperatureRanges?: TemperatureRange[];

  /**
   * Ağırlık aralıklarına göre protokoller
   */
  @Column({ type: 'jsonb', nullable: true })
  growthStageProtocols?: GrowthStageProtocol[];

  /**
   * Varsayılan besleme programı
   */
  @Column({ type: 'jsonb', nullable: true })
  defaultSchedule?: FeedingSchedule;

  /**
   * Hedef FCR (Feed Conversion Ratio)
   */
  @Column({ type: 'decimal', precision: 4, scale: 2, nullable: true })
  targetFcr?: number;

  /**
   * Minimum çözünmüş oksijen seviyesi (mg/L)
   * Bu seviyenin altında besleme azaltılır/durdurulur
   */
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  minDissolvedOxygen?: number;

  /**
   * Optimal sıcaklık aralığı
   */
  @Column({ type: 'jsonb', nullable: true })
  optimalTemperature?: {
    min: number;
    max: number;
    unit: 'celsius' | 'fahrenheit';
  };

  /**
   * Özel durumlar için notlar
   */
  @Column({ type: 'jsonb', nullable: true })
  specialConditions?: {
    spawningPeriod?: string;
    winterFeeding?: string;
    diseaseOutbreak?: string;
    waterQualityIssues?: string;
  };

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: false })
  isDefault: boolean; // Tür için varsayılan protokol

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column('uuid', { nullable: true })
  createdBy?: string;

  @Column('uuid', { nullable: true })
  updatedBy?: string;

  @VersionColumn()
  version: number;
}
