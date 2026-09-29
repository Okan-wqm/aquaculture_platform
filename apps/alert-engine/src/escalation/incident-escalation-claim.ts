import { randomUUID } from 'crypto';
import type { EntityManager } from 'typeorm';

import {
  AlertIncident,
  type IncidentTimelineEvent,
  TimelineEventType,
} from '../database/entities/alert-incident.entity';

/**
 * How an escalation level may be claimed.
 *
 *   - `first`: level 0 → 1. Wins for exactly ONE caller per incident, however
 *     many deliveries of the same condition race (an offline-sync flush, a
 *     redelivery, two replicas). A severity rise re-arms it: the rise's own
 *     conditional UPDATE resets the level to 0, so the ladder for the NEW
 *     severity is claimed exactly once too.
 *   - `from`: a timer-driven step (next level or a repeat) that applies only
 *     while the incident is still at `from` — a second timer for the same step
 *     finds the level already moved and pages nobody twice.
 */
export type LevelClaim =
  | { readonly kind: 'first' }
  | { readonly kind: 'from'; readonly level: number };

/** A timeline entry in its stored (jsonb) shape. */
export function timelineEntry(
  type: TimelineEventType,
  description: string,
  metadata: Record<string, unknown>,
): IncidentTimelineEvent {
  return {
    id: `evt-${randomUUID()}`,
    type,
    timestamp: new Date(),
    userId: 'system',
    description,
    metadata,
  };
}

/**
 * Claim escalation `level` for an incident — the conditional UPDATE that makes
 * a page exactly-once (V-S1a-4).
 *
 * WHY: the escalation level was read, compared in memory and written back with
 * a full-entity save. Two deliveries of one signal both saw level 0, both
 * escalated, and two AlertEscalated events paged everybody twice; the stale
 * save also wrote an old `escalation_level`/`timeline` over newer ones.
 *
 * WHAT: one `UPDATE … WHERE id = $1 AND <claim condition> RETURNING id`, run on
 * the SAME transaction manager as the outbox enqueue of the AlertEscalated
 * event. Only the caller that gets the row back may enqueue; if the enqueue
 * fails the claim rolls back with it, so a retry can claim again.
 *
 * INVARIANT: at most one AlertEscalated per (incident, level claim). If
 * violated → duplicate pages for one alarm.
 */
export async function claimEscalationLevel(
  manager: EntityManager,
  incidentId: string,
  level: number,
  claim: LevelClaim,
  entry: IncidentTimelineEvent,
): Promise<boolean> {
  const query = manager
    .createQueryBuilder()
    .update(AlertIncident)
    .set({
      escalationLevel: level,
      lastEscalatedAt: () => 'now()',
      timeline: () => `COALESCE("timeline", '[]'::jsonb) || CAST(:entry AS jsonb)`,
    })
    .where('id = :incidentId', { incidentId })
    .setParameter('entry', JSON.stringify([entry]));

  if (claim.kind === 'first') {
    query.andWhere('escalation_level = 0');
  } else if (claim.kind === 'from') {
    query.andWhere('escalation_level = :fromLevel', { fromLevel: claim.level });
  }

  const result = await query.returning('id').execute();
  return (result.affected ?? 0) === 1;
}
