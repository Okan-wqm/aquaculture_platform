import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { tenantManagerRepo } from '@aquaculture/backend-common/database';
import { DataSource, DeepPartial, FindOneOptions, In, Repository } from 'typeorm';
import { ALERT_SEVERITY_RANK, AlertSeverity } from '../../database/entities/alert-rule.entity';
import {
  AlertIncident,
  IncidentStatus,
  TimelineEventType,
} from '../../database/entities/alert-incident.entity';
import { EscalationManagerService } from '../../escalation/escalation-manager.service';
import { AlertHistory } from '../entities/alert-history.entity';

/**
 * Everything a farm-signal consumer must supply to open (or bump) an incident.
 * The signal-specific shaping — synthetic rule identity, title, human message,
 * severity, and the trigger-data breadcrumb — is decided by the caller; the
 * lifecycle below is signal-agnostic.
 */
export interface FarmSignalIncidentSpec {
  tenantId: string;
  ruleId: string;
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
 * A farm signal to raise as ONE atomic unit: the alarm row and the incident it
 * feeds commit together (or not at all), keyed by `dedupeKey`.
 */
export interface FarmSignalAlertSpec extends FarmSignalIncidentSpec {
  /**
   * The alarm row, minus the identity `raise` owns (`ruleId`, `tenantId`,
   * `sourceEventId`). `historyId` is added to the incident breadcrumb for you.
   */
  history: Omit<DeepPartial<AlertHistory>, 'id' | 'ruleId' | 'tenantId' | 'sourceEventId'>;
  /**
   * Idempotency + frequency key (a deterministic uuid, e.g. `deriveEventId`).
   * The alarm for the same `(ruleId, dedupeKey)` fires ONCE: a redelivery of the
   * event, and any later event of the same period that derives the same key, is
   * acknowledged without writing a second alarm or bumping the incident. The
   * caller chooses the period by what it folds into the key (a day plan = a day).
   */
  dedupeKey: string;
}

/**
 * What the incident lifecycle needs of a store. The injected repository (the
 * legacy `ensureIncident` path) and the transaction's tenant-scoped repository
 * (`raise`) both fit.
 */
interface IncidentStore {
  findOne(options: FindOneOptions<AlertIncident>): Promise<AlertIncident | null>;
  create(dto: DeepPartial<AlertIncident>): AlertIncident;
  save(incident: AlertIncident): Promise<AlertIncident>;
}

/** What happened to an incident when a signal reached it. */
interface OpenedIncident {
  incident: AlertIncident;
  /** `created`: a new incident; `escalated`: an open one promoted; `bumped`: only counted. */
  outcome: 'created' | 'escalated' | 'bumped';
}

/** Postgres unique_violation: the (rule_id, source_event_id) key already holds this alarm. */
const UNIQUE_VIOLATION = '23505';

/**
 * True when `next` is strictly more severe than `current` — by
 * ALERT_SEVERITY_RANK, never by the enum's string values (which sort
 * 'critical' < 'warning', backwards for the two values farm signals use).
 */
export function isSeverityEscalation(current: AlertSeverity, next: AlertSeverity): boolean {
  return ALERT_SEVERITY_RANK[next] > ALERT_SEVERITY_RANK[current];
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
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Bump the open incident for this rule + tenant, or create a new one and start
   * escalation. Runs inside the caller's tenant context (the handler establishes
   * search_path before calling).
   *
   * The alarm row is the CALLER's to write, before this call, outside any shared
   * transaction — so a failure here leaves that row behind and a redelivery
   * writes it again. New signals use `raise`, which owns both writes atomically.
   */
  async ensureIncident(spec: FarmSignalIncidentSpec): Promise<void> {
    const opened = await this.openOrBump(this.incidentRepository, spec);
    this.startEscalationFor(opened, spec);
  }

  /**
   * Raise a farm signal: the alarm row and the incident it feeds in ONE
   * transaction, idempotent on `(ruleId, dedupeKey)`, with escalation started
   * only after the commit (it keeps Redis timers outside the transaction, so a
   * rollback would orphan them).
   *
   * WHY: written as two separate saves, a failure between them left the alarm
   * row behind, and the event handler's rethrow (NAK + redelivery) wrote it
   * again on every attempt — one poison message produced ~20,000 alarm rows
   * over its 7-day delivery budget. Here the failure rolls the alarm back, the
   * redelivery starts clean, and a delivery that already landed is recognised
   * by its key and acknowledged without a second alarm.
   *
   * Returns `duplicate` when the key already holds this alarm. Any other
   * failure propagates: the handler decides between retry and dead-letter.
   */
  async raise(spec: FarmSignalAlertSpec): Promise<'raised' | 'duplicate'> {
    let opened: OpenedIncident;
    try {
      opened = await this.dataSource.transaction(async (manager) => {
        const history = await manager.save(
          AlertHistory,
          manager.create(AlertHistory, {
            ...spec.history,
            ruleId: spec.ruleId,
            tenantId: spec.tenantId,
            sourceEventId: spec.dedupeKey,
          }),
        );
        return this.openOrBump(tenantManagerRepo(manager, AlertIncident, spec.tenantId), {
          ...spec,
          triggerData: { ...spec.triggerData, historyId: history.id },
        });
      });
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        this.logger.debug(
          `${spec.signalLabel} alert for ${spec.ruleId} already raised for key ${spec.dedupeKey} ` +
            '— duplicate suppressed',
        );
        return 'duplicate';
      }
      throw error;
    }

    this.startEscalationFor(opened, spec);
    return 'raised';
  }

  /** The dedup + escalation-promotion lifecycle, over the repository it is given. */
  private async openOrBump(
    incidents: IncidentStore,
    spec: FarmSignalIncidentSpec,
  ): Promise<OpenedIncident> {
    const existing = await incidents.findOne({
      where: {
        ruleId: spec.ruleId,
        tenantId: spec.tenantId,
        status: In(FarmSignalIncidentService.ACTIVE_STATUSES),
      },
      order: { createdAt: 'DESC' },
    });

    if (existing) {
      const escalated = isSeverityEscalation(existing.severity, spec.severity);
      const previousSeverity = existing.severity;

      existing.recordOccurrence(spec.triggeredAt);

      if (escalated) {
        existing.severity = spec.severity;
        // The description and breadcrumb describe the CURRENT state (e.g.
        // "2 days of cover", not the 7 it was opened with) — an operator
        // opening the incident must not read a stale reason for a critical
        // page.
        existing.description = spec.description;
        existing.triggerData = spec.triggerData;
        existing.addTimelineEvent({
          type: TimelineEventType.ESCALATED,
          description: `Severity raised ${previousSeverity} → ${spec.severity}: ${spec.description}`,
          data: { previousSeverity, severity: spec.severity },
        });
      }

      const saved = await incidents.save(existing);

      if (escalated) {
        this.logger.warn(
          `Escalated ${spec.signalLabel} incident ${saved.id} for ${spec.ruleId}: ` +
            `${previousSeverity} → ${spec.severity} (occurrences: ${saved.occurrenceCount})`,
        );
        return { incident: saved, outcome: 'escalated' };
      }

      this.logger.debug(
        `Updated existing ${spec.signalLabel} incident ${existing.id} for ${spec.ruleId} ` +
          `(occurrences: ${existing.occurrenceCount})`,
      );
      return { incident: saved, outcome: 'bumped' };
    }

    const incident = incidents.create({
      tenantId: spec.tenantId,
      ruleId: spec.ruleId,
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

    const savedIncident = await incidents.save(incident);
    this.logger.log(
      `Created ${spec.signalLabel} incident ${savedIncident.id} for ${spec.ruleId} ` +
        `(severity: ${spec.severity})`,
    );
    return { incident: savedIncident, outcome: 'created' };
  }

  /**
   * Re-run (or start) the notification ladder for what the signal did to the
   * incident. Non-blocking for the alert flow: the incident row has already
   * landed and must not be rolled back by a notification fault.
   */
  private startEscalationFor(opened: OpenedIncident, spec: FarmSignalIncidentSpec): void {
    if (opened.outcome === 'bumped') return;
    // A promoted incident re-runs the ladder so the policy matched for the NEW
    // severity engages; a new one starts it.
    this.escalationManager
      .startEscalation(opened.incident, spec.severity, spec.ruleId)
      .catch((err: Error) => {
        this.logger.error(
          `Failed to ${opened.outcome === 'created' ? 'start' : 're-start'} escalation for ` +
            `${opened.outcome === 'escalated' ? 'escalated ' : ''}${spec.signalLabel} incident ` +
            `${opened.incident.id}: ${err.message}`,
        );
      });
  }
}
