/**
 * PURE projections for the fish-health farm-AI responder (PR-3).
 *
 * Same namespace rules as water-quality/responders/projections.ts: wire DTOs
 * only — no entity metadata, and NONE of the operator-identity/free-text
 * fields (reportedBy, assignedTo, vet*, recordedBy, assessedBy, countedBy,
 * notes, attachments, beskrivelse, …). Dates → ISO strings or null.
 */
import { HealthEvent } from '../entities/health-event.entity';
import { LiceCount } from '../entities/lice-count.entity';
import { TreatmentApplication } from '../entities/treatment-application.entity';
import { WelfareAssessment } from '../entities/welfare-assessment.entity';
import { HealthEventStats } from '../services/health-event.service';
import {
  BlockingHealthEvent,
  HarvestEligibilityResult,
} from '../services/batch-harvest-eligibility.service';
import { isoOrNull } from '../../common/nats/ai-query-responder';

/** Aggregated health-event counters (all fields are catalogue constants). */
export type FishHealthStatsDto = HealthEventStats;

/** FH_STATS projects 1:1 — the stats handler already returns counters only. */
export function projectFishHealthStats(stats: HealthEventStats): FishHealthStatsDto {
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

/** Health-event summary row (clinical facts only — no narrative blobs). */
export interface HealthEventSummaryDto {
  id: string;
  batchId: string;
  tankId: string | null;
  title: string;
  eventType: string;
  severity: string;
  status: string;
  diseaseCategory: string | null;
  diseaseName: string | null;
  eventDate: string | null;
  isUnderTreatment: boolean;
  isQuarantined: boolean;
  labConfirmed: boolean;
  vetNotified: boolean;
  withdrawalPeriodDays: number | null;
  earliestHarvestDate: string | null;
  followUpRequired: boolean;
  nextFollowUpDate: string | null;
}

/** Project a HealthEvent for the events/critical/overdue lists. */
export function projectHealthEvent(event: HealthEvent): HealthEventSummaryDto {
  return {
    id: event.id,
    batchId: event.batchId,
    tankId: event.tankId ?? null,
    title: event.title,
    eventType: String(event.eventType),
    severity: String(event.severity),
    status: String(event.status),
    diseaseCategory: event.diseaseCategory ? String(event.diseaseCategory) : null,
    diseaseName: event.diseaseName ?? null,
    eventDate: isoOrNull(event.eventDate),
    isUnderTreatment: event.isUnderTreatment === true,
    isQuarantined: event.isQuarantined === true,
    labConfirmed: event.labConfirmed === true,
    vetNotified: event.vetNotified === true,
    withdrawalPeriodDays: event.withdrawalPeriodDays ?? null,
    earliestHarvestDate: isoOrNull(event.earliestHarvestDate),
    followUpRequired: event.followUpRequired === true,
    nextFollowUpDate: isoOrNull(event.nextFollowUpDate),
  };
}

/** Weekly lice-count row (per-fish averages by official stage). */
export interface LiceCountDto {
  id: string;
  siteId: string;
  tankId: string;
  batchId: string | null;
  countDate: string | null;
  reportingYear: number;
  reportingWeek: number;
  adultFemaleLice: number;
  mobileLice: number;
  attachedLice: number;
  fishSampled: number;
  seaTemperatureC: number | null;
}

/** Project a LiceCount (countedBy/notes deliberately dropped). */
export function projectLiceCount(row: LiceCount): LiceCountDto {
  return {
    id: row.id,
    siteId: row.siteId,
    tankId: row.tankId,
    batchId: row.batchId ?? null,
    countDate: isoOrNull(row.countDate),
    reportingYear: row.reportingYear,
    reportingWeek: row.reportingWeek,
    adultFemaleLice: row.adultFemaleLice,
    mobileLice: row.mobileLice,
    attachedLice: row.attachedLice,
    fishSampled: row.fishSampled,
    seaTemperatureC: row.seaTemperatureC ?? null,
  };
}

/** Applied-treatment row (Mattilsynet enum values verbatim). */
export interface TreatmentApplicationDto {
  id: string;
  siteId: string;
  tankId: string | null;
  batchId: string | null;
  healthEventId: string | null;
  category: string;
  method: string;
  virkestoffType: string | null;
  styrkeVerdi: number | null;
  styrkeEnhet: string | null;
  mengdeVerdi: number | null;
  mengdeEnhet: string | null;
  wholeSite: boolean;
  pensCount: number | null;
  appliedAt: string | null;
  completedAt: string | null;
}

/**
 * Project a TreatmentApplication. veterinarianWorkerId / externalVetName /
 * beskrivelse / recordedBy are deliberately dropped (PII ban).
 */
export function projectTreatmentApplication(
  row: TreatmentApplication,
): TreatmentApplicationDto {
  return {
    id: row.id,
    siteId: row.siteId,
    tankId: row.tankId ?? null,
    batchId: row.batchId ?? null,
    healthEventId: row.healthEventId ?? null,
    category: String(row.category),
    method: row.method,
    virkestoffType: row.virkestoffType ?? null,
    styrkeVerdi: row.styrkeVerdi ?? null,
    styrkeEnhet: row.styrkeEnhet ?? null,
    mengdeVerdi: row.mengdeVerdi ?? null,
    mengdeEnhet: row.mengdeEnhet ?? null,
    wholeSite: row.wholeSite === true,
    pensCount: row.pensCount ?? null,
    appliedAt: isoOrNull(row.appliedAt),
    completedAt: isoOrNull(row.completedAt),
  };
}

/** Welfare-assessment row (velferdsindikator scores 0..3). */
export interface WelfareAssessmentDto {
  id: string;
  siteId: string;
  tankId: string;
  batchId: string | null;
  assessedAt: string | null;
  fishSampled: number;
  gillScore: number;
  finScore: number;
  woundScore: number;
  deformityScore: number;
}

/** Project a WelfareAssessment (assessedBy/notes deliberately dropped). */
export function projectWelfareAssessment(row: WelfareAssessment): WelfareAssessmentDto {
  return {
    id: row.id,
    siteId: row.siteId,
    tankId: row.tankId,
    batchId: row.batchId ?? null,
    assessedAt: isoOrNull(row.assessedAt),
    fishSampled: row.fishSampled,
    gillScore: row.gillScore,
    finScore: row.finScore,
    woundScore: row.woundScore,
    deformityScore: row.deformityScore,
  };
}

/** One blocking event of a harvest-eligibility check (dates, ids — no PII). */
export interface BlockingHealthEventDto {
  id: string;
  title: string;
  diseaseName: string | null;
  earliestHarvestDate: string | null;
  withdrawalPeriodDays: number | null;
  status: string;
}

/** Harvest-eligibility decision DTO. */
export interface HarvestEligibilityDto {
  eligible: boolean;
  blockedUntil: string | null;
  reason: string | null;
  blockingEvents: BlockingHealthEventDto[];
}

/** Project the eligibility service's result (vet/notes fields never exist here). */
export function projectHarvestEligibility(
  result: HarvestEligibilityResult,
): HarvestEligibilityDto {
  return {
    eligible: result.eligible,
    blockedUntil: isoOrNull(result.blockedUntil),
    reason: result.reason ?? null,
    blockingEvents: result.blockingEvents.map(projectBlockingEvent),
  };
}

function projectBlockingEvent(event: BlockingHealthEvent): BlockingHealthEventDto {
  return {
    id: event.id,
    title: event.title,
    diseaseName: event.diseaseName ?? null,
    earliestHarvestDate: isoOrNull(event.earliestHarvestDate),
    withdrawalPeriodDays: event.withdrawalPeriodDays ?? null,
    status: String(event.status),
  };
}
