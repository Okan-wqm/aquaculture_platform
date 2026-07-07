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
import GraphQLJSON from 'graphql-type-json';
import { TaskCategory, TaskChecklistItem, TaskPriority } from './task.entity';

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
@Index(['isActive', 'nextGeneration'])
export class RecurringTemplate {
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
  title!: string;

  @Field({ nullable: true })
  @Column({ type: 'text', nullable: true })
  description?: string;

  @Field(() => TaskCategory)
  @Column({
    type: 'enum',
    enum: TaskCategory,
  })
  category!: TaskCategory;

  @Field(() => TaskPriority)
  @Column({
    type: 'enum',
    enum: TaskPriority,
  })
  priority!: TaskPriority;

  // -------------------------------------------------------------------------
  // TEKRARLAMA AYARLARI
  // -------------------------------------------------------------------------

  @Field(() => RecurrenceFrequency)
  @Column({
    type: 'enum',
    enum: RecurrenceFrequency,
  })
  frequency!: RecurrenceFrequency;

  @Field({ nullable: true })
  @Column({ type: 'varchar', nullable: true })
  frequencyDetail?: string;

  /**
   * IANA timezone identifier (e.g. "Europe/Istanbul", "Europe/Oslo")
   * used to compute next-generation timestamps for this template.
   * Stored per-template so a tenant with sites in multiple regions
   * can schedule templates in each site's local time. Falls back to
   * UTC when null — older rows that predate phase 5.5 keep the
   * legacy server-time behaviour until the operator re-saves them.
   *
   * Phase 5.5 of the "Farm modülü kalan kör noktalar" plan — closes
   * Girdi 15-B13.
   */
  @Field({ nullable: true })
  @Column({ type: 'varchar', length: 64, nullable: true })
  timezone?: string;

  // -------------------------------------------------------------------------
  // ATAMA
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  assignedTo!: string;

  @Field()
  @Column({ length: 255 })
  assignedToName!: string;

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
  checklistItems!: TaskChecklistItem[];

  // -------------------------------------------------------------------------
  // DURUM
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: true })
  isActive!: boolean;

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
  @Column({ type: 'jsonb', nullable: true, default: [] })
  tags?: string[];

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt?: Date;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
