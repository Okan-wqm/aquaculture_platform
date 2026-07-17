/**
 * FeedingExecutionAlertService (plan §6 — feeding-execution tüketicisi)
 *
 * v2 motorunun yürütme sinyallerini incident'lara çevirir:
 *
 *  - `MealUnderfed` (scope meal|day, P-21/D-16): WARNING. Dedup ÜNİTE bazlı —
 *    kronik az-atım tek operasyonel sorundur; öğün ve gün sinyalleri aynı açık
 *    incident'ı besler (scope triggeringData'da ayrışır).
 *  - `MealMissed` (05:30 süpürmesi): WARNING, dedup ünite bazlı.
 *  - `UnfedUnitDetected` (D-5 — balıklı ama etkin plansız ünite): CRITICAL —
 *    sessiz aç kalma stok-refah riskidir; 06:00 üretimi her gün yeniden tespit
 *    eder, dedup ünite bazlı tek açık incident'ı besler.
 *  - `FeedTypeTransitioned` (P-12): incident DEĞİL — INFO seviyesinde
 *    AlertHistory satırı (plan §6: info/audit). Geçiş operasyonel bilgidir,
 *    eskalasyon gürültüsü değil; karar burada BELGELİ.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type {
  FeedTypeTransitionedEvent,
  MealMissedEvent,
  MealUnderfedEvent,
  UnfedUnitDetectedEvent,
} from '@platform/event-contracts';

import { AlertSeverity } from '../../database/entities/alert-rule.entity';
import { AlertHistory } from '../entities/alert-history.entity';
import { FarmSignalIncidentService } from './farm-signal-incident.service';

@Injectable()
export class FeedingExecutionAlertService {
  private readonly logger = new Logger(FeedingExecutionAlertService.name);

  constructor(
    @InjectRepository(AlertHistory)
    private readonly historyRepository: Repository<AlertHistory>,
    @Inject(FarmSignalIncidentService)
    private readonly farmSignalIncident: Pick<FarmSignalIncidentService, 'ensureIncident'>,
  ) {}

  async recordMealUnderfed(event: MealUnderfedEvent): Promise<void> {
    const ruleId = `system:meal-underfed:${event.unitId}`;
    const ruleName = 'Meal Underfed';
    const triggeredAt = new Date(event.timestamp);
    const scopeLabel = event.scope === 'day' ? 'gün toplamında' : 'öğünde';
    const message =
      `${event.unitCode} ünitesi ${scopeLabel} planın %${Math.abs(event.variancePercent).toFixed(1)} ` +
      `altında beslendi (planlanan ${event.plannedKg} kg, atılan ${event.actualKg} kg, ` +
      `eşik %${event.thresholdPercent})`;

    const history = await this.historyRepository.save(
      this.historyRepository.create({
        ruleId,
        ruleName,
        tenantId: event.tenantId,
        severity: AlertSeverity.WARNING,
        message,
        triggeringData: {
          source: 'farm.feeding.execution',
          scope: event.scope,
          unitId: event.unitId,
          unitCode: event.unitCode,
          dayPlanId: event.dayPlanId,
          mealId: event.mealId ?? null,
          plannedKg: event.plannedKg,
          actualKg: event.actualKg,
          variancePercent: event.variancePercent,
          thresholdPercent: event.thresholdPercent,
          correlationId: event.correlationId,
        },
        triggeredAt,
      }),
    );

    await this.farmSignalIncident.ensureIncident({
      tenantId: event.tenantId,
      ruleId,
      title: `${ruleName}: ${event.unitCode}`,
      description: message,
      severity: AlertSeverity.WARNING,
      triggeredAt,
      signalLabel: 'meal-underfed',
      triggerData: {
        historyId: history.id,
        unitId: event.unitId,
        dayPlanId: event.dayPlanId,
        mealId: event.mealId ?? null,
        scope: event.scope,
        variancePercent: event.variancePercent,
        triggeredAt,
      },
    });
  }

  async recordMealMissed(event: MealMissedEvent): Promise<void> {
    const ruleId = `system:meal-missed:${event.unitId}`;
    const ruleName = 'Meal Missed';
    const triggeredAt = new Date(event.timestamp);
    const message =
      `${event.unitCode} ünitesinin ${event.scheduledAt} öğünü hiç kaydedilmedi — ` +
      `pencere kapandı, öğün missed işaretlendi`;

    const history = await this.historyRepository.save(
      this.historyRepository.create({
        ruleId,
        ruleName,
        tenantId: event.tenantId,
        severity: AlertSeverity.WARNING,
        message,
        triggeringData: {
          source: 'farm.feeding.execution',
          unitId: event.unitId,
          unitCode: event.unitCode,
          mealId: event.mealId,
          dayPlanId: event.dayPlanId,
          scheduledAt: event.scheduledAt,
          correlationId: event.correlationId,
        },
        triggeredAt,
      }),
    );

    await this.farmSignalIncident.ensureIncident({
      tenantId: event.tenantId,
      ruleId,
      title: `${ruleName}: ${event.unitCode}`,
      description: message,
      severity: AlertSeverity.WARNING,
      triggeredAt,
      signalLabel: 'meal-missed',
      triggerData: {
        historyId: history.id,
        unitId: event.unitId,
        mealId: event.mealId,
        scheduledAt: event.scheduledAt,
        triggeredAt,
      },
    });
  }

  async recordUnfedUnit(event: UnfedUnitDetectedEvent): Promise<void> {
    const ruleId = `system:unfed-unit:${event.unitId}`;
    const ruleName = 'Unfed Unit Detected';
    const triggeredAt = new Date(event.timestamp);
    const reasonLabel: Record<UnfedUnitDetectedEvent['reason'], string> = {
      no_assignment: 'protokol ataması yok',
      assignment_paused: 'ataması duraklatılmış',
      draft_protocol: 'protokolü DRAFT (onaysız)',
    };
    const message =
      `${event.unitCode} ünitesinde ${event.fishCount} balık (${event.biomassKg} kg) var ` +
      `ama etkin yemleme planı YOK (${reasonLabel[event.reason]}) — sessiz aç kalma riski`;

    const history = await this.historyRepository.save(
      this.historyRepository.create({
        ruleId,
        ruleName,
        tenantId: event.tenantId,
        severity: AlertSeverity.CRITICAL,
        message,
        triggeringData: {
          source: 'farm.feeding.execution',
          unitId: event.unitId,
          unitCode: event.unitCode,
          siteId: event.siteId,
          reason: event.reason,
          fishCount: event.fishCount,
          biomassKg: event.biomassKg,
          correlationId: event.correlationId,
        },
        triggeredAt,
      }),
    );

    await this.farmSignalIncident.ensureIncident({
      tenantId: event.tenantId,
      ruleId,
      title: `${ruleName}: ${event.unitCode}`,
      description: message,
      severity: AlertSeverity.CRITICAL,
      triggeredAt,
      signalLabel: 'unfed-unit',
      triggerData: {
        historyId: history.id,
        unitId: event.unitId,
        siteId: event.siteId,
        reason: event.reason,
        fishCount: event.fishCount,
        triggeredAt,
      },
    });
  }

  /** INFO/audit izi — incident üretmez (plan §6 kararı, belgeli). */
  async recordFeedTransitioned(event: FeedTypeTransitionedEvent): Promise<void> {
    const triggeredAt = new Date(event.timestamp);
    await this.historyRepository.save(
      this.historyRepository.create({
        ruleId: `system:feed-transition:${event.unitId}`,
        ruleName: 'Feed Type Transitioned',
        tenantId: event.tenantId,
        severity: AlertSeverity.INFO,
        message:
          `${event.unitCode} ünitesi ${event.toFeedCode} yemine geçti ` +
          `(band ${event.bandIndex}, ort. ${event.avgWeightG} g, ` +
          `${event.automatic ? 'otomatik' : 'manuel'})`,
        triggeringData: {
          source: 'farm.feeding.execution',
          unitId: event.unitId,
          unitCode: event.unitCode,
          assignmentId: event.assignmentId,
          fromFeedId: event.fromFeedId ?? null,
          toFeedId: event.toFeedId,
          toFeedCode: event.toFeedCode,
          bandIndex: event.bandIndex,
          avgWeightG: event.avgWeightG,
          automatic: event.automatic,
          correlationId: event.correlationId,
        },
        triggeredAt,
      }),
    );
    this.logger.debug(
      `Feed transition audit row written for unit ${event.unitCode} → ${event.toFeedCode}`,
    );
  }
}
