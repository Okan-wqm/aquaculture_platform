/**
 * BaseEntity - Tüm farm modülü entity'leri için temel sınıf
 *
 * Sağladığı özellikler:
 * - UUID primary key
 * - Tenant isolation (tenantId)
 * - Audit fields (createdAt, updatedAt, createdBy, updatedBy)
 * - Soft delete (isDeleted, deletedAt, deletedBy)
 * - Optimistic locking (version)
 */
import {
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  VersionColumn,
  Index,
  BeforeInsert,
  BeforeUpdate,
} from 'typeorm';

export abstract class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid')
  @Index()
  tenantId: string;

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

  // Soft delete fields
  @Column({ default: false })
  @Index()
  isDeleted: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;

  @Column('uuid', { nullable: true })
  deletedBy?: string;

  /**
   * Soft delete işlemi
   */
  softDelete(deletedBy?: string): void {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = deletedBy;
  }

  /**
   * Soft delete geri alma
   */
  restore(): void {
    this.isDeleted = false;
    this.deletedAt = undefined;
    this.deletedBy = undefined;
  }
}

/**
 * BaseEntityWithCode - Kod alanı olan entity'ler için
 * Site, Department, Equipment, Tank, Pond, Batch vb.
 */
export abstract class BaseEntityWithCode extends BaseEntity {
  @Column({ length: 255 })
  name: string;

  @Column({ length: 50 })
  code: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ default: true })
  @Index()
  isActive: boolean;
}

/**
 * BaseEntityWithStatus - Status alanı olan entity'ler için
 */
export abstract class BaseEntityWithStatus extends BaseEntityWithCode {
  // Status alanı child class'larda tanımlanacak (enum tipine göre)
}
