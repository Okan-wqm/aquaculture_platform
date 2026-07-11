/**
 * AutoRule Entity - Otomatik Kural Yönetimi
 *
 * Belirli tetikleyicilere göre otomatik görev oluşturma kuralları.
 * Stok azalması, bakım zamanı, lisans süresi gibi olaylarda
 * otomatik görev oluşturulmasını sağlar.
 *
 * @module Task
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  DeleteDateColumn,
  Index,
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import { TaskCategory, TaskPriority } from './task.entity';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Otomatik kural tetikleyici türü
 */
export enum AutoRuleTrigger {
  STOCK_LOW = 'STOCK_LOW',
  EXPIRY_NEAR = 'EXPIRY_NEAR',
  MAINTENANCE_DUE = 'MAINTENANCE_DUE',
  SCHEDULE = 'SCHEDULE',
  LICENSE_EXPIRY = 'LICENSE_EXPIRY',
  WATER_PARAM_ALERT = 'WATER_PARAM_ALERT',
}

registerEnumType(AutoRuleTrigger, {
  name: 'AutoRuleTrigger',
  description: 'Otomatik kural tetikleyici türü',
});

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('auto_rules')
@Index(['tenantId', 'isActive'])
export class AutoRule {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Field()
  @Column('uuid')
  tenantId!: string;

  // -------------------------------------------------------------------------
  // TEMEL BİLGİLER
  // -------------------------------------------------------------------------

  @Field()
  @Column({ length: 255 })
  name!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  // -------------------------------------------------------------------------
  // TETİKLEYİCİ
  // -------------------------------------------------------------------------

  @Field(() => AutoRuleTrigger)
  @Column({
    type: 'enum',
    enum: AutoRuleTrigger,
  })
  trigger!: AutoRuleTrigger;

  @Field()
  @Column({ type: 'text' })
  triggerCondition!: string;

  // -------------------------------------------------------------------------
  // OLUŞTURULACAK GÖREV BİLGİLERİ
  // -------------------------------------------------------------------------

  @Field()
  @Column({ length: 255 })
  taskTitle!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  taskDescription?: string;

  @Field(() => TaskCategory)
  @Column({
    type: 'enum',
    enum: TaskCategory,
  })
  taskCategory!: TaskCategory;

  @Field(() => TaskPriority)
  @Column({
    type: 'enum',
    enum: TaskPriority,
  })
  taskPriority!: TaskPriority;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  assignTo?: string;

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: true })
  isActive!: boolean;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  lastTriggered?: Date;

  @Field(() => Int)
  @Column({ type: 'int', default: 0 })
  triggerCount!: number;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;

  @Field({ nullable: true })
  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt?: Date;
}
