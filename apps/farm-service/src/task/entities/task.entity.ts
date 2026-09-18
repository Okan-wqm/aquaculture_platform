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
  GraphQLISODateTime,
  registerEnumType,
} from '@nestjs/graphql';

/**
 * STORED shape of a single item in `Task.checklistItems` (JSONB) — what a row
 * may hold, not what the wire promises.
 *
 * `isCompleted` is the CANONICAL field the `TaskChecklistItemInput` DTO writes
 * on creation AND the field the idempotent `TaskService.setChecklistItem` path
 * SETs to an absolute value (FARM-HIGH-057). The legacy `completed` field is
 * retained ONLY so the normaliser can read+migrate rows written by the former
 * `toggleChecklistItem` flip (which predated `isCompleted`); new writes never
 * emit it. Keeping this interface permissive documents the stored reality;
 * the wire contract is the canonical {@link TaskChecklistItem} below, served
 * through `TaskService.normaliseChecklistItems` on every read (FARM-HIGH-320).
 */
export interface StoredTaskChecklistItem {
  /** UUID, assigned by the service on first set / on creation. */
  id?: string;
  text: string;
  /** Canonical completion field — set on creation and by `setChecklistItem`. */
  isCompleted?: boolean;
  /** Legacy field from the old `toggleChecklistItem` flip; read by the normaliser, never re-emitted. */
  completed?: boolean;
  /** ISO-8601 completion timestamp; derived from the target state by `setChecklistItem`. */
  completedAt?: string | null;
  completedBy?: string;
}

/**
 * CANONICAL checklist item — the shape `TaskService.normaliseChecklistItem`
 * returns and the ONLY shape the GraphQL wire carries (FARM-HIGH-320). It used
 * to be served as a `JSON` scalar, which typed the field as an opaque object in
 * every client and left each of them to re-implement the normaliser.
 */
@ObjectType()
export class TaskChecklistItem {
  @Field(() => ID)
  id!: string;

  @Field()
  text!: string;

  @Field()
  isCompleted!: boolean;

  /** ISO-8601 completion timestamp; null once un-ticked. */
  @Field(() => String, { nullable: true })
  completedAt?: string | null;

  @Field(() => String, { nullable: true })
  completedBy?: string;
}

/**
 * A note on a task (`Task.notes`, JSONB). Written exclusively by
 * `TaskService.addNote` — the shape is under that service's control, so the
 * column is served as this object type directly (FARM-HIGH-320).
 */
@ObjectType()
export class TaskNote {
  @Field(() => ID)
  id!: string;

  @Field()
  text!: string;

  @Field()
  createdBy!: string;

  /** ISO-8601 string. */
  @Field()
  createdAt!: string;
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
@Entity('tasks')
@Index(['tenantId', 'assignedTo', 'status'])
@Index(['tenantId', 'dueDate'])
@Index(['tenantId', 'status', 'priority'])
@Index(['status', 'dueDate'])
export class Task {
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

  @Field(() => TaskStatus)
  @Column({
    type: 'enum',
    enum: TaskStatus,
    default: TaskStatus.PENDING,
  })
  status!: TaskStatus;

  // -------------------------------------------------------------------------
  // ATAMA
  // -------------------------------------------------------------------------

  @Field()
  @Column('uuid')
  assignedTo!: string;

  @Field()
  @Column({ length: 255 })
  assignedToName!: string;

  @Field()
  @Column('uuid')
  createdBy!: string;

  // -------------------------------------------------------------------------
  // PLANLAMA
  // -------------------------------------------------------------------------

  @Field()
  @Column({ type: 'date' })
  dueDate!: Date;

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

  /**
   * No `@Field` here on purpose: the wire field `checklistItems` is a
   * `@ResolveField` on TaskResolver that runs the write-path normaliser, so a
   * legacy row (`completed` instead of `isCompleted`, no id) reads canonical.
   */
  @Column({ type: 'jsonb', default: [] })
  checklistItems!: StoredTaskChecklistItem[];

  @Field(() => [TaskNote])
  @Column({ type: 'jsonb', default: [] })
  notes!: TaskNote[];

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
  isRecurring!: boolean;

  @Field({ nullable: true })
  @Column('uuid', { nullable: true })
  recurringTemplateId?: string;

  @Field()
  @Column({ default: false })
  isAutoGenerated!: boolean;

  // -------------------------------------------------------------------------
  // TAMAMLAMA
  // -------------------------------------------------------------------------

  // WHY explicit type thunks: the property type is now the union `Date | null`
  // (FARM-HIGH-056 — `clearCompletion()` SETs null so TypeORM emits SET … = NULL
  // instead of skipping an `undefined` field). reflect-metadata reflects a union
  // as `Object`, so a bare `@Field({ nullable: true })` can no longer infer the
  // GraphQL scalar and the SDL emitter aborts with "Undefined type error". The
  // explicit thunk (GraphQLISODateTime for the timestamp, ID for the UUID) pins
  // the GraphQL type independently of the widened TS union.
  @Field(() => GraphQLISODateTime, { nullable: true })
  @Column({ type: 'timestamptz', nullable: true })
  completedAt?: Date | null;

  @Field(() => ID, { nullable: true })
  @Column('uuid', { nullable: true })
  completedBy?: string | null;

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

  /**
   * FARM-HIGH-056 — business invariant: a non-completed task has NULL
   * completion fields.
   *
   * WHY: the FSM allows COMPLETED -> PENDING (a "reopen"). Without clearing
   * these, a reopened PENDING task keeps a stale `completedAt`/`completedBy`,
   * lying about being done and corrupting the completionRate /
   * avgCompletionMinutes statistics SQL (both key off `completedAt`).
   *
   * WHAT: nulls both completion fields. Called at the single write site when a
   * status transition leaves COMPLETED, so the reset is defined once (SSoT) and
   * cannot drift from the reopen logic.
   */
  clearCompletion(): void {
    // null (NOT undefined): TypeORM SKIPS undefined fields on save (treats them as
    // "no change"), so undefined would leave the stale DB values in place. Explicit
    // null emits `SET completedAt = NULL` / `completedBy = NULL`.
    this.completedAt = null;
    this.completedBy = null;
  }
}
