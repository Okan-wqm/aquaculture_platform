/**
 * WaterQualityMeasurement Entity - Su Kalitesi Ölçümleri
 *
 * Tank/havuz bazında su kalitesi parametrelerinin ölçüm kayıtları.
 * Otomatik sensör veya manuel ölçümler desteklenir.
 *
 * Özellikler:
 * - Kapsamlı su parametreleri (DO, pH, NH3, NO2, etc.)
 * - Otomatik alarm tetikleme
 * - Species-based limit kontrolü
 * - Trend analizi
 * - Korelasyon takibi
 *
 * @module WaterQuality
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
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import {
  ObjectType,
  Field,
  ID,
  Float,
  registerEnumType,
} from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { Tank } from '../../tank/entities/tank.entity';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Ölçüm kaynağı
 */
export enum MeasurementSource {
  MANUAL = 'manual',                 // Manuel ölçüm
  SENSOR_AUTOMATIC = 'sensor_auto',  // Otomatik sensör
  SENSOR_TRIGGERED = 'sensor_trigger', // Tetiklenmiş sensör
  LAB_ANALYSIS = 'lab_analysis',     // Laboratuvar analizi
  CALIBRATION = 'calibration',       // Kalibrasyon ölçümü
}

registerEnumType(MeasurementSource, {
  name: 'WaterQualityMeasurementSource',
  description: 'Ölçüm kaynağı',
});

/**
 * Genel su kalitesi durumu
 */
export enum WaterQualityStatus {
  OPTIMAL = 'optimal',               // Tüm parametreler ideal
  ACCEPTABLE = 'acceptable',         // Kabul edilebilir
  WARNING = 'warning',               // Dikkat gerektiren
  CRITICAL = 'critical',             // Kritik - acil müdahale
  UNKNOWN = 'unknown',               // Değerlendirilmemiş
}

registerEnumType(WaterQualityStatus, {
  name: 'WaterQualityStatus',
  description: 'Su kalitesi durumu',
});

/**
 * Parametre durumu
 */
export enum ParameterStatus {
  OPTIMAL = 'optimal',
  LOW = 'low',
  HIGH = 'high',
  CRITICAL_LOW = 'critical_low',
  CRITICAL_HIGH = 'critical_high',
  NOT_MEASURED = 'not_measured',
}

registerEnumType(ParameterStatus, {
  name: 'ParameterStatus',
  description: 'Parametre durumu',
});

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Su parametreleri
 */
export interface WaterParameters {
  /** Index signature: evaluation service iterates parameter keys dynamically */
  [key: string]: number | string | boolean | undefined;
  // Temel parametreler
  temperature?: number;              // °C
  dissolvedOxygen?: number;          // mg/L (DO)
  oxygenSaturation?: number;         // %
  pH?: number;                       // 0-14
  salinity?: number;                 // ppt
  conductivity?: number;             // µS/cm

  // Nitrojen döngüsü
  ammonia?: number;                  // mg/L (NH3 - toxic form)
  ammonium?: number;                 // mg/L (NH4+ - less toxic)
  totalAmmoniaNitrogen?: number;     // mg/L (TAN = NH3 + NH4+)
  nitrite?: number;                  // mg/L (NO2-)
  nitrate?: number;                  // mg/L (NO3-)

  // Diğer parametreler
  alkalinity?: number;               // mg/L CaCO3
  hardness?: number;                 // mg/L CaCO3
  turbidity?: number;                // NTU
  transparency?: number;             // cm (Secchi disk)
  co2?: number;                      // mg/L
  chlorine?: number;                 // mg/L
  hydrogen_sulfide?: number;         // mg/L (H2S)

  // Organik yük
  bod?: number;                      // mg/L (Biochemical Oxygen Demand)
  cod?: number;                      // mg/L (Chemical Oxygen Demand)
  tss?: number;                      // mg/L (Total Suspended Solids)

  // Biyolojik
  bacteriaCount?: number;            // CFU/mL
  algaeLevel?: 'none' | 'low' | 'moderate' | 'high' | 'bloom';
}

/**
 * Parametre değerlendirmesi
 */
export interface ParameterEvaluation {
  parameter: string;
  value: number;
  unit: string;
  status: ParameterStatus;
  optimalMin?: number;
  optimalMax?: number;
  criticalMin?: number;
  criticalMax?: number;
  message?: string;
}

/**
 * Su kalitesi özeti
 */
export interface WaterQualitySummary {
  overallStatus: WaterQualityStatus;
  criticalCount: number;
  warningCount: number;
  optimalCount: number;
  evaluations: ParameterEvaluation[];
  recommendations: string[];
}

/**
 * Sensör bilgileri
 */
export interface SensorInfo {
  sensorId: string;
  sensorType: string;
  lastCalibration?: Date;
  accuracy?: number;                 // %
  batteryLevel?: number;             // %
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('water_quality_measurements')
@Index(['tenantId', 'tankId', 'measuredAt'])
@Index(['tenantId', 'pondId', 'measuredAt'])
@Index(['tenantId', 'measuredAt'])
@Index(['tankId', 'measuredAt'])
@Index(['overallStatus', 'tenantId'])
@Index(['tenantId', 'equipmentId', 'measuredAt'])
@Index(['tenantId', 'idempotencyKey'], { unique: true, where: '"idempotencyKey" IS NOT NULL' })
export class WaterQualityMeasurement {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId!: string;

  // -------------------------------------------------------------------------
  // LOKASYON
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  @Index()
  tankId?: string;

  @ManyToOne(() => Tank, { nullable: true, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'tankId' })
  tank?: Tank;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  @Index()
  pondId?: string;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  siteId?: string;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  @Index()
  equipmentId?: string;

  @ManyToOne('Equipment', { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'equipmentId' })
  equipment?: unknown; // String ref for Equipment to avoid circular import

  // -------------------------------------------------------------------------
  // ÖLÇÜM BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column({ type: 'timestamptz' })
  @Index()
  measuredAt!: Date;

  @Field(() => MeasurementSource)
  @Column({
    type: 'enum',
    enum: MeasurementSource,
    default: MeasurementSource.MANUAL,
  })
  source!: MeasurementSource;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  measuredBy?: string;               // Manuel ölçümse kim yaptı

  // -------------------------------------------------------------------------
  // SU PARAMETRELERİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  parameters!: WaterParameters;

  // Quick access fields (sık kullanılanlar)
  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  temperature?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  dissolvedOxygen?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 4, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  pH?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 6, scale: 3, nullable: true, transformer: new DecimalTransformer() })
  ammonia?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 6, scale: 3, nullable: true, transformer: new DecimalTransformer() })
  nitrite?: number;

  // -------------------------------------------------------------------------
  // DEĞERLENDİRME
  // -------------------------------------------------------------------------

  @Field(() => WaterQualityStatus)
  @Column({
    type: 'enum',
    enum: WaterQualityStatus,
    default: WaterQualityStatus.UNKNOWN,
  })
  @Index()
  overallStatus!: WaterQualityStatus;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  summary?: WaterQualitySummary;

  // -------------------------------------------------------------------------
  // ALARM
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: false })
  hasAlarm!: boolean;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  alertRuleId?: string;              // Tetiklenen alarm kuralı

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  alertIncidentId?: string;          // Oluşturulan alarm olayı

  // -------------------------------------------------------------------------
  // SENSÖR BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  sensorInfo?: SensorInfo;

  /**
   * Phase 7.4 — back-reference to the sensor-service reading that produced this
   * WQ measurement.
   *
   * SENSOR-HIGH-085: this holds a SensorReading FEDERATION ID, not a uuid. A
   * reading is no longer a stored row — it is an as-of projection over the
   * tenant's sensor_metrics hypertable, and its `id` is an opaque base64url
   * codec of the projection's anchor. The column is `varchar` for exactly that
   * reason; treating it as a uuid made the correlation this field exists for
   * impossible to store.
   *
   * Null when the measurement was logged manually (operator entry),
   * imported in bulk historically, or pre-dates the cross-service
   * correlation feature. When set, the audit UI can render a
   * "view source reading" link that the gateway resolves through
   * sensor-service.
   *
   * Cardinality is N:1 — multiple sensor readings can independently
   * exist, but a given sensor reading produces at most one WQ
   * measurement. The partial unique index
   * `idx_wq_related_sensor_reading_uniq` enforces it at the DB.
   *
   * The FK is INTENTIONALLY NOT declared at the DB layer — sensor-service owns
   * its own schema, and the correlation is informational rather than invariant
   * (a projection can age out of its retention window while the derived WQ
   * measurement survives). See migration
   * 1788200000001-AddWaterQualitySensorReadingCorrelation.ts for
   * the architectural rationale.
   */
  @Field(() => ID, { nullable: true })
  @Column('varchar', { length: 512, nullable: true })
  @Index()
  relatedSensorReadingId?: string;

  // -------------------------------------------------------------------------
  // BATCH İLİŞKİSİ (opsiyonel)
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  batchId?: string;                  // Hangi batch için önemli

  // -------------------------------------------------------------------------
  // IDEMPOTENCY
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ type: 'uuid', nullable: true })
  @Index()
  idempotencyKey?: string;

  // -------------------------------------------------------------------------
  // NOTLAR
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  weatherConditions?: string;        // Hava durumu (açık havuz için)

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  // -------------------------------------------------------------------------
  // COMPUTED FIELDS
  // -------------------------------------------------------------------------

  @BeforeInsert()
  @BeforeUpdate()
  syncQuickAccessFields(): void {
    // Quick access alanlarını parameters'tan güncelle
    if (this.parameters) {
      this.temperature = this.parameters.temperature;
      this.dissolvedOxygen = this.parameters.dissolvedOxygen;
      this.pH = this.parameters.pH;
      this.ammonia = this.parameters.ammonia;
      this.nitrite = this.parameters.nitrite;
    }
  }

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  // NOTE: The hardcoded evaluateParameters() + its trout-tuned defaultLimits
  // were removed. WaterQualityEvaluationService (config-driven, tenant- and
  // species-aware) is now the SOLE evaluator. With the single-ingress contract
  // every measurement passes WaterQualityValidationService.validate() (strict
  // mode), so a no-config fallback evaluator can never be reached — keeping a
  // second, hardcoded evaluation path would have been an unreachable shadow
  // gate that silently diverged from tenant configuration.

  /**
   * Oksijen yeterli mi?
   */
  hasAdequateOxygen(minDO: number = 5): boolean {
    return (this.dissolvedOxygen ?? 0) >= minDO;
  }

  /**
   * pH uygun aralıkta mı?
   */
  isPHAcceptable(minPH: number = 6.5, maxPH: number = 8.5): boolean {
    if (!this.pH) return true;
    return this.pH >= minPH && this.pH <= maxPH;
  }

  /**
   * Amonyak tehlikeli mi?
   */
  isAmmoniaHazardous(threshold: number = 0.02): boolean {
    return (this.ammonia ?? 0) > threshold;
  }

  /**
   * Nitrit tehlikeli mi?
   */
  isNitriteHazardous(threshold: number = 0.1): boolean {
    return (this.nitrite ?? 0) > threshold;
  }

  /**
   * Acil müdahale gerekiyor mu?
   */
  requiresImmediateAction(): boolean {
    return this.overallStatus === WaterQualityStatus.CRITICAL;
  }

  /**
   * Yemleme için uygun mu?
   */
  isSuitableForFeeding(minDO: number = 5, maxTemp: number = 22): boolean {
    if (!this.hasAdequateOxygen(minDO)) return false;
    if (this.temperature && this.temperature > maxTemp) return false;
    if (this.isAmmoniaHazardous()) return false;
    return true;
  }
}
