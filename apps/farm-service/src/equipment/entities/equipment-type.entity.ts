/**
 * EquipmentType Entity - Sistem tanımlı ekipman tipleri
 * Her tip için dinamik specification şeması tanımlar
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum EquipmentCategory {
  TANK = 'tank',                   // Tanklar
  POND = 'pond',                   // Havuzlar (Earthen Ponds)
  CAGE = 'cage',                   // Kafesler (Sea Cages)
  PUMP = 'pump',                   // Pompalar
  AERATION = 'aeration',           // Havalandırma
  FILTRATION = 'filtration',       // Filtrasyon
  HEATING_COOLING = 'heating_cooling', // Isıtma/Soğutma
  FEEDING = 'feeding',             // Besleme sistemleri
  MONITORING = 'monitoring',       // İzleme/Sensör
  WATER_TREATMENT = 'water_treatment', // Su arıtma
  HARVESTING = 'harvesting',       // Hasat ekipmanları
  TRANSPORT = 'transport',         // Taşıma
  ELECTRICAL = 'electrical',       // Elektrik
  PLUMBING = 'plumbing',          // Tesisat
  SAFETY = 'safety',              // Güvenlik
  OTHER = 'other',
}

/**
 * Specification field tanımı
 * Frontend'de dinamik form oluşturmak için kullanılır
 */
export interface SpecificationField {
  name: string;
  label: string;
  type: 'text' | 'number' | 'select' | 'multiselect' | 'boolean' | 'date' | 'textarea';
  required?: boolean;
  unit?: string;
  options?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  defaultValue?: unknown;
  placeholder?: string;
  helpText?: string;
  group?: string; // Field gruplandırma için
}

export interface SpecificationSchema {
  fields: SpecificationField[];
  groups?: Array<{
    name: string;
    label: string;
    description?: string;
  }>;
}

@Entity('equipment_types', { schema: 'farm' })
@Index(['code'], { unique: true })
@Index(['category'])
@Index(['isActive'])
export class EquipmentType {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 100 })
  name: string;

  @Column({ length: 50, unique: true })
  code: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({
    type: 'enum',
    enum: EquipmentCategory,
    default: EquipmentCategory.OTHER,
  })
  category: EquipmentCategory;

  @Column({ length: 50, nullable: true })
  icon?: string; // Icon name for UI

  @Column({ type: 'jsonb' })
  specificationSchema: SpecificationSchema;

  @Column({ type: 'simple-array', nullable: true })
  allowedSubEquipmentTypes?: string[]; // SubEquipmentType code'ları

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: false })
  isSystem: boolean; // Sistem tanımlı, silinemez

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
