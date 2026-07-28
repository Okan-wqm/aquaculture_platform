import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import {
  AlertIncident,
  IncidentStatus,
  TimelineEventType,
} from '../../database/entities/alert-incident.entity';
import { EscalationManagerService } from '../../escalation/escalation-manager.service';

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

/** True when `next` is strictly more severe than `current`. */
export function isSeverityEscalation(
  current: AlertSeverity,
  next: AlertSeverity,
): boolean {
  return SEVERITY_RANK[next] > SEVERITY_RANK[current];
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
  ) {}

  /**
   * Bump the open incident for this rule + tenant, or create a new one and start
   * escalation. Runs inside the caller's tenant context (the handler establishes
   * search_path before calling).
   */
  async ensureIncident(spec: FarmSignalIncidentSpec): Promise<void> {
    const existing = await this.incidentRepository.findOne({
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
          description:
            `Severity raised ${previousSeverity} → ${spec.severity}: ${spec.description}`,
          data: { previousSeverity, severity: spec.severity },
        });
      }

      const saved = await this.incidentRepository.save(existing);

      if (escalated) {
        this.logger.warn(
          `Escalated ${spec.signalLabel} incident ${saved.id} for ${spec.ruleId}: ` +
            `${previousSeverity} → ${spec.severity} (occurrences: ${saved.occurrenceCount})`,
        );
        // Re-run the ladder so the policy matched for the NEW severity engages.
        // Non-blocking for the same reason as on creation: the incident row has
        // already landed and must not be rolled back by a notification fault.
        this.escalationManager
          .startEscalation(saved, spec.severity, spec.ruleId)
          .catch((err: Error) => {
            this.logger.error(
              `Failed to re-start escalation for escalated ${spec.signalLabel} incident ` +
                `${saved.id}: ${err.message}`,
            );
          });
        return;
      }

      this.logger.debug(
        `Updated existing ${spec.signalLabel} incident ${existing.id} for ${spec.ruleId} ` +
          `(occurrences: ${existing.occurrenceCount})`,
      );
      return;
    }

    const incident = this.incidentRepository.create({
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

    const savedIncident = await this.incidentRepository.save(incident);
    this.logger.log(
      `Created ${spec.signalLabel} incident ${savedIncident.id} for ${spec.ruleId} ` +
        `(severity: ${spec.severity})`,
    );

    // Escalation is non-blocking for the alert flow — a failure here must not
    // fail the AlertHistory/Incident write that already landed.
    this.escalationManager
      .startEscalation(savedIncident, spec.severity, spec.ruleId)
      .catch((err: Error) => {
        this.logger.error(
          `Failed to start escalation for ${spec.signalLabel} incident ` +
            `${savedIncident.id}: ${err.message}`,
        );
      });
  }
}
