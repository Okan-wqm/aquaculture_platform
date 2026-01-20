/**
 * Species Entity - Tür Kütüphanesi
 *
 * Akuakültür sisteminde yetiştirilen türlerin master verileri.
 * Bu entity diğer tüm entity'ler için referans noktasıdır:
 * - Batch: speciesId ile hangi tür yetiştirildiğini belirtir
 * - Feed: targetSpeciesId ile yem hangi türe uygun belirtilir
 * - FeedingProtocol: speciesId ile protokol hangi türe ait belirtilir
 * - WaterQuality: optimal değerler türe göre karşılaştırılır
 *
 * @module Species
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  VersionColumn,
  OneToMany,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
  Float,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Tür kategorisi - Ana sınıflandırma
 */
export enum SpeciesCategory {
  FISH = 'fish',                   // Balık
  SHRIMP = 'shrimp',               // Karides
  PRAWN = 'prawn',                 // Karidesler (tatlı su)
  CRAB = 'crab',                   // Yengeç
  LOBSTER = 'lobster',             // Istakoz
  MOLLUSK = 'mollusk',             // Yumuşakçalar (midye, istiridye)
  SEAWEED = 'seaweed',             // Deniz yosunu
  OTHER = 'other',
}

registerEnumType(SpeciesCategory, {
  name: 'SpeciesCategory',
  description: 'Ana tür kategorisi',
});

/**
 * Su tipi - Türün yaşadığı su ortamı
 */
export enum SpeciesWaterType {
  FRESHWATER = 'freshwater',       // Tatlı su
  SALTWATER = 'saltwater',         // Tuzlu su (deniz)
  BRACKISH = 'brackish',           // Acı su (karışım)
}

registerEnumType(SpeciesWaterType, {
  name: 'SpeciesWaterType',
  description: 'Türün yaşadığı su ortamı',
});

/**
 * Tür durumu
 */
export enum SpeciesStatus {
  ACTIVE = 'active',               // Aktif olarak yetiştiriliyor
  INACTIVE = 'inactive',           // Şu an yetiştirilmiyor
  EXPERIMENTAL = 'experimental',   // Deneme aşamasında
  DISCONTINUED = 'discontinued',   // Artık yetiştirilmiyor
}

registerEnumType(SpeciesStatus, {
  name: 'SpeciesStatus',
  description: 'Tür durumu',
});

/**
 * Büyüme aşaması - Türün yaşam döngüsündeki aşamalar
 */
export enum GrowthStage {
  EGG = 'egg',                     // Yumurta
  LARVAE = 'larvae',               // Larva
  POST_LARVAE = 'post_larvae',     // Post-larva
  FRY = 'fry',                     // Yavru (balık)
  FINGERLING = 'fingerling',       // Parmak boy
  JUVENILE = 'juvenile',           // Genç
  GROWER = 'grower',               // Büyütme
  PRE_ADULT = 'pre_adult',         // Erişkin öncesi
  ADULT = 'adult',                 // Erişkin
  BROODSTOCK = 'broodstock',       // Anaç
}

registerEnumType(GrowthStage, {
  name: 'GrowthStage',
  description: 'Büyüme aşaması',
});

// ============================================================================
// INTERFACES
// ============================================================================

/**
 * Optimal su kalitesi koşulları - Türün en iyi yaşadığı ortam
 */
export interface OptimalConditions {
  temperature: {
    min: number;                   // Minimum sıcaklık
    max: number;                   // Maksimum sıcaklık
    optimal: number;               // Optimal sıcaklık
    unit: 'celsius' | 'fahrenheit';
    criticalMin?: number;          // Kritik minimum (ölüm sınırı)
    criticalMax?: number;          // Kritik maksimum (ölüm sınırı)
  };
  ph: {
    min: number;
    max: number;
    optimal?: number;
  };
  dissolvedOxygen: {
    min: number;                   // Minimum DO (mg/L)
    optimal: number;               // Optimal DO
    critical?: number;             // Kritik seviye
    unit: 'mg/L' | 'ppm';
  };
  salinity?: {
    min: number;                   // ppt
    max: number;
    optimal?: number;
    unit: 'ppt' | 'psu';
  };
  ammonia?: {
    max: number;                   // Maksimum tolere edilen (mg/L)
    warning?: number;              // Uyarı seviyesi
  };
  nitrite?: {
    max: number;
    warning?: number;
  };
  nitrate?: {
    max: number;
    warning?: number;
  };
  alkalinity?: {
    min: number;
    max: number;
    unit: 'mg/L CaCO3';
  };
  hardness?: {
    min: number;
    max: number;
    unit: 'mg/L CaCO3' | 'dH';
  };
  co2?: {
    min: number;                   // Minimum CO2 (mg/L)
    max: number;                   // Maksimum CO2 (mg/L)
    warning?: number;              // Uyarı seviyesi
  };
  lightRegime?: {
    lightHours: number;            // Günlük aydınlık saat
    darkHours: number;             // Günlük karanlık saat
    notes?: string;                // Ek notlar
  };
}

/**
 * Büyüme parametreleri - Türün büyüme karakteristikleri
 */
export interface GrowthParameters {
  // Yoğunluk limitleri
  maxDensity: number;              // Maksimum yoğunluk (kg/m³)
  optimalDensity?: number;         // Optimal yoğunluk
  densityUnit: 'kg/m3' | 'pcs/m3'; // Birim

  // Büyüme oranları
  avgDailyGrowth: number;          // Ortalama günlük büyüme (g/gün)
  minDailyGrowth?: number;
  maxDailyGrowth?: number;

  // Hasat bilgileri
  avgHarvestWeight: number;        // Ortalama hasat ağırlığı (g)
  minHarvestWeight?: number;       // Minimum hasat ağırlığı
  maxHarvestWeight?: number;       // Maksimum hasat ağırlığı
  harvestWeightUnit: 'gram' | 'kg';

  // Süre bilgileri
  avgTimeToHarvestDays: number;    // Ortalama yetiştirme süresi (gün)
  minTimeToHarvestDays?: number;
  maxTimeToHarvestDays?: number;

  // Yem dönüşüm oranı
  targetFCR: number;               // Hedef FCR
  minFCR?: number;                 // En iyi FCR
  maxFCR?: number;                 // Kabul edilebilir maksimum FCR

  // Hayatta kalma
  expectedSurvivalRate: number;    // Beklenen hayatta kalma oranı (%)
  minAcceptableSurvival?: number;  // Kabul edilebilir minimum (%)

  // Spesifik büyüme oranı
  avgSGR?: number;                 // Specific Growth Rate (%)
}

/**
 * Input tipine göre hasat süreleri
 * Batch oluşturulurken input_type seçimine göre otomatik hesaplama yapılır
 */
export interface HarvestDaysPerInputType {
  egg?: number;                    // Yumurtadan başlama (gün)
  larvae?: number;                 // Larvadan başlama (gün)
  postLarvae?: number;             // Post-larvadan başlama (gün)
  fry?: number;                    // Yavrudan başlama (gün)
  fingerling?: number;             // Parmak boydan başlama (gün)
  juvenile?: number;               // Gençten başlama (gün)
}

/**
 * Büyüme aşaması detayları - Her aşama için özel parametreler
 */
export interface GrowthStageDefinition {
  stage: GrowthStage;
  name: string;                    // Gösterim adı
  order: number;                   // Sıralama (1, 2, 3...)

  // Ağırlık aralığı
  minWeight: number;               // Bu aşamadaki min ağırlık (g)
  maxWeight: number;               // Bu aşamadaki max ağırlık (g)
  weightUnit: 'gram' | 'kg';

  // Süre
  typicalDurationDays: number;     // Tipik süre (gün)
  minDurationDays?: number;
  maxDurationDays?: number;

  // Besleme
  recommendedFeedType: string;     // Önerilen yem tipi (STARTER, GROWER, vb.)
  feedingFrequency: number;        // Günlük öğün sayısı
  feedingRate: number;             // % body weight / gün

  // FCR
  targetFCR: number;
  expectedSGR?: number;            // Specific Growth Rate

  // Yoğunluk
  recommendedDensity?: number;     // Önerilen yoğunluk (kg/m³ veya adet/m³)
  densityUnit?: 'kg/m3' | 'pcs/m3';

  // Özel gereksinimler
  specialRequirements?: string;
  notes?: string;
}

/**
 * Pazar bilgileri - Ekonomik değerlendirme için
 */
export interface MarketInfo {
  marketPrice: number;             // Piyasa fiyatı
  currency: string;                // Para birimi (TRY, USD, EUR)
  priceUnit: 'kg' | 'piece';       // Fiyat birimi
  lastUpdated?: Date;

  // Talep bilgileri
  demandLevel?: 'low' | 'medium' | 'high' | 'very_high';
  seasonalDemand?: {
    highSeason: string[];          // Yüksek talep ayları
    lowSeason: string[];           // Düşük talep ayları
  };

  // Pazar kategorileri
  marketCategories?: Array<{
    name: string;                  // Örn: "A Class", "Export Quality"
    minWeight: number;
    maxWeight: number;
    priceMultiplier: number;       // Baz fiyata çarpan
  }>;
}

/**
 * Üreme bilgileri - Broodstock yönetimi için
 */
export interface BreedingInfo {
  breedingAge: number;             // Üreme yaşı (ay)
  breedingSeason?: string[];       // Üreme mevsimi
  spawningTemperature?: {
    min: number;
    max: number;
  };
  eggsPerSpawn?: number;           // Yumurtlama başına yumurta sayısı
  incubationDays?: number;         // Kuluçka süresi
  hatchRate?: number;              // Çıkış oranı (%)
  fertilizationRate?: number;      // Döllenme oranı (%)
}

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('species')
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'scientificName'], { unique: true })
@Index(['tenantId', 'category'])
@Index(['tenantId', 'waterType'])
@Index(['tenantId', 'status'])
@Index(['tenantId', 'isActive'])
export class Species {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  // -------------------------------------------------------------------------
  // TEMEL BİLGİLER
  // -------------------------------------------------------------------------

  @Field()
  @Column({ length: 100 })
  scientificName: string;          // Bilimsel ad: "Dicentrarchus labrax"

  @Field()
  @Column({ length: 100 })
  commonName: string;              // Yaygın ad: "European Seabass"

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  localName?: string;              // Yerel ad: "Levrek"

  @Field()
  @Column({ length: 50 })
  code: string;                    // Kısa kod: "SEABASS"

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  // -------------------------------------------------------------------------
  // SINIFLANDIRMA
  // -------------------------------------------------------------------------

  @Field(() => SpeciesCategory)
  @Column({
    type: 'enum',
    enum: SpeciesCategory,
    default: SpeciesCategory.FISH,
  })
  category: SpeciesCategory;

  @Field(() => SpeciesWaterType)
  @Column({
    type: 'enum',
    enum: SpeciesWaterType,
    default: SpeciesWaterType.SALTWATER,
  })
  waterType: SpeciesWaterType;

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  family?: string;                 // Familya: "Moronidae"

  @Field({ nullable: true })
  @Column({ length: 100, nullable: true })
  genus?: string;                  // Cins: "Dicentrarchus"

  // -------------------------------------------------------------------------
  // OPTİMAL KOŞULLAR
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  optimalConditions?: OptimalConditions;

  // -------------------------------------------------------------------------
  // BÜYÜME PARAMETRELERİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  growthParameters?: GrowthParameters;

  /**
   * Input tipine göre hasat süreleri
   * Batch oluşturulurken input_type seçimine göre expected_harvest_date otomatik hesaplanır
   * Örnek: { egg: 540, larvae: 480, fry: 360, fingerling: 270 }
   */
  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  harvestDaysPerInputType?: HarvestDaysPerInputType;

  // -------------------------------------------------------------------------
  // BÜYÜME AŞAMALARI
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  growthStages?: GrowthStageDefinition[];

  // -------------------------------------------------------------------------
  // PAZAR BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  marketInfo?: MarketInfo;

  // -------------------------------------------------------------------------
  // ÜREME BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  breedingInfo?: BreedingInfo;

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field(() => SpeciesStatus)
  @Column({
    type: 'enum',
    enum: SpeciesStatus,
    default: SpeciesStatus.ACTIVE,
  })
  status: SpeciesStatus;

  @Field()
  @Column({ default: true })
  @Index()
  isActive: boolean;

  // -------------------------------------------------------------------------
  // CLEANER FISH FLAGS
  // -------------------------------------------------------------------------

  /**
   * Bu tür cleaner fish mi? (Lumpfish, Wrasse türleri vb.)
   * Cleaner fish'ler salmon/trout çiftliklerinde sea lice kontrolü için kullanılır.
   */
  @Field()
  @Column({ default: false })
  @Index()
  isCleanerFish: boolean;

  /**
   * Cleaner fish türü
   * 'lumpfish' veya 'wrasse' (Ballan, Corkwing, Goldsinny wrasse)
   */
  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 50, nullable: true })
  cleanerFishType?: string;

  // -------------------------------------------------------------------------
  // TAGS - Tür Etiketleri
  // -------------------------------------------------------------------------

  /**
   * Tür etiketleri - Filtreleme ve kategorize etme için
   * Örnek: ['smolt', 'cleaner-fish', 'broodstock', 'organic']
   * Predefined: smolt, cleaner-fish, broodstock, fry, fingerling, grower, market-size, organic, certified
   * Custom tag'ler de eklenebilir
   */
  @Field(() => [String], { nullable: true })
  @Column({ type: 'jsonb', nullable: true, default: [] })
  tags?: string[];

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  notes?: string;

  // -------------------------------------------------------------------------
  // GÖRSEL VE BELGELER
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ length: 500, nullable: true })
  imageUrl?: string;               // Tür görseli

  // -------------------------------------------------------------------------
  // SUPPLIER İLİŞKİSİ
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  @Index()
  supplierId?: string;             // Yavru/Yumurta tedarikçisi

  // Note: Supplier import is done via string reference to avoid circular dependency
  // The actual relation is resolved at runtime by TypeORM

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', nullable: true })
  documents?: Array<{
    id: string;
    name: string;
    type: 'datasheet' | 'research' | 'protocol' | 'other';
    url: string;
    uploadedAt: Date;
  }>;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  createdBy?: string;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  updatedBy?: string;

  @VersionColumn()
  version: number;

  // -------------------------------------------------------------------------
  // SOFT DELETE
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: false })
  @Index()
  isDeleted: boolean;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  deletedBy?: string;

  // -------------------------------------------------------------------------
  // İLİŞKİLER - İleride aktifleştirilecek
  // -------------------------------------------------------------------------
  // @OneToMany(() => Batch, (batch) => batch.species)
  // batches?: Batch[];

  // @OneToMany(() => FeedingProtocol, (protocol) => protocol.species)
  // feedingProtocols?: FeedingProtocol[];

  // @OneToMany(() => FeedTypeSpecies, (fts) => fts.species)
  // feedTypeSpecies?: FeedTypeSpecies[];

  // -------------------------------------------------------------------------
  // BUSINESS METHODS
  // -------------------------------------------------------------------------

  /**
   * Verilen sıcaklık değerinin optimal aralıkta olup olmadığını kontrol eder
   */
  isTemperatureOptimal(temperature: number): boolean {
    if (!this.optimalConditions?.temperature) return true;
    const { min, max } = this.optimalConditions.temperature;
    return temperature >= min && temperature <= max;
  }

  /**
   * Verilen sıcaklık değerinin kritik aralıkta olup olmadığını kontrol eder
   */
  isTemperatureCritical(temperature: number): boolean {
    if (!this.optimalConditions?.temperature) return false;
    const { criticalMin, criticalMax } = this.optimalConditions.temperature;
    if (criticalMin !== undefined && temperature < criticalMin) return true;
    if (criticalMax !== undefined && temperature > criticalMax) return true;
    return false;
  }

  /**
   * Verilen pH değerinin optimal aralıkta olup olmadığını kontrol eder
   */
  isPHOptimal(ph: number): boolean {
    if (!this.optimalConditions?.ph) return true;
    const { min, max } = this.optimalConditions.ph;
    return ph >= min && ph <= max;
  }

  /**
   * Verilen çözünmüş oksijen değerinin yeterli olup olmadığını kontrol eder
   */
  isDOSufficient(dissolvedOxygen: number): boolean {
    if (!this.optimalConditions?.dissolvedOxygen) return true;
    return dissolvedOxygen >= this.optimalConditions.dissolvedOxygen.min;
  }

  /**
   * Verilen ağırlık için büyüme aşamasını belirler
   */
  getGrowthStageByWeight(weightInGrams: number): GrowthStageDefinition | undefined {
    if (!this.growthStages?.length) return undefined;

    return this.growthStages.find((stage) => {
      const minWeight = stage.weightUnit === 'kg' ? stage.minWeight * 1000 : stage.minWeight;
      const maxWeight = stage.weightUnit === 'kg' ? stage.maxWeight * 1000 : stage.maxWeight;
      return weightInGrams >= minWeight && weightInGrams <= maxWeight;
    });
  }

  /**
   * Tüm su kalitesi parametrelerini kontrol eder ve uyarıları döner
   */
  checkWaterQuality(params: {
    temperature?: number;
    ph?: number;
    dissolvedOxygen?: number;
    salinity?: number;
    ammonia?: number;
    nitrite?: number;
    nitrate?: number;
  }): Array<{ parameter: string; status: 'ok' | 'warning' | 'critical'; message: string }> {
    const results: Array<{ parameter: string; status: 'ok' | 'warning' | 'critical'; message: string }> = [];

    if (params.temperature !== undefined && this.optimalConditions?.temperature) {
      const temp = this.optimalConditions.temperature;
      if (this.isTemperatureCritical(params.temperature)) {
        results.push({
          parameter: 'temperature',
          status: 'critical',
          message: `Sıcaklık kritik seviyede: ${params.temperature}°C (Kritik: <${temp.criticalMin} veya >${temp.criticalMax})`,
        });
      } else if (!this.isTemperatureOptimal(params.temperature)) {
        results.push({
          parameter: 'temperature',
          status: 'warning',
          message: `Sıcaklık optimal aralık dışında: ${params.temperature}°C (Optimal: ${temp.min}-${temp.max})`,
        });
      } else {
        results.push({
          parameter: 'temperature',
          status: 'ok',
          message: `Sıcaklık optimal: ${params.temperature}°C`,
        });
      }
    }

    if (params.dissolvedOxygen !== undefined && this.optimalConditions?.dissolvedOxygen) {
      const do_ = this.optimalConditions.dissolvedOxygen;
      if (do_.critical && params.dissolvedOxygen < do_.critical) {
        results.push({
          parameter: 'dissolvedOxygen',
          status: 'critical',
          message: `Çözünmüş oksijen kritik: ${params.dissolvedOxygen} mg/L (Kritik: <${do_.critical})`,
        });
      } else if (params.dissolvedOxygen < do_.min) {
        results.push({
          parameter: 'dissolvedOxygen',
          status: 'warning',
          message: `Çözünmüş oksijen düşük: ${params.dissolvedOxygen} mg/L (Min: ${do_.min})`,
        });
      } else {
        results.push({
          parameter: 'dissolvedOxygen',
          status: 'ok',
          message: `Çözünmüş oksijen yeterli: ${params.dissolvedOxygen} mg/L`,
        });
      }
    }

    if (params.ammonia !== undefined && this.optimalConditions?.ammonia) {
      const ammonia = this.optimalConditions.ammonia;
      if (params.ammonia > ammonia.max) {
        results.push({
          parameter: 'ammonia',
          status: 'critical',
          message: `Amonyak kritik: ${params.ammonia} mg/L (Max: ${ammonia.max})`,
        });
      } else if (ammonia.warning && params.ammonia > ammonia.warning) {
        results.push({
          parameter: 'ammonia',
          status: 'warning',
          message: `Amonyak uyarı: ${params.ammonia} mg/L (Uyarı: ${ammonia.warning})`,
        });
      } else {
        results.push({
          parameter: 'ammonia',
          status: 'ok',
          message: `Amonyak normal: ${params.ammonia} mg/L`,
        });
      }
    }

    return results;
  }

  /**
   * Input tipine göre hasat gün sayısını döner
   * Batch oluşturulurken expected_harvest_date hesaplaması için kullanılır
   */
  getHarvestDaysByInputType(inputType: GrowthStage): number | undefined {
    if (!this.harvestDaysPerInputType) return undefined;

    const mapping: Record<string, keyof HarvestDaysPerInputType> = {
      [GrowthStage.EGG]: 'egg',
      [GrowthStage.LARVAE]: 'larvae',
      [GrowthStage.POST_LARVAE]: 'postLarvae',
      [GrowthStage.FRY]: 'fry',
      [GrowthStage.FINGERLING]: 'fingerling',
      [GrowthStage.JUVENILE]: 'juvenile',
    };

    const key = mapping[inputType];
    return key ? this.harvestDaysPerInputType[key] : undefined;
  }

  /**
   * Input tipine göre beklenen hasat tarihini hesaplar
   */
  calculateExpectedHarvestDate(inputType: GrowthStage, startDate: Date = new Date()): Date | undefined {
    const days = this.getHarvestDaysByInputType(inputType);
    if (!days) return undefined;

    const harvestDate = new Date(startDate);
    harvestDate.setDate(harvestDate.getDate() + days);
    return harvestDate;
  }

  /**
   * Soft delete işlemi
   */
  softDelete(deletedBy?: string): void {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = deletedBy;
    this.isActive = false;
  }

  /**
   * Soft delete geri alma
   */
  restore(): void {
    this.isDeleted = false;
    this.deletedAt = undefined;
    this.deletedBy = undefined;
    this.isActive = true;
  }
}
