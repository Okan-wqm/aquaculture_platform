import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  FINDING_EVENT_APPEND_LOCK_NAMESPACE,
  FINDING_EVENT_ZERO_HASH,
  FindingEventReplayError,
  computeFindingEventHash,
  replayFindingEvents,
  replayFindingProjection,
  type FindingEvent,
  type FindingEventPayloadMap,
  type FindingEventType,
  type FindingProjection,
} from '@aquaculture/backend-common/finding-registry';
import {
  agentFindingIssuedTotal,
  agentFindingStateTransitionTotal,
} from '@aquaculture/backend-common/metrics';
import { randomUUID } from 'node:crypto';
import { DataSource, EntityManager, Repository } from 'typeorm';

import { FindingEventEntity } from './finding-event.entity';

export interface AppendFindingEventInput<T extends FindingEventType> {
  finding_id: string;
  expected_version: number;
  event_type: T;
  payload: FindingEventPayloadMap[T];
  main_sha: string;
  occurred_at?: string;
  event_id?: string;
}

export interface VerifyResult {
  ok: boolean;
  entries: number;
  firstFailureIndex: number | null;
  reason: string | null;
  chainTip: string | null;
}

/**
 * Single mutation kernel for the PostgreSQL finding-event ledger.
 *
 * A transaction-scoped advisory lock linearizes the global hash chain across
 * pods. expected_version provides optimistic concurrency per stable finding
 * identity. The database additionally enforces UNIQUE(finding_id, version)
 * and rejects every destructive mutation.
 */
@Injectable()
export class FindingRegistryService {
  private readonly logger = new Logger(FindingRegistryService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(FindingEventEntity)
    private readonly eventRepository: Repository<FindingEventEntity>,
  ) {}

  async appendEvent<T extends FindingEventType>(
    input: AppendFindingEventInput<T>,
  ): Promise<FindingEvent<T>> {
    assertMainSha(input.main_sha);
    if (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1) {
      throw new Error('expected_version must be a positive safe integer');
    }

    const committed = await this.dataSource.transaction(async (manager) => {
      await manager.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        FINDING_EVENT_APPEND_LOCK_NAMESPACE,
      ]);

      const tail = await manager.findOne(FindingEventEntity, {
        where: {},
        order: { ledgerSeq: 'DESC' },
      });
      const history = await manager.find(FindingEventEntity, {
        where: { findingId: input.finding_id },
        order: { version: 'ASC' },
      });
      const currentVersion = history.at(-1)?.version ?? 0;
      if (input.expected_version !== currentVersion + 1) {
        throw new Error(
          `finding version conflict for ${input.finding_id}: expected next=${currentVersion + 1}, received=${input.expected_version}`,
        );
      }

      const event: FindingEvent<T> = {
        event_id: input.event_id ?? randomUUID(),
        finding_id: input.finding_id,
        version: input.expected_version,
        event_type: input.event_type,
        payload: input.payload,
        main_sha: input.main_sha,
        occurred_at: normalizeOccurredAt(input.occurred_at),
        prev_hash: tail?.contentHash ?? FINDING_EVENT_ZERO_HASH,
        content_hash: '',
      };
      event.content_hash = computeFindingEventHash(event);

      const priorEvents = history.map(toFindingEvent);
      const previousProjection = replayFindingProjection(priorEvents);
      replayFindingProjection([...priorEvents, event]);
      await manager.save(FindingEventEntity, toEntity(manager, event));

      return { event, previousProjection };
    });
    this.recordMetrics(committed.event, committed.previousProjection);
    this.logger.log(
      `Appended ${committed.event.event_type} for ${committed.event.finding_id}@${committed.event.version} hash=${committed.event.content_hash.slice(0, 8)}…`,
    );
    return committed.event;
  }

  async findProjection(findingId: string): Promise<FindingProjection | null> {
    const history = await this.eventRepository.find({
      where: { findingId },
      order: { version: 'ASC' },
    });
    return replayFindingProjection(history.map(toFindingEvent));
  }

  async verify(): Promise<VerifyResult> {
    const entities = await this.eventRepository.find({
      order: { ledgerSeq: 'ASC' },
    });
    const events = entities.map(toFindingEvent);
    try {
      const replay = replayFindingEvents(events);
      return {
        ok: true,
        entries: events.length,
        firstFailureIndex: null,
        reason: null,
        chainTip: replay.chain_tip,
      };
    } catch (error) {
      return {
        ok: false,
        entries: events.length,
        firstFailureIndex: error instanceof FindingEventReplayError ? error.eventIndex : null,
        reason: error instanceof Error ? error.message : String(error),
        chainTip: null,
      };
    }
  }

  private recordMetrics(event: FindingEvent, previous: FindingProjection | null): void {
    if (event.event_type === 'CREATED') {
      const payload = event.payload as FindingEventPayloadMap['CREATED'];
      agentFindingIssuedTotal.inc({
        severity: payload.severity,
        agent: payload.owner_agent,
      });
      return;
    }
    if (event.event_type === 'STATE_TRANSITIONED' && previous) {
      const payload = event.payload as FindingEventPayloadMap['STATE_TRANSITIONED'];
      agentFindingStateTransitionTotal.inc({
        from_state: payload.from_state,
        to_state: payload.to_state,
        severity: previous.severity,
      });
    }
  }
}

function toFindingEvent(entity: FindingEventEntity): FindingEvent {
  return {
    event_id: entity.eventId,
    finding_id: entity.findingId,
    version: entity.version,
    event_type: entity.eventType,
    payload: entity.payload,
    main_sha: entity.mainSha,
    occurred_at: entity.occurredAt.toISOString(),
    prev_hash: entity.prevHash,
    content_hash: entity.contentHash,
  };
}

function toEntity<T extends FindingEventType>(
  manager: EntityManager,
  event: FindingEvent<T>,
): FindingEventEntity {
  return manager.create(FindingEventEntity, {
    eventId: event.event_id,
    findingId: event.finding_id,
    version: event.version,
    eventType: event.event_type,
    payload: event.payload,
    mainSha: event.main_sha,
    occurredAt: new Date(event.occurred_at),
    prevHash: event.prev_hash,
    contentHash: event.content_hash,
  });
}

function normalizeOccurredAt(value: string | undefined): string {
  const occurredAt = value ? new Date(value) : new Date();
  if (Number.isNaN(occurredAt.getTime())) throw new Error(`invalid occurred_at: ${value}`);
  return occurredAt.toISOString();
}

function assertMainSha(value: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error('main_sha must be 40 lowercase hex characters');
  }
}
