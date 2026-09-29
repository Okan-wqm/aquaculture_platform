import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { signalKey, type LowStockDetectedEvent, type SignalKey } from '@platform/event-contracts';
import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import { AlertHistory } from '../entities/alert-history.entity';
import { FarmSignalIncidentService } from './farm-signal-incident.service';

/**
 * LowStockAlertService (stock SSoT Phase 1 / feeding-protocol cycle)
 *
 * Converts the farm-raised `LowStockDetected` event into an AlertHistory row
 * + a deduplicated AlertIncident via the shared farm-signal lifecycle. This
 * is the consumer the low-stock chain was always missing: before this,
 * feed/chemical/consumable depletion produced either a websocket-only
 * broadcast (`FeedInventoryLow`) or an in-process emit with no listener —
 * no escalatable incident anywhere (findings register FARM-HIGH-217).
 *
 * Dedup identity is the platform signal key of the item's stock condition
 * (ALERT-MEDIUM-006): repeated deductions of the same depleted item bump ONE
 * open incident instead of flooding. Today's event reports the tenant-wide
 * total across every storage location, i.e. the POOL tier of plan K8, so the
 * key is `stock:pool:{itemId}` and the incident has no site. When the event
 * gains its site tier (`level` + `siteId`, lane B / FARM-HIGH-336) a site-level
 * event keys `stock:{siteId}:{itemId}` and names its site here.
 */
@Injectable()
export class LowStockAlertService {
  private readonly logger = new Logger(LowStockAlertService.name);

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

  /** out_of_stock halts production (feed = fish welfare) — critical. */
  private mapSeverity(severity: LowStockDetectedEvent['severity']): AlertSeverity {
    return severity === 'out_of_stock' ? AlertSeverity.CRITICAL : AlertSeverity.WARNING;
  }

  /** Pool-tier stock condition of the item (see class doc). */
  private signalKeyOf(event: LowStockDetectedEvent): SignalKey {
    return signalKey({ kind: 'stock', scope: { level: 'pool' }, itemId: event.itemId });
  }

  private buildMessage(event: LowStockDetectedEvent): string {
    const threshold =
      event.minimumThreshold !== undefined ? ` (threshold ${event.minimumThreshold} ${event.unit})` : '';
    return event.severity === 'out_of_stock'
      ? `${event.itemName} is OUT OF STOCK${threshold}`
      : `${event.itemName} is low: ${event.currentQuantity} ${event.unit} remaining${threshold}`;
  }

  /**
   * Record the low-stock signal as an AlertHistory row + ensure an
   * AlertIncident exists, kicking off escalation for a new incident. Runs
   * inside the caller's tenant context (the handler establishes search_path
   * before calling).
   */
  async recordLowStockAlert(event: LowStockDetectedEvent): Promise<void> {
    const severity = this.mapSeverity(event.severity);
    const key = this.signalKeyOf(event);
    const ruleName = `Low Stock (${event.itemType})`;
    const triggeredAt = new Date(event.timestamp);
    const message = this.buildMessage(event);

    const triggeringData: Record<string, unknown> = {
      source: 'farm.storage.lowStock',
      itemType: event.itemType,
      itemId: event.itemId,
      itemName: event.itemName,
      currentQuantity: event.currentQuantity,
      unit: event.unit,
      minimumThreshold: event.minimumThreshold,
      stockSeverity: event.severity,
      correlationId: event.correlationId,
    };

    const history = this.historyRepository.create({
      ruleId: key,
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
      signalKey: key,
      // Pool tier: the event reports the tenant-wide total, so no one site owns it.
      siteId: null,
      title: `${ruleName}: ${event.itemName}`,
      description: message,
      severity,
      triggeredAt,
      signalLabel: 'low-stock',
      triggerData: {
        historyId: savedHistory.id,
        itemType: event.itemType,
        itemId: event.itemId,
        itemName: event.itemName,
        currentQuantity: event.currentQuantity,
        minimumThreshold: event.minimumThreshold,
        triggeredAt,
      },
    });

    this.logger.log(
      `Low-stock incident ensured for ${event.itemType}/${event.itemId} ` +
        `severity=${event.severity} qty=${event.currentQuantity}`,
    );
  }
}
