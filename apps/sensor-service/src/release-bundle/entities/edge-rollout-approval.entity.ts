import { Field, ID, ObjectType } from '@nestjs/graphql';
import { Check, Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * One person's approval of one rollout plan (ADR-048 DEC-2.4): the edge-update
 * statement carries no approvals in P1, so the two registered people the
 * decision requires are enforced and recorded here, on the cloud. A row is
 * evidence and is never edited: it says who confirmed which plan digest, when.
 *
 * `(rollout_id, approver_id)` is unique, so one person is one approval however
 * many times they ask; a rollout is approved by distinct people only.
 *
 * Per-tenant table — no `schema:` (ADR-011 search_path routing).
 */
@ObjectType('EdgeRolloutApproval')
@Entity('edge_rollout_approvals')
@Check('CHK_edge_rollout_approvals_digest', `"plan_sha256" ~ '^[0-9a-f]{64}$'`)
@Index('uq_edge_rollout_approvals_rollout_approver', ['rolloutId', 'approverId'], { unique: true })
@Index('idx_edge_rollout_approvals_tenant_rollout', ['tenantId', 'rolloutId'])
export class EdgeRolloutApproval {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field(() => ID)
  @Column({ type: 'uuid', name: 'rollout_id' })
  rolloutId!: string;

  /** The authenticated user (JWT subject) who approved. */
  @Field(() => String)
  @Column({ type: 'varchar', length: 128, name: 'approver_id' })
  approverId!: string;

  /** The plan digest the approver confirmed; equal to the rollout's `plan_sha256`. */
  @Field()
  @Column({ type: 'char', length: 64, name: 'plan_sha256' })
  planSha256!: string;

  @Field()
  @CreateDateColumn({ name: 'approved_at', type: 'timestamptz' })
  approvedAt!: Date;
}
