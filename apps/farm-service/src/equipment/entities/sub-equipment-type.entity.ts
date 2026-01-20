/**
 * SubEquipmentType Entity - Alt ekipman tipleri
 * Ana ekipmanlara bağlanabilecek alt bileşenler
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { SpecificationSchema } from './equipment-type.entity';

@Entity('sub_equipment_types')
@Index(['code'], { unique: true })
@Index(['isActive'])
export class SubEquipmentType {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ length: 100 })
  name: string;

  @Column({ length: 50, unique: true })
  code: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ length: 50, nullable: true })
  icon?: string;

  /**
   * Bu alt ekipman tipi hangi ana ekipman tiplerine bağlanabilir
   * EquipmentType.code değerlerinin listesi
   * Örnek: ['fish-tank', 'raceway'] - sadece tanklara bağlanabilir
   */
  @Column({ type: 'simple-array' })
  compatibleEquipmentTypes: string[];

  @Column({ type: 'jsonb' })
  specificationSchema: SpecificationSchema;

  @Column({ default: true })
  isActive: boolean;

  @Column({ default: false })
  isSystem: boolean;

  @Column({ type: 'int', default: 0 })
  sortOrder: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
