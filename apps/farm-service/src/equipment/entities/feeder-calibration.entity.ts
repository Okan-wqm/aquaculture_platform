/**
 * FeederCalibration Entity
 * Stores feed-size-specific calibration data for feeder equipment.
 * Each row = one feed size calibration for one equipment.
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common/database';

@Entity('feeder_calibrations')
@Index(['tenantId', 'equipmentId', 'feedSizeMm'], { unique: true })
export class FeederCalibration {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Column({ type: 'uuid', name: 'equipment_id' })
  equipmentId!: string;

  @Column({ type: 'decimal', precision: 5, scale: 2, name: 'feed_size_mm', transformer: new DecimalTransformer() })
  feedSizeMm!: number;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'feed_size_label' })
  feedSizeLabel!: string;

  @Column({ type: 'decimal', precision: 8, scale: 2, name: 'grams_per_dispensing', transformer: new DecimalTransformer() })
  gramsPerDispensing!: number;

  @Column({ type: 'decimal', precision: 8, scale: 2, name: 'silo_capacity_kg', transformer: new DecimalTransformer() })
  siloCapacityKg!: number;

  @Column({ type: 'text', nullable: true, name: 'notes' })
  notes!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
