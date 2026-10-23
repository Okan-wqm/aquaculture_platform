import { Field, Float, ID, ObjectType, registerEnumType } from '@nestjs/graphql';
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
 * Where an update request stands (ADR-048 DEC-2.12; channels.json
 * update_channel.settlement). One request is one signed statement the cloud owes a
 * device; it ends with exactly one result document that names the statement digest,
 * and what the cloud does about the end depends on the refusal's class.
 *
 *   PENDING     owed: delivered on the device's heartbeats inside its window,
 *               until the agent hands it to root, and open until a result says more
 *   DONE        concluded ok
 *   RETRY       concluded by a retryable refusal (clock-unsynced, fetch-failed,
 *               io-error, maintenance-blocked, not-yet-valid): the intent is issued
 *               again as a NEW statement, no earlier than the contract's interval
 *   RESCHEDULE  concluded by approval-missing or expired: the window passed without
 *               the update; only an operator chooses another window
 *   FAILED      concluded by a final refusal, by a retryable intent whose campaign
 *               ran out, by a re-issue the cloud would not sign, or by the device
 *               rolling the installed update back: recovery is a different
 *               statement; the operator is told (`failure_detail` says which when
 *               it was the cloud that ended it)
 *   LAPSED      nothing concluded it by expires_at (silence ends at the window)
 *   REISSUED    a RETRY request replaced by a new statement (`superseded_by`)
 */
export enum EdgeUpdateRequestState {
  PENDING = 'pending',
  DONE = 'done',
  RETRY = 'retry',
  RESCHEDULE = 'reschedule',
  FAILED = 'failed',
  LAPSED = 'lapsed',
  REISSUED = 'reissued',
}

registerEnumType(EdgeUpdateRequestState, {
  name: 'EdgeUpdateRequestState',
  description: 'Where a signed update request owed to a Suderra OS device stands',
});

const STATES = Object.values(EdgeUpdateRequestState)
  .map((state) => `'${state}'`)
  .join(', ');

/**
 * One signed statement the cloud owes a Suderra OS device on the update channel
 * (edge-update, os-update, site-config, site-netpolicy, trust-anchors), stored
 * exactly as it was signed — the DSSE envelope JSON, the bytes the agent carries
 * to root — with the window it may be delivered in and what the device reported
 * about it.
 *
 * A request is never edited into another statement: a re-issue is a new row of
 * the same `intent_id` (the campaign), with a later window and a greater
 * `update_seq` (a verified statement spends its sequence value before the
 * maintenance gate, so a refused one cannot be replayed).
 *
 * Per-tenant table — no `schema:` (ADR-011 search_path routing).
 */
@ObjectType('EdgeUpdateRequest')
@Entity('edge_update_requests')
@Check('CHK_edge_update_requests_state', `"state" IN (${STATES})`)
@Check(
  'CHK_edge_update_requests_statement_type',
  `"statement_type" IN ('suderra.edge-update.v1', 'suderra.os-update.v1', 'suderra.site-config.v1', 'suderra.site-netpolicy.v1', 'suderra.trust-anchors.v1')`,
)
@Check('CHK_edge_update_requests_digest', `"statement_digest" ~ '^[0-9a-f]{64}$'`)
@Check('CHK_edge_update_requests_window', `"expires_at" IS NULL OR "expires_at" > "not_before"`)
@Index('uq_edge_update_requests_device_digest', ['deviceId', 'statementDigest'], { unique: true })
@Index('idx_edge_update_requests_device_state', ['tenantId', 'deviceId', 'state'])
@Index('idx_edge_update_requests_intent', ['tenantId', 'intentId'])
@Index('idx_edge_update_requests_rollout', ['tenantId', 'rolloutId'])
export class EdgeUpdateRequest {
  @Field(() => ID)
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @Field(() => ID)
  @Column({ type: 'uuid', name: 'device_id' })
  deviceId!: string;

  /** The rollout this request belongs to, when it is one (no foreign key: a rollout is deleted by retention, a request is evidence). */
  @Field(() => ID, { nullable: true })
  @Column({ type: 'uuid', name: 'rollout_id', nullable: true })
  rolloutId!: string | null;

  /** The campaign: every statement issued for one intent shares it. */
  @Field(() => ID)
  @Column({ type: 'uuid', name: 'intent_id' })
  intentId!: string;

  @Field()
  @Column({ type: 'varchar', length: 40, name: 'statement_type' })
  statementType!: string;

  /** The statement's update_seq; null for a trust-anchors bundle, which carries none. */
  @Field(() => Float, { nullable: true })
  @Column({
    type: 'bigint',
    name: 'update_seq',
    nullable: true,
    transformer: {
      to: (value: number | null): number | null => value,
      from: (value: string | number | null): number | null =>
        value === null ? null : Number(value),
    },
  })
  updateSeq!: number | null;

  @Field()
  @Column({ type: 'char', length: 64, name: 'statement_digest' })
  statementDigest!: string;

  /** The DSSE envelope JSON as the cloud produced it: what the agent carries, verbatim. */
  @Column({ type: 'text' })
  statement!: string;

  /** For a site-config: the suderra.site-bundle.v1 document served at the signed URL, inside the window only. */
  @Column({ type: 'text', name: 'site_bundle', nullable: true })
  siteBundle!: string | null;

  /** What re-issues this request: the intent's parameters, never a statement. */
  @Column({ type: 'jsonb' })
  recipe!: Record<string, unknown>;

  @Field()
  @Column({ type: 'timestamptz', name: 'not_before' })
  notBefore!: Date;

  /** Null for a statement with no window of its own (trust-anchors). */
  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', name: 'expires_at', nullable: true })
  expiresAt!: Date | null;

  @Field(() => EdgeUpdateRequestState)
  @Column({ type: 'varchar', length: 16, default: EdgeUpdateRequestState.PENDING })
  state!: EdgeUpdateRequestState;

  /** The last claimed delivery (paces redelivery across replicas). */
  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', name: 'delivered_at', nullable: true })
  deliveredAt!: Date | null;

  /** The command id of that delivery: the agent echoes it, so a refusal names its request. */
  @Column({ type: 'uuid', name: 'last_command_id', nullable: true })
  lastCommandId!: string | null;

  /** The agent wrote the statement into the spool: root has it, whatever it concludes. */
  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', name: 'handed_at', nullable: true })
  handedAt!: Date | null;

  /** Why the agent refused to hand the statement over, when it did (never a root verdict). */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 256, name: 'handoff_refusal', nullable: true })
  handoffRefusal!: string | null;

  /** Why the cloud, not the device's verdict alone, ended the request as failed. */
  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 256, name: 'failure_detail', nullable: true })
  failureDetail!: string | null;

  /** The result that concluded the request (its seq, outcome and reason). */
  @Field(() => Float, { nullable: true })
  @Column({
    type: 'bigint',
    name: 'settled_result_seq',
    nullable: true,
    transformer: {
      to: (value: number | null): number | null => value,
      from: (value: string | number | null): number | null =>
        value === null ? null : Number(value),
    },
  })
  settledResultSeq!: number | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 16, name: 'settled_outcome', nullable: true })
  settledOutcome!: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 64, name: 'settled_reason', nullable: true })
  settledReason!: string | null;

  @Field(() => Date, { nullable: true })
  @Column({ type: 'timestamptz', name: 'settled_at', nullable: true })
  settledAt!: Date | null;

  /** The first statement of the intent was issued then; the campaign ends 7 days later. */
  @Column({ type: 'timestamptz', name: 'campaign_started_at' })
  campaignStartedAt!: Date;

  /** The request that replaced this one after a retryable refusal. */
  @Field(() => ID, { nullable: true })
  @Column({ type: 'uuid', name: 'superseded_by', nullable: true })
  supersededBy!: string | null;

  @Field(() => String, { nullable: true })
  @Column({ type: 'varchar', length: 128, name: 'created_by', nullable: true })
  createdBy!: string | null;

  @Field()
  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Field()
  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
