/**
 * RecurringTemplate Entity - Tekrarlayan Görev Şablonu
 *
 * Periyodik olarak otomatik görev oluşturmak için şablon tanımları.
 *
 * @module Task
 */
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import {
  ObjectType,
  Field,
  ID,
  Int,
  registerEnumType,
} from '@nestjs/graphql';
import GraphQLJSON from 'graphql-type-json';
import { TaskCategory, TaskPriority } from './task.entity';

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Tekrarlama sıklığı
 */
export enum RecurrenceFrequency {
  HOURLY = 'HOURLY',
  DAILY = 'DAILY',
  WEEKLY = 'WEEKLY',
  BIWEEKLY = 'BIWEEKLY',
  MONTHLY = 'MONTHLY',
  CUSTOM = 'CUSTOM',
}

registerEnumType(RecurrenceFrequency, {
  name: 'RecurrenceFrequency',
  description: 'Tekrarlama sıklığı',
});

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('recurring_templates')
@Index(['tenantId', 'isActive'])
export class RecurringTemplate {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
  @Index()
  tenantId: string;

  // -------------------------------------------------------------------------
  // TEMEL BİLGİLER
  // -------------------------------------------------------------------------

  @Field()
  @Column({ length: 255 })
  title: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => TaskCategory)
  @Column({
    type: 'enum',
    enum: TaskCategory,
  })
  category: TaskCategory;

  @Field(() => TaskPriority)
  @Column({
    type: 'enum',
    enum: TaskPriority,
  })
  priority: TaskPriority;

  // -------------------------------------------------------------------------
  // TEKRARLAMA AYARLARI
  // -------------------------------------------------------------------------

  @Field(() => RecurrenceFrequency)
  @Column({
    type: 'enum',
    enum: RecurrenceFrequency,
  })
  frequency: RecurrenceFrequency;

  @Field({ nullable: true })
  @Column({ type: 'varchar', nullable: true })
  frequencyDetail?: string;

  // -------------------------------------------------------------------------
  // ATAMA
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  assignedTo: string;

  @Field()
  @Column({ length: 255 })
  assignedToName: string;

  // -------------------------------------------------------------------------
  // DETAYLAR
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ type: 'varchar', nullable: true })
  location?: string;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  estimatedMinutes?: number;

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', default: [] })
  checklistItems: any[];

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: true })
  isActive: boolean;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  lastGenerated?: Date;

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  nextGeneration?: Date;

  // -------------------------------------------------------------------------
  // ETIKETLER
  // -------------------------------------------------------------------------

  @Field(() => [String], { nullable: true })
  @Column({ type: 'simple-array', nullable: true })
  tags?: string[];

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
