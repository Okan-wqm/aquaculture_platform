import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import type { WaterQualityCriticalEvent } from '@platform/event-contracts';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import {
  AlertIncident,
  IncidentStatus,
  TimelineEventType,
} from '../../database/entities/alert-incident.entity';
import { AlertHistory } from '../entities/alert-history.entity';
import { EscalationManagerService } from '../../escalation/escalation-manager.service';

/**
 * Shape of one entry inside the event's `criticalParametersJson` payload
 * (ARCH-C01: the farm serializes the variable-structure array as a JSON
 * string to keep the event contract flat).
 */
interface CriticalParameter {
  code: string;
  name: string;
  value: number;
  threshold: number;
  direction: 'above' | 'below';
  unit?: string;
}

/**
 * WaterQualityCriticalAlertService (FARM-MEDIUM-118)
 *
 * Converts the farm-raised `WaterQualityCritical` event into a FIRST-CLASS
 * alert-engine alert: an `AlertHistory` audit row + an `AlertIncident` that
 * feeds the escalation pipeline. Before this consumer existed the event was
 * published reliably via the outbox but reached only the gateway's browser
 * bridge — a critical dissolved-oxygen or pH excursion never produced an
 * escalatable incident.
 *
 * Mirrors MortalityAlertService (the farm-signal → incident conversion SSoT
 * shape): a farm producer cannot supply alert-engine `alertId`/`ruleId`/
 * channels, so a deterministic synthetic rule identity is used.
 *
 * SYNTHETIC RULE IDENTITY:
 *   `system:water-quality:{tankId|equipmentId|'unknown'}` — scoped to the
 *   affected tank so repeated criticals for the SAME tank bump one open
 *   incident (occurrence count) while different tanks escalate independently;
 *   life-safety triage is per tank, not per tenant.
 */
@Injectable()
export class WaterQualityCriticalAlertService {
  private readonly logger = new Logger(WaterQualityCriticalAlertService.name);

  constructor(
    @InjectRepository(AlertHistory)
    private readonly historyRepository: Repository<AlertHistory>,
    @InjectRepository(AlertIncident)
    private readonly incidentRepository: Repository<AlertIncident>,
    // DI token is the EscalationManagerService class; TS type is narrowed to the
    // single method used (Tier-1 "depend on exactly what you need") so unit
    // tests pass a minimal double with no unsafe casts.
    @Inject(EscalationManagerService)
    private readonly escalationManager: Pick<EscalationManagerService, 'startEscalation'>,
  ) {}

  /** Deterministic synthetic rule identity — per affected tank/equipment. */
  private syntheticRuleId(event: WaterQualityCriticalEvent): string {
    return `system:water-quality:${event.tankId ?? event.equipmentId ?? 'unknown'}`;
  }

  /**
   * Parse the flat-contract JSON payload at the trust boundary. A malformed
   * payload must not drop the alert — the incident is still created from the
   * count; only the per-parameter detail is lost.
   */
  private parseCriticalParameters(json: string): CriticalParameter[] {
    try {
      const parsed: unknown = JSON.parse(json);
      if (!Array.isArray(parsed)) return [];
      // FARM-LOW-135: validate EVERY field buildMessage renders, so a malformed
      // entry is dropped (the message degrades to count-only) rather than
      // emitting "undefined 3.1 undefined undefined" into the escalation path.
      return parsed.filter((entry): entry is CriticalParameter => {
        if (typeof entry !== 'object' || entry === null) return false;
        const e = entry as Partial<CriticalParameter>;
        return (
          typeof e.code === 'string' &&
          typeof e.name === 'string' &&
          typeof e.value === 'number' &&
          typeof e.threshold === 'number' &&
          (e.direction === 'above' || e.direction === 'below')
        );
      });
    } catch {
      this.logger.warn('WaterQualityCritical criticalParametersJson is not valid JSON');
      return [];
    }
  }

  private buildMessage(
    event: WaterQualityCriticalEvent,
    parameters: CriticalParameter[],
  ): string {
    const location = event.tankId ? `tank ${event.tankId}` : `equipment ${event.equipmentId}`;
    if (parameters.length === 0) {
      return (
        `Water quality critical at ${location}: ` +
        `${event.criticalParameterCount} parameter(s) out of critical range`
      );
    }
    const detail = parameters
      .map((p) => `${p.name} ${p.value}${p.unit ?? ''} ${p.direction} ${p.threshold}${p.unit ?? ''}`)
      .join(', ');
    return `Water quality critical at ${location}: ${detail}`;
  }

  /**
   * Record the critical water-quality event as an AlertHistory row + ensure an
   * AlertIncident exists, kicking off escalation for a new incident. Runs
   * inside the caller's tenant context (the handler establishes search_path
   * before calling).
   */
  async recordCriticalWaterQuality(event: WaterQualityCriticalEvent): Promise<void> {
    const ruleId = this.syntheticRuleId(event);
    const ruleName = 'Water Quality Critical';
    const triggeredAt = new Date(event.measuredAt);
    const parameters = this.parseCriticalParameters(event.criticalParametersJson);
    const message = this.buildMessage(event, parameters);

    const triggeringData: Record<string, unknown> = {
      source: 'farm.water-quality',
      measurementId: event.measurementId,
      tankId: event.tankId,
      equipmentId: event.equipmentId,
      criticalParameterCount: event.criticalParameterCount,
      criticalParameters: parameters,
      causationId: event.causationId,
    };

    const history = this.historyRepository.create({
      ruleId,
      ruleName,
      tenantId: event.tenantId,
      // The producer only publishes this event when parameters crossed their
      // CRITICAL bounds (imminent fish-mortality risk) — severity is not a
      // judgment call this side can soften.
      severity: AlertSeverity.CRITICAL,
      message,
      triggeringData,
      triggeredAt,
    });
    const savedHistory = await this.historyRepository.save(history);

    await this.ensureIncident(event, ruleId, ruleName, message, savedHistory.id, triggeredAt);
  }

  /**
   * Ensure an AlertIncident exists for this tank's synthetic rule + tenant.
   * Mirrors MortalityAlertService.ensureIncident: bump an existing open
   * incident's occurrence count, else create a new one and start escalation.
   */
  private async ensureIncident(
    event: WaterQualityCriticalEvent,
    ruleId: string,
    ruleName: string,
    message: string,
    historyId: string,
    triggeredAt: Date,
  ): Promise<void> {
    const activeStatuses: IncidentStatus[] = [
      IncidentStatus.NEW,
      IncidentStatus.ACKNOWLEDGED,
      IncidentStatus.INVESTIGATING,
    ];

    const existing = await this.incidentRepository.findOne({
      where: {
        ruleId,
        tenantId: event.tenantId,
        status: In(activeStatuses),
      },
      order: { createdAt: 'DESC' },
    });

    if (existing) {
      existing.recordOccurrence(triggeredAt);
      await this.incidentRepository.save(existing);
      this.logger.debug(
        `Updated existing water-quality incident ${existing.id} for ${ruleId} ` +
          `(occurrences: ${existing.occurrenceCount})`,
      );
      return;
    }

    const incident = this.incidentRepository.create({
      tenantId: event.tenantId,
      ruleId,
      title: `${ruleName}: ${event.tankId ? `tank ${event.tankId}` : `equipment ${event.equipmentId}`}`,
      description: message,
      severity: AlertSeverity.CRITICAL,
      status: IncidentStatus.NEW,
      riskScore: 0,
      triggerData: {
        historyId,
        measurementId: event.measurementId,
        tankId: event.tankId,
        equipmentId: event.equipmentId,
        criticalParameterCount: event.criticalParameterCount,
        triggeredAt,
      },
      escalationLevel: 0,
      timeline: [],
      relatedIncidentIds: [],
      occurrenceCount: 1,
      lastOccurredAt: triggeredAt,
    });

    incident.addTimelineEvent({
      type: TimelineEventType.CREATED,
      description: message,
    });

    const savedIncident = await this.incidentRepository.save(incident);
    this.logger.log(
      `Created water-quality incident ${savedIncident.id} for ${ruleId} (severity: critical)`,
    );

    // Escalation is non-blocking for the alert flow — a failure here must not
    // fail the AlertHistory/Incident write that already landed.
    this.escalationManager
      .startEscalation(savedIncident, AlertSeverity.CRITICAL, ruleId)
      .catch((err: Error) => {
        this.logger.error(
          `Failed to start escalation for water-quality incident ${savedIncident.id}: ${err.message}`,
        );
      });
  }
}
