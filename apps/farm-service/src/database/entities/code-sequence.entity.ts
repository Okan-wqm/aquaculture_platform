/**
 * CodeSequence Entity - Kod üretimi için sequence takibi
 *
 * Her tenant, entity type ve yıl kombinasyonu için
 * ayrı sequence tutar.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  Unique,
} from 'typeorm';

@Entity('code_sequences')
@Unique(['tenantId', 'entityType', 'year'])
@Index(['tenantId', 'entityType'])
export class CodeSequence {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @Index()
  tenantId: string;

  @Column({ length: 50 })
  entityType: string; // 'Batch', 'Tank', 'Pond', etc.

  @Column({ length: 10 })
  prefix: string; // 'B', 'TNK', 'PND', etc.

  @Column({ type: 'int' })
  year: number;

  @Column({ type: 'int', default: 0 })
  lastSequence: number;

  @Column({ type: 'timestamptz', nullable: true })
  lastGeneratedAt?: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
