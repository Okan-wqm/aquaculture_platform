import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, QueryRunner } from 'typeorm';

import { NatsEventBus } from '@platform/event-bus';
import { INGEST_BACKEND_POLICY_SUBJECTS, IngressOwnerPolicy } from '@platform/event-contracts';

import { IngressOwnerPolicyEntity } from '../entities/ingress-owner-policy.entity';

export class IngressOwnerPolicyTransitionError extends Error {}

export interface AppendIngressOwnerPolicyInput {
  policy: IngressOwnerPolicy;
  drainBarrierSatisfied: boolean;
  drainBarrierEvidence?: string;
  actorId?: string;
}

interface RawIngressOwnerPolicyRow {
  tenantId: string;
  version: number;
  owner: IngressOwnerPolicy['owner'];
  effectiveEpoch: Date;
  state: IngressOwnerPolicy['state'];
}

@Injectable()
export class IngressOwnerPolicyService {
  private readonly logger = new Logger(IngressOwnerPolicyService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly eventBus: NatsEventBus,
  ) {}

  async append(input: AppendIngressOwnerPolicyInput): Promise<IngressOwnerPolicy> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction('SERIALIZABLE');
    try {
      await queryRunner.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        input.policy.tenantId,
      ]);
      const current = await this.findLatestForUpdate(queryRunner, input.policy.tenantId);
      assertDrainBarrierEvidence(input.drainBarrierSatisfied, input.drainBarrierEvidence);
      if (!isExactIngressOwnerPolicyReplay(current, input)) {
        assertIngressOwnerTransition(
          current === null ? null : toPolicyEntity(current),
          input.policy,
          input.drainBarrierSatisfied,
        );
        await queryRunner.query(
          `INSERT INTO admin.ingress_owner_policies
            (tenant_id, version, owner, effective_epoch, state,
             drain_barrier_satisfied, drain_barrier_evidence, actor_id)
           VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8)`,
          [
            input.policy.tenantId,
            input.policy.version,
            input.policy.owner,
            input.policy.effectiveEpoch,
            input.policy.state,
            input.drainBarrierSatisfied,
            input.drainBarrierEvidence ?? null,
            input.actorId ?? null,
          ],
        );
      }
      await queryRunner.commitTransaction();
    } catch (error) {
      await queryRunner.rollbackTransaction();
      if (error instanceof IngressOwnerPolicyTransitionError) {
        throw new ConflictException(error.message);
      }
      throw error;
    } finally {
      await queryRunner.release();
    }

    await this.publish(input.policy);
    return input.policy;
  }

  async getSnapshot(): Promise<IngressOwnerPolicy[]> {
    const rows = await this.dataSource.query<RawIngressOwnerPolicyRow[]>(
      `SELECT DISTINCT ON (tenant_id)
         tenant_id AS "tenantId", version, owner,
         effective_epoch AS "effectiveEpoch", state
       FROM admin.ingress_owner_policies
       ORDER BY tenant_id, version DESC`,
    );
    return rows.map(toPolicy);
  }

  private async findLatestForUpdate(
    queryRunner: QueryRunner,
    tenantId: string,
  ): Promise<IngressOwnerPolicyEntity | null> {
    return queryRunner.manager.findOne(IngressOwnerPolicyEntity, {
      where: { tenantId },
      order: { version: 'DESC' },
      lock: { mode: 'pessimistic_write' },
    });
  }

  private async publish(policy: IngressOwnerPolicy): Promise<void> {
    const subject = `${INGEST_BACKEND_POLICY_SUBJECTS.ownerChangedPrefix}.${policy.tenantId}`;
    const payload = new TextEncoder().encode(JSON.stringify(policy));
    try {
      await this.eventBus.publishCore(subject, payload);
    } catch (error) {
      this.logger.error(
        `owner-policy publish failed subject=${subject}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw error;
    }
  }
}

function isExactIngressOwnerPolicyReplay(
  current: IngressOwnerPolicyEntity | null,
  input: AppendIngressOwnerPolicyInput,
): boolean {
  return (
    current !== null &&
    current.tenantId === input.policy.tenantId &&
    current.version === input.policy.version &&
    current.owner === input.policy.owner &&
    current.effectiveEpoch.toISOString() === input.policy.effectiveEpoch &&
    current.state === input.policy.state &&
    current.drainBarrierSatisfied === input.drainBarrierSatisfied &&
    current.drainBarrierEvidence === (input.drainBarrierEvidence ?? null)
  );
}

function toPolicyEntity(row: IngressOwnerPolicyEntity): IngressOwnerPolicy {
  return {
    tenantId: row.tenantId,
    version: row.version,
    owner: row.owner,
    effectiveEpoch: row.effectiveEpoch.toISOString(),
    state: row.state,
  };
}

export function assertDrainBarrierEvidence(
  drainBarrierSatisfied: boolean,
  drainBarrierEvidence: string | undefined,
): void {
  const evidence = drainBarrierEvidence?.trim();
  if (drainBarrierSatisfied && (evidence === undefined || evidence.length === 0)) {
    throw new IngressOwnerPolicyTransitionError(
      'a satisfied drain barrier requires durable evidence',
    );
  }
  if (evidence !== undefined && evidence.length > 128) {
    throw new IngressOwnerPolicyTransitionError(
      'drain barrier evidence must not exceed 128 characters',
    );
  }
  if (!drainBarrierSatisfied && evidence !== undefined && evidence.length > 0) {
    throw new IngressOwnerPolicyTransitionError(
      'drain barrier evidence cannot be recorded when the barrier is not satisfied',
    );
  }
}

export function assertIngressOwnerTransition(
  current: IngressOwnerPolicy | null,
  next: IngressOwnerPolicy,
  drainBarrierSatisfied: boolean,
): void {
  if (!Number.isInteger(next.version) || next.version < 1) {
    throw new IngressOwnerPolicyTransitionError('policy version must be a positive integer');
  }
  if (!Number.isFinite(Date.parse(next.effectiveEpoch))) {
    throw new IngressOwnerPolicyTransitionError('effective epoch must be RFC3339');
  }
  if (current === null) {
    if (next.version !== 1 || next.state !== 'PREPARING') {
      throw new IngressOwnerPolicyTransitionError(
        'initial owner policy must be PREPARING at version 1',
      );
    }
    return;
  }
  if (current.tenantId !== next.tenantId) {
    throw new IngressOwnerPolicyTransitionError('tenant identity cannot change');
  }
  if (next.version !== current.version + 1) {
    throw new IngressOwnerPolicyTransitionError(
      `next owner policy must use version ${current.version + 1}`,
    );
  }

  const sameEpoch = current.effectiveEpoch === next.effectiveEpoch;
  const sameOwner = current.owner === next.owner;
  if (current.state === 'PREPARING' && next.state === 'ACTIVE') {
    if (!sameEpoch || !sameOwner || !drainBarrierSatisfied) {
      throw new IngressOwnerPolicyTransitionError(
        'PREPARING activation requires the same owner/epoch and a proven drain barrier',
      );
    }
    return;
  }
  if (current.state === 'ACTIVE' && next.state === 'DRAINING') {
    if (!sameEpoch || !sameOwner) {
      throw new IngressOwnerPolicyTransitionError(
        'ACTIVE must enter DRAINING without changing owner or epoch',
      );
    }
    return;
  }
  if (current.state === 'DRAINING' && next.state === 'PREPARING') {
    if (!drainBarrierSatisfied || sameEpoch) {
      throw new IngressOwnerPolicyTransitionError(
        'DRAINING handoff requires a proven drain barrier and a new epoch',
      );
    }
    return;
  }
  if (current.state === 'ACTIVE') {
    throw new IngressOwnerPolicyTransitionError(
      `ACTIVE owner must enter DRAINING before ${next.state}`,
    );
  }
  throw new IngressOwnerPolicyTransitionError(
    `invalid owner-policy transition ${current.state} -> ${next.state}`,
  );
}

function toPolicy(row: RawIngressOwnerPolicyRow): IngressOwnerPolicy {
  return {
    tenantId: row.tenantId,
    version: row.version,
    owner: row.owner,
    effectiveEpoch: row.effectiveEpoch.toISOString(),
    state: row.state,
  };
}
