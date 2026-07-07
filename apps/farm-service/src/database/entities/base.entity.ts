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
} from 'typeorm';

export abstract class BaseEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column('uuid', { name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column('uuid', { nullable: true, name: 'created_by' })
  createdBy?: string;

  @Column('uuid', { nullable: true, name: 'updated_by' })
  updatedBy?: string;

  @VersionColumn({ name: 'version' })
  version!: number;

  // Soft delete fields
  @Column({ default: false, name: 'is_deleted' })
  @Index()
  isDeleted!: boolean;

  @Column({ type: 'timestamptz', nullable: true, name: 'deleted_at' })
  deletedAt?: Date;

  @Column('uuid', { nullable: true, name: 'deleted_by' })
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
  @Column({ length: 255, name: 'name' })
  name!: string;

  @Column({ length: 50, name: 'code' })
  code!: string;

  @Column({ type: 'text', nullable: true, name: 'description' })
  description?: string;

  @Column({ default: true, name: 'is_active' })
  @Index()
  isActive!: boolean;
}

/**
 * BaseEntityWithStatus - Status alanı olan entity'ler için
 */
export abstract class BaseEntityWithStatus extends BaseEntityWithCode {
  // Status alanı child class'larda tanımlanacak (enum tipine göre)
}
