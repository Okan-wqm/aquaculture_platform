import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, QueryFailedError, Repository } from 'typeorm';
import type { SignalKey } from '@platform/event-contracts';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import {
  AlertIncident,
  IncidentStatus,
  TimelineEventType,
} from '../../database/entities/alert-incident.entity';
import { EscalationManagerService } from '../../escalation/escalation-manager.service';
import { timelineEntry } from '../../escalation/incident-escalation-claim';
import { IncidentEscalationFailedError } from './incident-escalation-failed.error';

/**
 * Everything a farm-signal consumer must supply to open (or bump) an incident.
 * The signal-specific shaping — synthetic rule identity, title, human message,
 * severity, and the trigger-data breadcrumb — is decided by the caller; the
 * lifecycle below is signal-agnostic.
 */
export interface FarmSignalIncidentSpec {
  tenantId: string;
  /**
   * The condition's platform-wide identity (ALERT-MEDIUM-006), persisted in
   * `alert_incidents.signal_key` (ALERT-CRITICAL-009). Typed as the branded
   * `SignalKey`, so only `signalKey()` can produce it — a hand-spelled key is a
   * compile error, and the incident, the auto-rule task and the AI suggestion
   * for one condition can never drift apart.
   */
  signalKey: SignalKey;
  /**
   * Site the signal belongs to, or null when the producer's event names none
   * (ALERT-MEDIUM-007). Required-nullable on purpose: every caller states it.
   */
  siteId: string | null;
  title: string;
  description: string;
  severity: AlertSeverity;
  /** Signal-specific breadcrumb persisted on the incident (incl. historyId). */
  triggerData: Record<string, unknown>;
  /** Event time — stamps occurrence recency (never processing wall-clock). */
  triggeredAt: Date;
  /** Human label for log lines, e.g. 'mortality' / 'water-quality'. */
  signalLabel: string;
}

/**
 * Severity ordering — the ONLY place the enum's implicit ranking is made
 * explicit. `AlertSeverity` is a string enum, so `>` on its members compares
 * words alphabetically ('critical' < 'warning'), which is exactly backwards
 * for the two values farm signals actually use. Ranking it once here means no
 * caller can accidentally compare severities lexically.
 */
const SEVERITY_RANK: Record<AlertSeverity, number> = {
  [AlertSeverity.INFO]: 0,
  [AlertSeverity.LOW]: 1,
  [AlertSeverity.WARNING]: 2,
  [AlertSeverity.MEDIUM]: 3,
  [AlertSeverity.HIGH]: 4,
  [AlertSeverity.CRITICAL]: 5,
};

/** Name of the partial unique index holding "one open incident per signal". */
const OPEN_SIGNAL_INDEX = 'uq_alert_incidents_open_signal';

/** True when `error` is the open-incident uniqueness race (another delivery won). */
function isOpenSignalRace(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) return false;
  const driverError: unknown = error.driverError;
  if (typeof driverError !== 'object' || driverError === null) return false;
  const { code, constraint } = driverError as { code?: unknown; constraint?: unknown };
  return code === '23505' && constraint === OPEN_SIGNAL_INDEX;
}

/** True when `next` is strictly more severe than `current`. */
export function isSeverityEscalation(current: AlertSeverity, next: AlertSeverity): boolean {
  return SEVERITY_RANK[next] > SEVERITY_RANK[current];
}

/** The severities in ascending rank — the SQL twin of {@link SEVERITY_RANK}. */
const SEVERITY_ORDER: readonly AlertSeverity[] = (
  Object.keys(SEVERITY_RANK) as AlertSeverity[]
).sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b]);

const SEVERITIES: readonly string[] = Object.values(AlertSeverity);

function isSeverity(value: unknown): value is AlertSeverity {
  return typeof value === 'string' && SEVERITIES.includes(value);
}

/** The row the atomic occurrence bump hands back. */
interface BumpedIncident {
  escalationLevel: number;
  severity: AlertSeverity;
}

function bumpedRowOf(raw: unknown): BumpedIncident | null {
  const row: unknown = Array.isArray(raw) ? raw[0] : undefined;
  if (typeof row !== 'object' || row === null) return null;
  const { escalation_level: level, severity } = row as Record<string, unknown>;
  if (typeof level !== 'number' || !isSeverity(severity)) return null;
  return { escalationLevel: level, severity };
}

/**
 * FarmSignalIncidentService (FARM-LOW-144)
 *
 * The single owner of the "farm signal → AlertIncident" dedup + escalation
 * lifecycle. MortalityAlertService and WaterQualityCriticalAlertService both
 * convert a farm-raised event into an AlertHistory row and then need the exact
 * same incident behaviour: bump the open incident for this (ruleId, tenant) if
 * one exists, else create a NEW incident and kick off escalation. That logic
 * previously lived as a near-verbatim copy in each service, so a future change
 * to the dedup window or an incident lock would have to be applied twice (and
 * could silently drift). Extracting it here makes the lifecycle impossible to
 * implement inconsistently — the callers only decide the signal-specific shape.
 *
 * ## Severity escalation (W7 — FARM-MEDIUM-259)
 *
 * Dedup used to mean "bump the occurrence counter and return", which froze an
 * incident at the severity it was FIRST opened with. A feed-stockout incident
 * opened at WARNING on day 7 of cover therefore stayed WARNING all the way
 * down to day 1 — the CRITICAL threshold the coverage service computes every
 * morning was calculated, passed to this method, and silently discarded,
 * because the notification ladder is driven by the escalation policy matched
 * at `startEscalation` time and that only ran on creation. The same freeze hits
 * any signal whose severity is a function of how bad things have got.
 *
 * An open incident that receives a MORE severe occurrence is now promoted:
 * severity/description/triggerData are updated, an `ESCALATED` timeline entry
 * records the transition, and `startEscalation` is re-run so the ladder for the
 * NEW severity engages. A same-or-lower occurrence still only bumps the
 * counter — de-escalation is an operator decision (resolve/close), and
 * re-running the ladder on every repeat occurrence would be a pager storm.
 * The one exception is an incident that was never escalated (level 0): it
 * re-tries on every occurrence until a policy pages someone (ALERT-CRITICAL-004).
 */
@Injectable()
export class FarmSignalIncidentService {
  private readonly logger = new Logger(FarmSignalIncidentService.name);

  /** An incident is "open" (dedup target) until it is resolved/closed. */
  private static readonly ACTIVE_STATUSES: IncidentStatus[] = [
    IncidentStatus.NEW,
    IncidentStatus.ACKNOWLEDGED,
    IncidentStatus.INVESTIGATING,
  ];

  constructor(
    @InjectRepository(AlertIncident)
    private readonly incidentRepository: Repository<AlertIncident>,
    // DI token is the EscalationManagerService class; TS type is narrowed to the
    // single method used (Tier-1 "depend on exactly what you need") so unit
    // tests pass a minimal double with no unsafe casts.
    @Inject(EscalationManagerService)
    private readonly escalationManager: Pick<EscalationManagerService, 'startEscalation'>,
  ) {}

  /**
   * Start the incident's escalation; any failure becomes an
   * {@link IncidentEscalationFailedError}, which every farm-signal consumer
   * re-drives — even for a reproducible signal (V-S1a-12).
   */
  private async escalate(
    incident: AlertIncident,
    severity: AlertSeverity,
    spec: FarmSignalIncidentSpec,
  ): Promise<void> {
    try {
      await this.escalationManager.startEscalation(incident, {
        severity,
        matchKey: spec.signalKey,
      });
    } catch (error) {
      throw new IncidentEscalationFailedError(incident.id, error);
    }
  }

  /**
   * Bump the open incident for this rule + tenant, or create a new one, and
   * make sure an escalatable incident has actually been escalated. Runs inside
   * the caller's tenant context (the handler establishes search_path before
   * calling).
   *
   * LEVEL-TRIGGERED ESCALATION (ALERT-CRITICAL-004): escalation is started for a
   * new incident, for a severity rise, AND for an open incident still at
   * escalation level 0 — one whose earlier escalation found no policy or
   * failed. The escalation is awaited, so a failure propagates to the consumer
   * and the event is re-driven; the redelivery finds the level-0 incident and
   * tries again. The previous fire-and-forget start logged the failure and
   * acked the event, so a single transient fault silenced the alarm for good.
   */
  async ensureIncident(spec: FarmSignalIncidentSpec): Promise<void> {
    const existing = await this.findOpenIncident(spec);
    if (existing) {
      await this.bumpIncident(existing, spec);
      return;
    }

    const incident = this.incidentRepository.create({
      tenantId: spec.tenantId,
      ruleId: null,
      signalKey: spec.signalKey,
      siteId: spec.siteId,
      title: spec.title,
      description: spec.description,
      severity: spec.severity,
      status: IncidentStatus.NEW,
      riskScore: 0,
      triggerData: spec.triggerData,
      escalationLevel: 0,
      timeline: [],
      relatedIncidentIds: [],
      occurrenceCount: 1,
      lastOccurredAt: spec.triggeredAt,
    });

    incident.addTimelineEvent({
      type: TimelineEventType.CREATED,
      description: spec.description,
    });

    let savedIncident: AlertIncident;
    try {
      savedIncident = await this.incidentRepository.save(incident);
    } catch (error) {
      // INVARIANT: one OPEN incident per (tenant, signal key), held by the
      // partial unique index. A concurrent delivery of the same condition won
      // the insert — this occurrence joins its incident instead of opening a
      // second alarm.
      if (!isOpenSignalRace(error)) throw error;
      const winner = await this.findOpenIncident(spec);
      if (!winner) throw error;
      await this.bumpIncident(winner, spec);
      return;
    }

    this.logger.log(
      `Created ${spec.signalLabel} incident ${savedIncident.id} for ${spec.signalKey} ` +
        `(severity: ${spec.severity})`,
    );

    await this.escalate(savedIncident, spec.severity, spec);
  }

  private findOpenIncident(spec: FarmSignalIncidentSpec): Promise<AlertIncident | null> {
    return this.incidentRepository.findOne({
      where: {
        signalKey: spec.signalKey,
        tenantId: spec.tenantId,
        status: In(FarmSignalIncidentService.ACTIVE_STATUSES),
      },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Record another occurrence on an open incident (see class doc for escalation).
   *
   * EXACTLY-ONCE (V-S1a-4): every write here is ONE atomic UPDATE — the
   * occurrence counter is incremented in SQL, the severity rise is a
   * conditional UPDATE only one delivery can win, and the level-0 retry claims
   * `escalation_level = 0` inside the escalation. The old read-modify-save of
   * the whole entity wrote a stale `escalation_level = 0` and timeline back over
   * a concurrent escalation and let two deliveries both escalate.
   */
  private async bumpIncident(existing: AlertIncident, spec: FarmSignalIncidentSpec): Promise<void> {
    const bumped = await this.incidentRepository
      .createQueryBuilder()
      .update(AlertIncident)
      .set({
        occurrenceCount: () => 'occurrence_count + 1',
        lastOccurredAt: () =>
          'GREATEST(COALESCE(last_occurred_at, CAST(:occurredAt AS timestamp)), CAST(:occurredAt AS timestamp))',
        // A site learnt later (an earlier event predates the field) fills in; a
        // known site is never overwritten — one signal key names one place.
        siteId: () => 'COALESCE(site_id, CAST(:siteId AS uuid))',
      })
      .where('id = :id', { id: existing.id })
      .setParameters({ occurredAt: spec.triggeredAt, siteId: spec.siteId })
      // A string, not an array: `returning([...])` takes PROPERTY paths and
      // silently drops names it cannot map, which would return no row at all.
      .returning('"escalation_level", "severity"')
      .execute();
    const row = bumpedRowOf(bumped.raw);
    if (!row) {
      // The incident vanished between the lookup and the bump (erasure).
      this.logger.warn(`Incident ${existing.id} disappeared before its occurrence was recorded`);
      return;
    }

    if (
      isSeverityEscalation(row.severity, spec.severity) &&
      (await this.raiseSeverity(existing, spec))
    ) {
      this.logger.warn(
        `Escalated ${spec.signalLabel} incident ${existing.id} for ${spec.signalKey}: ` +
          `${row.severity} → ${spec.severity}`,
      );
      existing.severity = spec.severity;
      existing.description = spec.description;
      existing.triggerData = spec.triggerData;
      existing.escalationLevel = 0;
      // Re-run the ladder so the policy matched for the NEW severity engages.
      // The rise re-armed the level to 0, so every concurrent occurrence may
      // try — exactly one claims it.
      await this.escalate(existing, spec.severity, spec);
      return;
    }

    if (row.escalationLevel === 0) {
      // Never escalated (no policy then, or a failed first level) — retry. The
      // escalation claims level 0 → 1, so a concurrent retry pages once.
      existing.severity = row.severity;
      await this.escalate(existing, row.severity, spec);
      return;
    }

    this.logger.debug(
      `Recorded another ${spec.signalLabel} occurrence on incident ${existing.id} for ${spec.signalKey}`,
    );
  }

  /**
   * Raise the incident to `spec.severity` if it is still below it and open,
   * and re-arm its ladder (escalation level back to 0). The conditional UPDATE
   * makes the rise exactly-once: of two concurrent deliveries of a more severe
   * occurrence, only one gets `true`; the page itself is then the level-0 claim.
   */
  private async raiseSeverity(
    existing: AlertIncident,
    spec: FarmSignalIncidentSpec,
  ): Promise<boolean> {
    const rank = SEVERITY_ORDER.map((severity) => `'${severity}'`).join(', ');
    const result = await this.incidentRepository
      .createQueryBuilder()
      .update(AlertIncident)
      .set({
        severity: spec.severity,
        // The description and breadcrumb describe the CURRENT state (e.g. "2
        // days of cover", not the 7 it was opened with) — an operator opening
        // the incident must not read a stale reason for a critical page.
        description: spec.description,
        // Re-arm the ladder: the new severity's level 1 is claimed from 0,
        // exactly once, whichever concurrent occurrence gets there first.
        escalationLevel: 0,
        triggerData: () => 'CAST(:triggerData AS jsonb)',
        timeline: () => `COALESCE("timeline", '[]'::jsonb) || CAST(:entry AS jsonb)`,
      })
      .where('id = :id', { id: existing.id })
      .andWhere('status IN (:...open)', { open: FarmSignalIncidentService.ACTIVE_STATUSES })
      .andWhere(
        `array_position(ARRAY[${rank}]::text[], CAST(severity AS text)) < ` +
          `array_position(ARRAY[${rank}]::text[], CAST(:next AS text))`,
        { next: spec.severity },
      )
      .setParameter('triggerData', JSON.stringify(spec.triggerData))
      .setParameter(
        'entry',
        JSON.stringify([
          timelineEntry(
            TimelineEventType.ESCALATED,
            `Severity raised to ${spec.severity}: ${spec.description}`,
            { severity: spec.severity },
          ),
        ]),
      )
      .execute();
    return (result.affected ?? 0) === 1;
  }
}
