import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { WaterQualityCriticalEvent } from '@platform/event-contracts';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import { AlertHistory } from '../entities/alert-history.entity';
import { FarmSignalIncidentService } from './farm-signal-incident.service';

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
    // The incident dedup + escalation lifecycle is the shared farm-signal SSoT.
    // DI token is the class; the TS type is narrowed to the one method used
    // (Tier-1 "depend on exactly what you need") so unit tests pass a minimal
    // double with no unsafe casts.
    @Inject(FarmSignalIncidentService)
    private readonly farmSignalIncident: Pick<FarmSignalIncidentService, 'ensureIncident'>,
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

    const location = event.tankId
      ? `tank ${event.tankId}`
      : `equipment ${event.equipmentId}`;

    // Shape the water-quality-specific incident and hand it to the shared
    // lifecycle. Severity is always CRITICAL — the producer only publishes this
    // event once parameters cross their critical bounds.
    await this.farmSignalIncident.ensureIncident({
      tenantId: event.tenantId,
      ruleId,
      title: `${ruleName}: ${location}`,
      description: message,
      severity: AlertSeverity.CRITICAL,
      triggeredAt,
      signalLabel: 'water-quality',
      triggerData: {
        historyId: savedHistory.id,
        measurementId: event.measurementId,
        tankId: event.tankId,
        equipmentId: event.equipmentId,
        criticalParameterCount: event.criticalParameterCount,
        triggeredAt,
      },
    });
  }
}
