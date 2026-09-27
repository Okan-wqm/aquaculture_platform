import type {
  BlockingHealthEventDto,
  FishHealthStatsReply,
  HarvestEligibilityReply,
  HealthEventDto,
  LiceCountDto,
  TreatmentApplicationDto,
  WelfareAssessmentDto,
} from '@platform/event-contracts';
import { toEventIso } from '@platform/event-contracts';
import { isoOrNull, numberOrNull } from '../../common/nats/ai-query-responder';
import type { HealthEvent } from '../entities/health-event.entity';
import type { LiceCount } from '../entities/lice-count.entity';
import type { TreatmentApplication } from '../entities/treatment-application.entity';
import type { WelfareAssessment } from '../entities/welfare-assessment.entity';
import type { HealthEventStats } from '../services/health-event.service';
import type { HarvestEligibilityResult } from '../services/batch-harvest-eligibility.service';

/**
 * Pure projections from fish-health entities to the AI read contract. No
 * reporter, veterinarian, licence, note or attachment fields ever cross.
 */

export function projectHealthEvent(row: HealthEvent): HealthEventDto {
  return {
    id: row.id,
    eventType: row.eventType,
    severity: row.severity,
    status: row.status,
    title: row.title,
    diseaseCategory: row.diseaseCategory ?? null,
    diseaseName: row.diseaseName ?? null,
    batchId: row.batchId ?? null,
    tankId: row.tankId ?? null,
    eventDate: toEventIso(row.eventDate),
    isUnderTreatment: row.isUnderTreatment,
    isQuarantined: row.isQuarantined,
    mortalityCount: numberOrNull(row.affectedPopulation?.mortalityCount),
    withdrawalPeriodDays: numberOrNull(row.withdrawalPeriodDays),
    earliestHarvestDate: isoOrNull(row.earliestHarvestDate),
    followUpRequired: row.followUpRequired,
    nextFollowUpDate: isoOrNull(row.nextFollowUpDate),
  };
}

export function projectStats(stats: HealthEventStats): FishHealthStatsReply {
  return {
    total: stats.total,
    active: stats.active,
    critical: stats.critical,
    underTreatment: stats.underTreatment,
    quarantined: stats.quarantined,
    resolved: stats.resolved,
    byEventType: { ...stats.byEventType },
    bySeverity: { ...stats.bySeverity },
  };
}

export function projectLiceCount(row: LiceCount): LiceCountDto {
  return {
    id: row.id,
    siteId: row.siteId,
    tankId: row.tankId,
    batchId: row.batchId ?? null,
    countDate: toEventIso(row.countDate),
    reportingYear: row.reportingYear,
    reportingWeek: row.reportingWeek,
    adultFemaleLice: Number(row.adultFemaleLice),
    mobileLice: Number(row.mobileLice),
    attachedLice: Number(row.attachedLice),
    fishSampled: Number(row.fishSampled),
    seaTemperatureC: numberOrNull(row.seaTemperatureC),
  };
}

export function projectTreatment(row: TreatmentApplication): TreatmentApplicationDto {
  return {
    id: row.id,
    healthEventId: row.healthEventId ?? null,
    siteId: row.siteId,
    tankId: row.tankId ?? null,
    batchId: row.batchId ?? null,
    category: row.category,
    method: row.method,
    activeSubstance: row.virkestoffType ?? null,
    strengthValue: numberOrNull(row.styrkeVerdi),
    strengthUnit: row.styrkeEnhet ?? null,
    amountValue: numberOrNull(row.mengdeVerdi),
    amountUnit: row.mengdeEnhet ?? null,
    wholeSite: row.wholeSite,
    appliedAt: toEventIso(row.appliedAt),
    completedAt: isoOrNull(row.completedAt),
  };
}

export function projectWelfare(row: WelfareAssessment): WelfareAssessmentDto {
  return {
    id: row.id,
    siteId: row.siteId,
    tankId: row.tankId,
    batchId: row.batchId ?? null,
    assessedAt: toEventIso(row.assessedAt),
    fishSampled: Number(row.fishSampled),
    gillScore: Number(row.gillScore),
    finScore: Number(row.finScore),
    woundScore: Number(row.woundScore),
    deformityScore: Number(row.deformityScore),
  };
}

export function projectEligibility(
  batchId: string,
  harvestDate: string,
  result: HarvestEligibilityResult,
): HarvestEligibilityReply {
  return {
    batchId,
    harvestDate,
    eligible: result.eligible,
    blockedUntil: isoOrNull(result.blockedUntil),
    reason: result.reason ?? null,
    blockingEvents: result.blockingEvents.map(
      (event): BlockingHealthEventDto => ({
        id: event.id,
        title: event.title,
        diseaseName: event.diseaseName,
        earliestHarvestDate: toEventIso(event.earliestHarvestDate),
        withdrawalPeriodDays: numberOrNull(event.withdrawalPeriodDays),
        status: event.status,
      }),
    ),
  };
}
