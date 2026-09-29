import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { signalKey, type MortalityAlertRaisedEvent } from '@platform/event-contracts';
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
 * RULE IDENTITY (ALERT-MEDIUM-006):
 *   A mortality alert has no AlertRule; its identity is the platform signal
 *   key `mortality:batch:{batchId}`, stored as `AlertHistory.ruleId` (a plain
 *   string column) and `AlertIncident.signalKey` (ALERT-CRITICAL-009). It used to
 *   be `system:mortality:{alertType}` — TENANT-WIDE per alert type — so deaths
 *   in batch B bumped the open incident titled for batch A and nobody was paged
 *   for B. One batch is one condition: single-event, daily-rate and cumulative
 *   alerts of that batch feed one incident whose severity only rises, and the
 *   alert type stays on the history row and the breadcrumb.
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
    const key = signalKey({ kind: 'mortality', batchId: event.batchId });
    const ruleName = this.syntheticRuleName(event.alertType);
    // Absent on events published before the field existed / a site-less tank.
    const siteId = event.siteId ?? null;
    const triggeredAt = new Date(event.recordedAt);

    const triggeringData: Record<string, unknown> = {
      source: 'farm.mortality',
      batchId: event.batchId,
      tankId: event.tankId,
      siteId,
      recordedBy: event.userId ?? null,
      alertType: event.alertType,
      mortalityRate: event.mortalityRate,
      reason: event.reason,
      causationId: event.causationId,
    };

    const history = this.historyRepository.create({
      ruleId: key,
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
      signalKey: key,
      siteId,
      title: `High Mortality: batch ${event.batchId}`,
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
