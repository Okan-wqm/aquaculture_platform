import { createHash } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import {
  agentFindingIssuedTotal,
  agentFindingStateTransitionTotal,
} from '../metrics/orchestrator-metrics';

import { FindingEntity } from './finding.entity';

/**
 * FindingRegistryService — Phase 12.1 completion.
 *
 * NestJS-injectable wrapper over `event_store.findings` that
 * preserves the hash-chain invariants mirrored from the jsonl
 * registry. Mutation discipline:
 *
 *   - `append(stub)` appends a new row at the chain tail. The
 *     advisory-lock serialises concurrent pods' writes so every
 *     caller sees a linear tail at insert time. prev_hash is
 *     computed from the current tail's content_hash; content_hash
 *     is sha256(canonical JSON of the row MINUS content_hash).
 *
 *   - `close(id, shortSha)` appends a NEW row representing the
 *     state transition (OPEN/IN-PROGRESS → RESOLVED). Because
 *     the underlying table is UPDATE-blocked by trigger, state
 *     changes are surfaced as additional rows; the logical
 *     "latest" row per business id is the one with the highest
 *     chain_seq for that id.
 *
 *   - `verify()` recomputes the chain end-to-end.
 *
 * The canonical JSON + sha256 algorithm MUST match exactly the
 * one in:
 *   - tools/gates/finding-registry.ts:canonicalJson
 *   - tools/scripts/seed-finding-registry.mjs
 *   - tests/invariants/finding-registry-integrity.spec.ts
 *   - tests/invariants/three-store-invariants.spec.ts
 *
 * Any divergence silently breaks the chain + the three-store
 * invariants across jsonl + PG + commit trailers.
 *
 * # Advisory lock
 *
 * `pg_advisory_xact_lock(<namespace>)` serialises all writers
 * within a transaction. Namespace = hashtext('event_store.findings.append')
 * = a stable int64 derived from the string. One concurrent writer
 * per PG instance at a time on this namespace — the other writers
 * block on the lock, NOT on the row, which means the `findings_id_
 * unique` constraint never races against itself.
 *
 * # Not yet wired into callers
 *
 * orchestrator-runner + tools/gates/finding-registry.ts CLI do
 * NOT yet talk to this service. Wiring is follow-on work:
 *
 *   - CLI gains a `--backend pg|jsonl` flag routed via env var.
 *   - orchestrator-runner consults isLeader() before calling
 *     append() (single-writer discipline across K8s replicas).
 *
 * This commit lands the service so the wiring has a contract.
 */

export interface FindingStub {
  id: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  state: 'OPEN' | 'IN-PROGRESS' | 'RESOLVED' | 'STALE' | 'BLOCKED';
  title: string;
  layer: 1 | 2 | 3 | 4;
  ownerAgent: string;
  raisedInCycle: string;
  reviewFile?: string | null;
  evidence?: Array<string | Record<string, unknown>>;
  ruleViolated?: string | null;
  notes?: string | null;
  deadline?: Date | null;
  ownerUser?: string | null;
  overrideOf?: string | null;
  originFindings?: string[];
  supersedesId?: string | null;
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  firstFailureIndex: number | null;
  reason: string | null;
  chainTip: string | null;
}

const ZERO_HASH = '0'.repeat(64);
const ADVISORY_LOCK_NAMESPACE = 'event_store.findings.append';

@Injectable()
export class FindingRegistryService {
  private readonly logger = new Logger(FindingRegistryService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(FindingEntity)
    private readonly findingRepository: Repository<FindingEntity>,
  ) {}

  /**
   * Append a new finding at the chain tail. Advisory-lock-serialised
   * across concurrent writers. Returns the persisted row.
   */
  async append(stub: FindingStub): Promise<FindingEntity> {
    return this.dataSource.transaction(async (manager) => {
      // Acquire advisory lock — blocks concurrent appends from any
      // other pod on the same PG. Released on COMMIT/ROLLBACK.
      await manager.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [ADVISORY_LOCK_NAMESPACE]);

      const tail = await manager.findOne(FindingEntity, {
        where: {},
        order: { chainSeq: 'DESC' },
      });
      const prevHash = tail?.contentHash ?? ZERO_HASH;

      const entity = manager.create(FindingEntity, {
        id: stub.id,
        severity: stub.severity,
        state: stub.state,
        title: stub.title,
        layer: stub.layer,
        ownerAgent: stub.ownerAgent,
        raisedInCycle: stub.raisedInCycle,
        reviewFile: stub.reviewFile ?? null,
        closedAt: stub.state === 'RESOLVED' ? new Date() : null,
        closingCommits: [],
        deadline: stub.deadline ?? null,
        ownerUser: stub.ownerUser ?? null,
        overrideOf: stub.overrideOf ?? null,
        notes: stub.notes ?? null,
        evidence: stub.evidence ?? [],
        ruleViolated: stub.ruleViolated ?? null,
        originFindings: stub.originFindings ?? [],
        supersedesId: stub.supersedesId ?? null,
        prevHash,
        contentHash: ZERO_HASH, // placeholder; filled below
      });

      entity.contentHash = this.computeContentHash(entity);
      const saved = await manager.save(FindingEntity, entity);

      agentFindingIssuedTotal.inc({
        severity: saved.severity,
        agent: saved.ownerAgent,
      });
      this.logger.log(
        `Appended finding ${saved.id} (${saved.severity}/${saved.state}) at chain_seq=${saved.chainSeq}, hash=${saved.contentHash.slice(0, 8)}…`,
      );
      return saved;
    });
  }

  /**
   * Record a state transition as a NEW appended row. Mirrors the
   * jsonl CLI's close subcommand but via an append-only row instead
   * of mutation (the table trigger blocks UPDATE).
   *
   * Emits an agent_finding_state_transition_total counter.
   */
  async recordStateTransition(params: {
    id: string;
    toState: 'IN-PROGRESS' | 'RESOLVED' | 'STALE' | 'BLOCKED';
    closingCommitSha?: string;
    notes?: string;
  }): Promise<FindingEntity> {
    const latest = await this.findLatestById(params.id);
    if (!latest) {
      throw new Error(`recordStateTransition: finding ${params.id} not found`);
    }
    if (latest.state === params.toState) {
      this.logger.debug(`State transition no-op: ${params.id} already ${params.toState}.`);
      return latest;
    }

    const fromState = latest.state;
    const nextClosingCommits = [...latest.closingCommits];
    if (params.closingCommitSha) {
      if (!nextClosingCommits.includes(params.closingCommitSha)) {
        nextClosingCommits.push(params.closingCommitSha);
      }
    }

    // The transition row carries the SAME business id; uniqueness
    // is deliberately violated unless we relax the constraint OR
    // suffix the id. Policy: Phase 12.1 uses a suffix `#s<chainSeq>`
    // to keep the "one row per terminal id" shape AND allow history.
    const transitionId = `${params.id}#s-${Date.now()}`;

    const saved = await this.append({
      id: transitionId,
      severity: latest.severity,
      state: params.toState,
      title: `[transition] ${latest.title}`,
      layer: latest.layer,
      ownerAgent: latest.ownerAgent,
      raisedInCycle: latest.raisedInCycle,
      reviewFile: latest.reviewFile ?? undefined,
      evidence: latest.evidence,
      ruleViolated: latest.ruleViolated ?? undefined,
      notes: params.notes ?? `State transition: ${fromState} → ${params.toState}`,
      supersedesId: params.id,
      originFindings: latest.originFindings,
    });

    // closing_commits attribution lives in the stub's `notes` string
    // on transition rows and is reconciled by the Phase 12.1b
    // refinement step (separate commit) that extends append() to
    // accept closingCommits on the stub. This method returns the
    // appended row as-is; callers that need SHA attribution today
    // include it in `params.notes` verbatim.
    saved.closingCommits = nextClosingCommits;

    agentFindingStateTransitionTotal.inc({
      from_state: fromState,
      to_state: params.toState,
      severity: latest.severity,
    });
    return saved;
  }

  /**
   * Find the latest (highest chain_seq) row for a given business id.
   * Across state-transition rows that carry `#s-<ts>` suffixes, this
   * first tries an exact id match, then falls back to latest-by-
   * supersedesId.
   */
  async findLatestById(id: string): Promise<FindingEntity | null> {
    const exact = await this.findingRepository.findOne({
      where: { id },
      order: { chainSeq: 'DESC' },
    });
    if (exact) return exact;
    // Fall back: find the latest transition row whose supersedesId
    // matches.
    return this.findingRepository.findOne({
      where: { supersedesId: id },
      order: { chainSeq: 'DESC' },
    });
  }

  /**
   * Re-compute the chain end-to-end. Returns the first failure
   * index when the chain is corrupt. Matches the algorithm in
   * tests/invariants/finding-registry-integrity.spec.ts exactly.
   */
  async verify(): Promise<VerifyResult> {
    const entries = await this.findingRepository.find({
      order: { chainSeq: 'ASC' },
    });

    let prev = ZERO_HASH;
    for (const [i, entry] of entries.entries()) {
      if (entry.prevHash !== prev) {
        return {
          ok: false,
          entries: entries.length,
          firstFailureIndex: i,
          reason: `chain break at entry ${i} (${entry.id}): prev_hash=${entry.prevHash} expected=${prev}`,
          chainTip: null,
        };
      }
      const recomp = this.computeContentHash(entry);
      if (recomp !== entry.contentHash) {
        return {
          ok: false,
          entries: entries.length,
          firstFailureIndex: i,
          reason: `hash mismatch at entry ${i} (${entry.id}): recomputed=${recomp} stored=${entry.contentHash}`,
          chainTip: null,
        };
      }
      prev = entry.contentHash;
    }
    return {
      ok: true,
      entries: entries.length,
      firstFailureIndex: null,
      reason: null,
      chainTip: prev === ZERO_HASH ? null : prev,
    };
  }

  /**
   * Canonical JSON + sha256. MUST match tools/gates/finding-registry.ts
   * exactly.
   */
  private computeContentHash(entity: FindingEntity): string {
    // Serialise to the same shape the jsonl CLI hashes. Key names
    // match the jsonl schema (snake_case where appropriate) so the
    // PG-migrated rows can ever interop with the jsonl mirror.
    const shape = {
      id: entity.id,
      severity: entity.severity,
      state: entity.state,
      title: entity.title,
      layer: entity.layer,
      owner_agent: entity.ownerAgent,
      raised_in_cycle: entity.raisedInCycle,
      review_file: entity.reviewFile ?? null,
      created_at: entity.createdAt?.toISOString() ?? null,
      closed_at: entity.closedAt ? entity.closedAt.toISOString() : null,
      closing_commits: entity.closingCommits ?? [],
      deadline: entity.deadline ? entity.deadline.toISOString() : null,
      owner_user: entity.ownerUser ?? null,
      override_of: entity.overrideOf ?? null,
      notes: entity.notes ?? null,
      evidence: entity.evidence ?? [],
      rule_violated: entity.ruleViolated ?? null,
      origin_findings: entity.originFindings ?? [],
      supersedes_id: entity.supersedesId ?? null,
      prev_hash: entity.prevHash,
    };
    return sha256hex(canonicalJson(shape));
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJson).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

function sha256hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
