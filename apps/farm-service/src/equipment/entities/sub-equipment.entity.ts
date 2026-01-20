/**
 * SubEquipment Entity - Alt ekipmanlar
 * Ana ekipmanlara bağlı alt bileşenler (inlet, outlet, feeder, fish-trap vb.)
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
import { Equipment, EquipmentStatus } from './equipment.entity';
import { SubEquipmentType } from './sub-equipment-type.entity';

@Entity('sub_equipment')
@Index(['tenantId', 'parentEquipmentId', 'code'], { unique: true })
@Index(['tenantId', 'status'])
export class SubEquipment {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @Index()
  tenantId: string;

  @Column('uuid')
  @Index()
  parentEquipmentId: string;

  @ManyToOne(() => Equipment, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'parentEquipmentId' })
  parentEquipment: Equipment;

  @Column('uuid')
  subEquipmentTypeId: string;

  @ManyToOne(() => SubEquipmentType)
  @JoinColumn({ name: 'subEquipmentTypeId' })
  subEquipmentType: SubEquipmentType;

  @Column({ length: 255 })
  name: string;

  @Column({ length: 50 })
  code: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ length: 100, nullable: true })
  manufacturer?: string;

  @Column({ length: 100, nullable: true })
  model?: string;

  @Column({ length: 100, nullable: true })
  serialNumber?: string;

  @Column({
    type: 'enum',
    enum: EquipmentStatus,
    default: EquipmentStatus.OPERATIONAL,
  })
  status: EquipmentStatus;

  /**
   * Dinamik özellikler - SubEquipmentType.specificationSchema'ya göre
   */
  @Column({ type: 'jsonb', nullable: true })
  specifications?: Record<string, unknown>;

  @Column({ type: 'date', nullable: true })
  installationDate?: Date;

  @Column({ type: 'text', nullable: true })
  notes?: string;

  @Column({ default: true })
  isActive: boolean;

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
