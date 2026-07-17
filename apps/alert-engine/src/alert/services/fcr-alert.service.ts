import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { FCRAlertEvent } from '@platform/event-contracts';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import { AlertHistory } from '../entities/alert-history.entity';
import { FarmSignalIncidentService } from './farm-signal-incident.service';

/**
 * FcrAlertService (feeding-protocol cycle, C-1)
 *
 * Converts the farm-raised `FCRAlert` event (18:00 sweep in
 * `FeedingCronV2Service` — the FIRST durable emission of this contract; the
 * legacy scheduler only dead-ended it into an in-process log chain) into an
 * AlertHistory row + a deduplicated AlertIncident via the shared farm-signal
 * lifecycle.
 *
 * Dedup identity is per batch: a batch whose FCR stays above target bumps ONE
 * open incident on each nightly sweep instead of flooding — the same
 * semantics LowStockAlertService uses per item.
 */
@Injectable()
export class FcrAlertService {
  private readonly logger = new Logger(FcrAlertService.name);

  constructor(
    @InjectRepository(AlertHistory)
    private readonly historyRepository: Repository<AlertHistory>,
    // The incident dedup + escalation lifecycle is the shared farm-signal SSoT.
    @Inject(FarmSignalIncidentService)
    private readonly farmSignalIncident: Pick<FarmSignalIncidentService, 'ensureIncident'>,
  ) {}

  /** >20% over target halts profitability (feed is the dominant cost) — critical. */
  private mapSeverity(alertLevel: FCRAlertEvent['alertLevel']): AlertSeverity {
    return alertLevel === 'critical' ? AlertSeverity.CRITICAL : AlertSeverity.WARNING;
  }

  /** Deterministic synthetic rule identity grouping FCR alerts per batch. */
  private syntheticRuleId(event: FCRAlertEvent): string {
    return `system:fcr:${event.batchId}`;
  }

  private buildMessage(event: FCRAlertEvent): string {
    return (
      `Batch FCR ${event.currentFCR.toFixed(2)} exceeds target ` +
      `${event.targetFCR.toFixed(2)} by ${event.variancePercent.toFixed(1)}% ` +
      `(trend: ${event.trend})`
    );
  }

  /**
   * Record the FCR signal as an AlertHistory row + ensure an AlertIncident
   * exists, kicking off escalation for a new incident. Runs inside the
   * caller's tenant context (the handler establishes search_path first).
   */
  async recordFcrAlert(event: FCRAlertEvent): Promise<void> {
    const severity = this.mapSeverity(event.alertLevel);
    const ruleId = this.syntheticRuleId(event);
    const ruleName = 'FCR Threshold';
    const triggeredAt = new Date(event.timestamp);
    const message = this.buildMessage(event);

    const triggeringData: Record<string, unknown> = {
      source: 'farm.feeding.fcrAlert',
      batchId: event.batchId,
      currentFCR: event.currentFCR,
      targetFCR: event.targetFCR,
      variancePercent: event.variancePercent,
      trend: event.trend,
      fcrAlertLevel: event.alertLevel,
      correlationId: event.correlationId,
    };

    const history = this.historyRepository.create({
      ruleId,
      ruleName,
      tenantId: event.tenantId,
      severity,
      message,
      triggeringData,
      triggeredAt,
    });
    const savedHistory = await this.historyRepository.save(history);

    await this.farmSignalIncident.ensureIncident({
      tenantId: event.tenantId,
      ruleId,
      title: `${ruleName}: batch ${event.batchId}`,
      description: message,
      severity,
      triggeredAt,
      signalLabel: 'fcr',
      triggerData: {
        historyId: savedHistory.id,
        batchId: event.batchId,
        currentFCR: event.currentFCR,
        targetFCR: event.targetFCR,
        variancePercent: event.variancePercent,
        trend: event.trend,
        triggeredAt,
      },
    });

    this.logger.log(
      `FCR incident ensured for batch ${event.batchId} level=${event.alertLevel} ` +
        `fcr=${event.currentFCR} target=${event.targetFCR}`,
    );
  }
}
