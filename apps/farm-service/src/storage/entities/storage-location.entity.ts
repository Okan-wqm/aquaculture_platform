/**
 * Storage Location Entity - Physical storage places
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  VersionColumn,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';
import { registerEnumType } from '@nestjs/graphql';

export enum StorageLocationType {
  WAREHOUSE = 'warehouse',
  COLD_ROOM = 'cold_room',
  CHEMICAL_STORE = 'chemical_store',
  FEED_SILO = 'feed_silo',
  OUTDOOR = 'outdoor',
  HAZMAT = 'hazmat',
}

registerEnumType(StorageLocationType, {
  name: 'StorageLocationType',
  description: 'Type of storage location',
});

@Entity('storage_locations')
@Index(['tenantId', 'code'], { unique: true })
@Index(['tenantId', 'type'])
export class StorageLocation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId!: string;

  @Column({ type: 'uuid', name: 'site_id' })
  @Index()
  siteId!: string;

  @Column({ length: 255 })
  name!: string;

  @Column({ length: 50 })
  code!: string;

  @Column({
    type: 'varchar',
    length: 30,
    default: StorageLocationType.WAREHOUSE,
  })
  type!: StorageLocationType;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({ type: 'decimal', precision: 15, scale: 2, nullable: true, transformer: new DecimalTransformer() })
  capacity?: number;

  @Column({ type: 'varchar', length: 20, default: 'm3', name: 'capacity_unit' })
  capacityUnit!: string;

  @Column({ type: 'decimal', precision: 15, scale: 2, default: 0, name: 'used_capacity', transformer: new DecimalTransformer() })
  usedCapacity!: number;

  @Column({ type: 'decimal', precision: 5, scale: 1, nullable: true, name: 'temperature_min', transformer: new DecimalTransformer() })
  temperatureMin?: number;

  @Column({ type: 'decimal', precision: 5, scale: 1, nullable: true, name: 'temperature_max', transformer: new DecimalTransformer() })
  temperatureMax?: number;

  @Column({ type: 'decimal', precision: 5, scale: 1, nullable: true, name: 'humidity_min', transformer: new DecimalTransformer() })
  humidityMin?: number;

  @Column({ type: 'decimal', precision: 5, scale: 1, nullable: true, name: 'humidity_max', transformer: new DecimalTransformer() })
  humidityMax?: number;

  @Column({ default: true, name: 'is_active' })
  isActive!: boolean;

  // Soft delete
  @Column({ default: false, name: 'is_deleted' })
  @Index()
  isDeleted!: boolean;

  @Column({ type: 'timestamptz', nullable: true, name: 'deleted_at' })
  deletedAt?: Date;

  @Column({ type: 'uuid', nullable: true, name: 'deleted_by' })
  deletedBy?: string;

  // Audit
  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;

  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy?: string;

  @Column({ type: 'uuid', nullable: true, name: 'updated_by' })
  updatedBy?: string;

  @VersionColumn()
  version!: number;

  softDelete(deletedBy?: string): void {
    this.isDeleted = true;
    this.deletedAt = new Date();
    this.deletedBy = deletedBy;
    this.isActive = false;
  }
}
