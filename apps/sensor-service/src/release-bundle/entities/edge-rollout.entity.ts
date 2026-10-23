import { Field, ID, Int, ObjectType, registerEnumType } from '@nestjs/graphql';
import { GraphQLJSON } from 'graphql-scalars';
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * Where a rollout stands (ADR-048 DEC-2.4, DEC-23).
 *
 * ```text
 *  AWAITING_APPROVAL ──► RUNNING ──► COMPLETED
 *          │                │
 *          ▼                ├──────► HALTED
 *      CANCELLED ◄──────────┘
 * ```
 *
 * AWAITING_APPROVAL  the plan exists; nothing is signed for any device until two
 *                    registered people have approved this exact plan
 * RUNNING            approved: the wave in turn is signed for its devices and delivered
 * COMPLETED          every device concluded (done, or failed within the allowed failures)
 * HALTED             more devices failed than the plan allows; no further wave is issued
 * CANCELLED          an operator ended it; undelivered requests are concluded
 *
 * The transition map in `edge-rollout.service.ts` is the SSoT for which edges
 * exist; RUNNING is entered only from `EdgeRolloutService.approve`.
 */
export enum EdgeRolloutState {
  AWAITING_APPROVAL = 'awaiting-approval',
  RUNNING = 'running',
  COMPLETED = 'completed',
  HALTED = 'halted',
  CANCELLED = 'cancelled',
}

registerEnumType(EdgeRolloutState, {
  name: 'EdgeRolloutState',
  description: 'Where a cohort rollout of an agent release or an OS bundle stands',
});

/** What a rollout installs: an agent release or an OS bundle. */
export enum EdgeRolloutKind {
  EDGE_UPDATE = 'edge-update',
  OS_UPDATE = 'os-update',
}

registerEnumType(EdgeRolloutKind, {
  name: 'EdgeRolloutKind',
  description: 'The statement a rollout signs for each device: an edge-update or an os-update',
});

/** Where one device of a rollout stands, read from its request's campaign. */
export enum EdgeRolloutDevicePhase {
  QUEUED = 'queued',
  IN_FLIGHT = 'in-flight',
  DONE = 'done',
  FAILED = 'failed',
}

registerEnumType(EdgeRolloutDevicePhase, {
  name: 'EdgeRolloutDevicePhase',
  description: 'Where one device of a rollout stands: not signed yet, in flight, done or failed',
});

/** The least number of distinct people whose approval a rollout needs (DEC-2.4). */
export const MIN_ROLLOUT_APPROVALS = 2;

const STATES = Object.values(EdgeRolloutState)
  .map((state) => `'${state}'`)
  .join(', ');
const KINDS = Object.values(EdgeRolloutKind)
  .map((kind) => `'${kind}'`)
  .join(', ');

/**
 * A plan to take a cohort of Suderra OS devices to one agent release or one OS
 * bundle, in waves, and the state of carrying it out. The plan (kind, target,
 * terms, window, cohort, failure allowance) never changes after creation;
 * `plan_sha256` is the digest of it, and an approval names that digest, so an
 * approval is for exactly this plan.
 *
 * Per-tenant table — no `schema:` (ADR-011 search_path routing).
 */
@ObjectType('EdgeRollout')
@Entity('edge_rollouts')
@Check('CHK_edge_rollouts_state', `"state" IN (${STATES})`)
@Check('CHK_edge_rollouts_kind', `"kind" IN (${KINDS})`)
@Check('CHK_edge_rollouts_plan_digest', `"plan_sha256" ~ '^[0-9a-f]{64}$'`)
@Check('CHK_edge_rollouts_approvals', `"approvals_required" >= ${MIN_ROLLOUT_APPROVALS}`)
@Check('CHK_edge_rollouts_failures', `"max_failures" >= 0`)
@Check('CHK_edge_rollouts_window', `"window_seconds" > 0`)
@Index('idx_edge_rollouts_state', ['tenantId', 'state'])
export class EdgeRollout {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field()
  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Field(() => EdgeRolloutKind)
  @Column({ type: 'varchar', length: 16 })
  kind!: EdgeRolloutKind;

  /** `{ version }` of an agent release, or the OS bundle's descriptor. */
  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  target!: Record<string, unknown>;

  /** The terms root applies the update under (local approval, blockers override, outage budget). */
  @Field(() => GraphQLJSON)
  @Column({ type: 'jsonb' })
  terms!: Record<string, unknown>;

  /** The first moment a statement of this rollout is valid; null means from when it is signed. */
  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', name: 'window_not_before', nullable: true })
  windowNotBefore!: Date | null;

  /** How long each statement stays valid (at most what the agent keeps a request). */
  @Field(() => Int)
  @Column({ type: 'int', name: 'window_seconds' })
  windowSeconds!: number;

  /** The rollout halts when more devices than this fail. */
  @Field(() => Int)
  @Column({ type: 'int', name: 'max_failures', default: 0 })
  maxFailures!: number;

  /** How many distinct people must approve; never below {@link MIN_ROLLOUT_APPROVALS}. */
  @Field(() => Int)
  @Column({ type: 'smallint', name: 'approvals_required', default: MIN_ROLLOUT_APPROVALS })
  approvalsRequired!: number;

  /** sha256 over the canonical plan: what an approval confirms. */
  @Field()
  @Column({ type: 'char', length: 64, name: 'plan_sha256' })
  planSha256!: string;

  @Field(() => EdgeRolloutState)
  @Column({ type: 'varchar', length: 24, default: EdgeRolloutState.AWAITING_APPROVAL })
  state!: EdgeRolloutState;

  /** Why a halted or cancelled rollout ended. */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 256, name: 'state_detail', nullable: true })
  stateDetail!: string | null;

  @Field(() => String)
  @Column({ type: 'varchar', length: 128, name: 'created_by' })
  createdBy!: string;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', name: 'approved_at', nullable: true })
  approvedAt!: Date | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', name: 'concluded_at', nullable: true })
  concludedAt!: Date | null;

  @Field()
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
