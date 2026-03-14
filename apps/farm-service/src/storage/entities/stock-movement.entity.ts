/**
 * Stock Movement Entity - Audit trail of stock changes
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';
import { DecimalTransformer } from '@aquaculture/backend-common';
import { registerEnumType } from '@nestjs/graphql';

export enum MovementType {
  IN = 'in',
  OUT = 'out',
  TRANSFER = 'transfer',
  WASTE = 'waste',
  ADJUSTMENT = 'adjustment',
  RETURN = 'return',
}

registerEnumType(MovementType, {
  name: 'MovementType',
  description: 'Type of stock movement',
});

@Entity('stock_movements')
@Index(['tenantId', 'movementType'])
@Index(['itemType', 'itemId'])
@Index(['performedAt'])
export class StockMovement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  @Index()
  tenantId: string;

  @Column({ type: 'varchar', length: 20, name: 'movement_type' })
  movementType: MovementType;

  @Column({ type: 'varchar', length: 20, name: 'item_type' })
  itemType: string; // feed/chemical/consumable

  @Column({ type: 'uuid', name: 'item_id' })
  itemId: string;

  @Column({ type: 'varchar', length: 255, name: 'item_name' })
  itemName: string;

  @Column({ type: 'decimal', precision: 15, scale: 2, transformer: new DecimalTransformer() })
  quantity: number;

  @Column({ length: 20 })
  unit: string;

  @Column({ type: 'uuid', nullable: true, name: 'from_location_id' })
  @Index()
  fromLocationId?: string;

  @Column({ type: 'uuid', nullable: true, name: 'to_location_id' })
  @Index()
  toLocationId?: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  reference?: string;

  @Column({ type: 'text', nullable: true })
  reason?: string;

  @Column({ type: 'uuid', name: 'performed_by' })
  performedBy: string;

  @Column({ type: 'timestamptz', default: () => 'NOW()', name: 'performed_at' })
  performedAt: Date;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;
}
