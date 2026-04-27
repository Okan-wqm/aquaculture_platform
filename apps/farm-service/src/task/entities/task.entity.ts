/**
 * Task Entity - Görev Yönetimi
 *
 * Çiftlik operasyonlarında görev oluşturma, atama ve takip.
 * Yemleme, su kalitesi, sağlık kontrolü, ekipman bakımı vb.
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

/**
 * Runtime shape of a single item in `Task.checklistItems` (JSONB).
 *
 * `isCompleted` is the field the `TaskChecklistItemInput` DTO writes
 * on creation (UI-facing name). `completed` + `completedAt` are the
 * fields the `TaskService.toggleChecklistItem` path mutates — the
 * two names DIVERGE today; a follow-up will unify them. Keeping the
 * interface permissive (both optional) documents the reality
 * accurately rather than papering over it with a single name that
 * doesn't match what's stored.
 */
export interface TaskChecklistItem {
  /** UUID, assigned by the service on first toggle / on creation. */
  id?: string;
  text: string;
  /** UI input field — set on creation via `TaskChecklistItemInput`. */
  isCompleted?: boolean;
  /** Runtime toggle field — flipped by `toggleChecklistItem`. */
  completed?: boolean;
  /** ISO-8601 string written by `toggleChecklistItem`. */
  completedAt?: string | null;
  completedBy?: string;
}

/**
 * Runtime shape of a single item in `Task.notes` (JSONB). Written
 * exclusively by `TaskService.addNote` — the shape is under that
 * service's control.
 */
export interface TaskNote {
  id: string;
  text: string;
  createdBy: string;
  /** ISO-8601 string. */
  createdAt: string;
}

// ============================================================================
// ENUMS
// ============================================================================

/**
 * Görev kategorisi
 */
export enum TaskCategory {
  FEEDING = 'FEEDING',
  WATER_QUALITY = 'WATER_QUALITY',
  HEALTH_CHECK = 'HEALTH_CHECK',
  EQUIPMENT_MAINTENANCE = 'EQUIPMENT_MAINTENANCE',
  STOCK_MANAGEMENT = 'STOCK_MANAGEMENT',
  CLEANING = 'CLEANING',
  REGULATORY = 'REGULATORY',
  HARVEST = 'HARVEST',
  ENVIRONMENTAL = 'ENVIRONMENTAL',
  SAFETY = 'SAFETY',
  GENERAL = 'GENERAL',
}

registerEnumType(TaskCategory, {
  name: 'TaskCategory',
  description: 'Görev kategorisi',
});

/**
 * Görev önceliği
 */
export enum TaskPriority {
  URGENT = 'URGENT',
  HIGH = 'HIGH',
  MEDIUM = 'MEDIUM',
  LOW = 'LOW',
}

registerEnumType(TaskPriority, {
  name: 'TaskPriority',
  description: 'Görev önceliği',
});

/**
 * Görev durumu
 */
export enum TaskStatus {
  PENDING = 'PENDING',
  IN_PROGRESS = 'IN_PROGRESS',
  COMPLETED = 'COMPLETED',
  OVERDUE = 'OVERDUE',
  CANCELLED = 'CANCELLED',
}

registerEnumType(TaskStatus, {
  name: 'TaskStatus',
  description: 'Görev durumu',
});

// ============================================================================
// ENTITY
// ============================================================================

@ObjectType()
@Entity('tasks', { schema: 'farm' })
@Index(['tenantId', 'assignedTo', 'status'])
@Index(['tenantId', 'dueDate'])
@Index(['tenantId', 'status', 'priority'])
@Index(['status', 'dueDate'])
export class Task {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Field()
  @Column('uuid')
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

  @Field(() => TaskStatus)
  @Column({
    type: 'enum',
    enum: TaskStatus,
    default: TaskStatus.PENDING,
  })
  status: TaskStatus;

  // -------------------------------------------------------------------------
  // ATAMA
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  assignedTo: string;

  @Field()
  @Column({ length: 255 })
  assignedToName: string;

  @Field()
  @Column('uuid')
  createdBy: string;

  // -------------------------------------------------------------------------
  // PLANLAMA
  // -------------------------------------------------------------------------

  @Field()
  @Column({ type: 'date' })
  dueDate: Date;

  @Field({ nullable: true })
  @Column({ type: 'time', nullable: true })
  dueTime?: string;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  siteId?: string;

  @Field({ nullable: true })
  @Column({ type: 'varchar', nullable: true })
  location?: string;

  @Field(() => Int, { nullable: true })
  @Column({ type: 'int', nullable: true })
  estimatedMinutes?: number;

  // -------------------------------------------------------------------------
  // CHECKLIST VE NOTLAR
  // -------------------------------------------------------------------------

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', default: [] })
  checklistItems: TaskChecklistItem[];

  @Field(() => GraphQLJSON, { nullable: true })
  @Column({ type: 'jsonb', default: [] })
  notes: TaskNote[];

  // -------------------------------------------------------------------------
  // ETIKETLER
  // -------------------------------------------------------------------------

  @Field(() => [String], { nullable: true })
  @Column({ type: 'jsonb', nullable: true, default: [] })
  tags?: string[];

  // -------------------------------------------------------------------------
  // TEKRARLAMA
  // -------------------------------------------------------------------------

  @Field()
  @Column({ default: false })
  isRecurring: boolean;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  recurringTemplateId?: string;

  @Field()
  @Column({ default: false })
  isAutoGenerated: boolean;

  // -------------------------------------------------------------------------
  // TAMAMLAMA
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  completedAt?: Date;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  completedBy?: string;

  // -------------------------------------------------------------------------
  // AUDIT FIELDS
  // -------------------------------------------------------------------------

  @Field({ nullable: true })
  @DeleteDateColumn({ type: 'timestamptz' })
  deletedAt?: Date;

  @Field()
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Field()
  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
