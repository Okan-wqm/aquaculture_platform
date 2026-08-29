import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

import type { IngressOwner, IngressOwnerPolicyState } from '@platform/event-contracts';

@Entity('ingress_owner_policies', { schema: 'admin' })
export class IngressOwnerPolicyEntity {
  @PrimaryColumn({ type: 'uuid', name: 'tenant_id' })
  tenantId!: string;

  @PrimaryColumn({ type: 'integer' })
  version!: number;

  @Column({ type: 'varchar', length: 8 })
  owner!: IngressOwner;

  @Column({ type: 'timestamptz', name: 'effective_epoch' })
  effectiveEpoch!: Date;

  @Column({ type: 'varchar', length: 12 })
  state!: IngressOwnerPolicyState;

  @Column({ type: 'boolean', name: 'drain_barrier_satisfied' })
  drainBarrierSatisfied!: boolean;

  @Column({ type: 'varchar', length: 128, name: 'drain_barrier_evidence', nullable: true })
  drainBarrierEvidence!: string | null;

  @Column({ type: 'uuid', name: 'actor_id', nullable: true })
  actorId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
