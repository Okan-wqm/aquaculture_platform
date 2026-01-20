/**
 * ChemicalType Entity - Kimyasal tipleri
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

@Entity('chemical_types')
@Index(['code'], { unique: true })
@Index(['isActive'])
export class ChemicalType {
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
