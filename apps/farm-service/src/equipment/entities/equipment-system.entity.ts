/**
 * EquipmentSystem Junction Entity
 *
 * Many-to-many relationship between Equipment and System
 * An equipment (e.g., generator, blower) can serve multiple systems
 * This enables risk mapping - when equipment fails, all connected systems are at risk
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
  Unique,
} from 'typeorm';

@Entity('equipment_systems')
@Unique(['equipmentId', 'systemId'])
@Index(['tenantId', 'equipmentId'])
@Index(['tenantId', 'systemId'])
export class EquipmentSystem {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @Index()
  tenantId: string;

  @Column('uuid')
  equipmentId: string;

  @ManyToOne('Equipment', 'equipmentSystems', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'equipmentId' })
  equipment: any;

  @Column('uuid')
  systemId: string;

  @ManyToOne('System', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'systemId' })
  system: any;

  /**
   * Is this the primary system for the equipment?
   * Useful for UI display and default selection
   */
  @Column({ default: false })
  isPrimary: boolean;

  /**
   * Role/function of equipment in this system
   * e.g., "backup", "primary", "shared"
   */
  @Column({ length: 50, nullable: true })
  role?: string;

  /**
   * Criticality level (1-5, 5 being most critical)
   * Used for risk assessment
   */
  @Column({ type: 'int', default: 3 })
  criticalityLevel: number;

  /**
   * Notes about this equipment-system relationship
   */
  @Column({ type: 'text', nullable: true })
  notes?: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column('uuid', { nullable: true })
  createdBy?: string;
}
