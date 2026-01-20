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
export class WaterQualityMeasurement {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

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

  // -------------------------------------------------------------------------
  // ÖLÇÜM BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column({ type: 'timestamptz' })
  @Index()
  measuredAt: Date;

  @Field(() => MeasurementSource)
  @Column({
    type: 'enum',
    enum: MeasurementSource,
    default: MeasurementSource.MANUAL,
  })
  source: MeasurementSource;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  measuredBy?: string;               // Manuel ölçümse kim yaptı

  // -------------------------------------------------------------------------
  // SU PARAMETRELERİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  parameters: WaterParameters;

  // Quick access fields (sık kullanılanlar)
  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  temperature?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 5, scale: 2, nullable: true })
  dissolvedOxygen?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 4, scale: 2, nullable: true })
  pH?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 6, scale: 3, nullable: true })
  ammonia?: number;

  @Field(() => Float, { nullable: true })
  @Column({ type: 'decimal', precision: 6, scale: 3, nullable: true })
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
  overallStatus: WaterQualityStatus;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  summary?: WaterQualitySummary;

  // -------------------------------------------------------------------------
  // ALARM
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: false })
  hasAlarm: boolean;

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

  // -------------------------------------------------------------------------
  // BATCH İLİŞKİSİ (opsiyonel)
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  batchId?: string;                  // Hangi batch için önemli

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
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

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

  /**
   * Parametreleri varsayılan limitlerle değerlendirir
   * Not: Gerçek uygulamada species-based limitler kullanılmalı
   */
  evaluateParameters(
    limits?: Record<string, { optimalMin: number; optimalMax: number; criticalMin: number; criticalMax: number; unit?: string }>
  ): void {
    const evaluations: ParameterEvaluation[] = [];
    let criticalCount = 0;
    let warningCount = 0;
    let optimalCount = 0;
    const recommendations: string[] = [];

    // Varsayılan limitler (alabalık için yaklaşık)
    const defaultLimits: Record<string, { optimalMin: number; optimalMax: number; criticalMin: number; criticalMax: number; unit: string }> = {
      temperature: { optimalMin: 12, optimalMax: 18, criticalMin: 5, criticalMax: 25, unit: '°C' },
      dissolvedOxygen: { optimalMin: 7, optimalMax: 12, criticalMin: 5, criticalMax: 15, unit: 'mg/L' },
      pH: { optimalMin: 6.5, optimalMax: 8.5, criticalMin: 6.0, criticalMax: 9.0, unit: '' },
      ammonia: { optimalMin: 0, optimalMax: 0.02, criticalMin: 0, criticalMax: 0.05, unit: 'mg/L' },
      nitrite: { optimalMin: 0, optimalMax: 0.1, criticalMin: 0, criticalMax: 0.5, unit: 'mg/L' },
      nitrate: { optimalMin: 0, optimalMax: 50, criticalMin: 0, criticalMax: 100, unit: 'mg/L' },
    };

    const effectiveLimits: Record<string, { optimalMin: number; optimalMax: number; criticalMin: number; criticalMax: number; unit?: string }> = { ...defaultLimits, ...limits };

    // Her parametre için değerlendirme
    for (const [param, value] of Object.entries(this.parameters)) {
      if (value === undefined || value === null) continue;
      if (typeof value !== 'number') continue;

      const limit = effectiveLimits[param];
      if (!limit) continue;

      let status: ParameterStatus;
      let message: string | undefined;

      if (value < limit.criticalMin) {
        status = ParameterStatus.CRITICAL_LOW;
        criticalCount++;
        message = `${param} kritik düşük`;
        recommendations.push(`${param} değeri acil yükseltilmeli`);
      } else if (value > limit.criticalMax) {
        status = ParameterStatus.CRITICAL_HIGH;
        criticalCount++;
        message = `${param} kritik yüksek`;
        recommendations.push(`${param} değeri acil düşürülmeli`);
      } else if (value < limit.optimalMin) {
        status = ParameterStatus.LOW;
        warningCount++;
        message = `${param} optimum altında`;
      } else if (value > limit.optimalMax) {
        status = ParameterStatus.HIGH;
        warningCount++;
        message = `${param} optimum üstünde`;
      } else {
        status = ParameterStatus.OPTIMAL;
        optimalCount++;
      }

      evaluations.push({
        parameter: param,
        value,
        unit: limit.unit || '',
        status,
        optimalMin: limit.optimalMin,
        optimalMax: limit.optimalMax,
        criticalMin: limit.criticalMin,
        criticalMax: limit.criticalMax,
        message,
      });
    }

    // Genel durum belirleme
    let overallStatus: WaterQualityStatus;
    if (criticalCount > 0) {
      overallStatus = WaterQualityStatus.CRITICAL;
      this.hasAlarm = true;
    } else if (warningCount > 0) {
      overallStatus = WaterQualityStatus.WARNING;
    } else if (optimalCount > 0) {
      overallStatus = WaterQualityStatus.OPTIMAL;
    } else {
      overallStatus = WaterQualityStatus.ACCEPTABLE;
    }

    this.overallStatus = overallStatus;
    this.summary = {
      overallStatus,
      criticalCount,
      warningCount,
      optimalCount,
      evaluations,
      recommendations,
    };
  }

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
