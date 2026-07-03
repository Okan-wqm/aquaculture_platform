import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { MortalityAlertRaisedEvent } from '@platform/event-contracts';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import { AlertHistory } from '../entities/alert-history.entity';
import { FarmSignalIncidentService } from './farm-signal-incident.service';

/**
 * MortalityAlertService
 *
 * Converts a farm-raised `MortalityAlertRaised` event into a FIRST-CLASS
 * alert-engine alert: an `AlertHistory` audit row + an `AlertIncident` that
 * feeds the escalation pipeline.
 *
 * WHY a dedicated path (not AlertTriggered):
 *   The alert-engine's own `AlertTriggered` originates from an `AlertRule`
 *   evaluation and carries `alertId`/`ruleId`/`channels`/`recipients`. A farm
 *   producer cannot supply those — mortality thresholds are evaluated in
 *   farm-service against batch records, not against an alert-engine rule. So the
 *   farm raises the lighter `MortalityAlertRaised` signal and the alert-engine
 *   owns the conversion into the alert lifecycle here. This is the architectural
 *   answer to "wire a REAL consumer": the dead farm-internal high-mortality
 *   alert now produces a real, escalatable incident.
 *
 * SYNTHETIC RULE IDENTITY:
 *   `AlertHistory.ruleId` / `AlertIncident.ruleId` are plain string columns
 *   (NOT foreign keys — see entities). A mortality alert has no AlertRule, so a
 *   deterministic sentinel `system:mortality:{alertType}` is used. It groups
 *   mortality alerts of the same type under the existing `[ruleId, triggeredAt]`
 *   index (used by the incident-dedup query) without fabricating a rule row.
 */
@Injectable()
export class MortalityAlertService {
  private readonly logger = new Logger(MortalityAlertService.name);

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

  /** Map the wire severity to the alert-engine severity enum. */
  private mapSeverity(severity: MortalityAlertRaisedEvent['severity']): AlertSeverity {
    return severity === 'critical' ? AlertSeverity.CRITICAL : AlertSeverity.WARNING;
  }

  /** Deterministic synthetic rule identity grouping mortality alerts by type. */
  private syntheticRuleId(alertType: MortalityAlertRaisedEvent['alertType']): string {
    return `system:mortality:${alertType}`;
  }

  private syntheticRuleName(alertType: MortalityAlertRaisedEvent['alertType']): string {
    return `High Mortality (${alertType})`;
  }

  /**
   * Record the mortality alert as an AlertHistory row + ensure an AlertIncident
   * exists, kicking off escalation for a new incident. Runs inside the caller's
   * tenant context (the handler establishes search_path before calling).
   */
  async recordMortalityAlert(event: MortalityAlertRaisedEvent): Promise<void> {
    const severity = this.mapSeverity(event.severity);
    const ruleId = this.syntheticRuleId(event.alertType);
    const ruleName = this.syntheticRuleName(event.alertType);
    const triggeredAt = new Date(event.recordedAt);

    const triggeringData: Record<string, unknown> = {
      source: 'farm.mortality',
      batchId: event.batchId,
      tankId: event.tankId,
      alertType: event.alertType,
      mortalityRate: event.mortalityRate,
      reason: event.reason,
      causationId: event.causationId,
    };

    const history = this.historyRepository.create({
      ruleId,
      ruleName,
      tenantId: event.tenantId,
      severity,
      message: event.message,
      triggeringData,
      triggeredAt,
    });
    const savedHistory = await this.historyRepository.save(history);

    // Shape the mortality-specific incident and hand it to the shared lifecycle.
    await this.farmSignalIncident.ensureIncident({
      tenantId: event.tenantId,
      ruleId,
      title: `${ruleName}: batch ${event.batchId}`,
      description: event.message,
      severity,
      triggeredAt,
      signalLabel: 'mortality',
      triggerData: {
        historyId: savedHistory.id,
        batchId: event.batchId,
        tankId: event.tankId,
        alertType: event.alertType,
        mortalityRate: event.mortalityRate,
        reason: event.reason,
        triggeredAt,
      },
    });
  }
}
