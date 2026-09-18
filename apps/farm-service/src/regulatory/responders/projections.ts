/**
 * PURE projections for the regulatory farm-AI responder (PR-4, Production
 * specialist). Covers the monthly biomass report and the persisted
 * regulatory-report submission list.
 *
 * Rules of the read-only namespace (see common/nats/ai-query-responder.ts):
 *  - Input = the query handler's return shape; output = wire DTO ONLY.
 *  - NO operator PII (generatedBy, submittedBy, confirmedBy, notes) and no
 *    counterpart/free-text fields inside the report payload (supplier,
 *    buyer, notes) — the AI persona answers about fish and submissions.
 *  - Dates → ISO strings (or null); numbers keep their unit in the name.
 */
import {
  BiomassReport,
  BiomassReportPayload,
} from '../entities/biomass-report.entity';
import { RegulatoryReport } from '../entities/regulatory-report.entity';
import { isoOrNull } from '../../common/nats/ai-query-responder';
import { FARM_AI_QUERY_LIMITS } from '@platform/event-contracts';

/** Cap any embedded reply list to the contract's hard ceiling. */
function capList<T>(rows: readonly T[]): { items: T[]; truncated: boolean } {
  const bounded = rows.slice(0, FARM_AI_QUERY_LIMITS.MAX_LIST_LIMIT);
  return { items: bounded, truncated: rows.length > bounded.length };
}

// ---------------------------------------------------------------------------
// REG_BIOMASS_REPORT
// ---------------------------------------------------------------------------

/** Monthly biomass report DTO (payload sections PII-stripped, lists capped). */
export interface BiomassReportDto {
  id: string;
  siteId: string;
  reportMonth: number;
  reportYear: number;
  status: string;
  totalBiomassKg: number;
  submittedAt: string | null;
  readyAt: string | null;
  currentBiomass: {
    totalKg: number;
    bySpecies: {
      speciesId: string;
      speciesName: string;
      fishCount: number;
      biomassKg: number;
      avgWeightG: number;
    }[];
  };
  stockings: {
    date: string;
    speciesCode: string;
    fishCount: number;
    avgWeightG: number;
    biomassKg: number;
  }[];
  mortality: {
    totalCount: number;
    byCause: { cause: string; count: number }[];
    details: {
      date: string;
      cause: string;
      speciesCode: string;
      count: number;
      biomassLossKg: number | null;
    }[];
  };
  slaughter: {
    totalQuantity: number;
    totalBiomassKg: number;
    records: {
      date: string;
      speciesCode: string;
      quantity: number;
      biomassKg: number;
    }[];
  };
  transfers: {
    date: string;
    direction: string;
    speciesCode: string;
    fishCount: number;
    biomassKg: number;
    counterparty: string | null;
  }[];
  feedConsumption: {
    totalKg: number;
    byFeedType: { feedName: string; brandName: string | null; quantityKg: number }[];
  };
}

/** Project a monthly biomass report (null-safe: the report may be absent). */
export function projectBiomassReport(report: BiomassReport | null): BiomassReportDto | null {
  if (!report) return null;
  const payload: BiomassReportPayload = report.reportData;
  const stockings = capList(payload.stockings ?? []);
  const mortalityDetails = capList(payload.mortality?.details ?? []);
  const slaughterRecords = capList(payload.slaughter?.records ?? []);
  const transfers = capList(payload.transfers ?? []);
  const feedEntries = capList(payload.feedConsumption?.byFeedType ?? []);
  return {
    id: report.id,
    siteId: report.siteId,
    reportMonth: report.reportMonth,
    reportYear: report.reportYear,
    status: String(report.status),
    totalBiomassKg: Number(report.totalBiomassKg ?? 0),
    submittedAt: isoOrNull(report.submittedAt),
    readyAt: isoOrNull(report.readyAt),
    currentBiomass: {
      totalKg: payload.currentBiomass?.totalKg ?? 0,
      bySpecies: (payload.currentBiomass?.bySpecies ?? []).map((entry) => ({
        speciesId: entry.speciesId,
        speciesName: entry.speciesName,
        fishCount: entry.fishCount,
        biomassKg: entry.biomassKg,
        avgWeightG: entry.avgWeightG,
      })),
    },
    stockings: stockings.items.map((entry) => ({
      date: entry.date,
      speciesCode: entry.speciesCode,
      fishCount: entry.fishCount,
      avgWeightG: entry.avgWeightG,
      biomassKg: entry.biomassKg,
    })),
    mortality: {
      totalCount: payload.mortality?.totalCount ?? 0,
      byCause: (payload.mortality?.byCause ?? []).map((entry) => ({ ...entry })),
      details: mortalityDetails.items.map((entry) => ({
        date: entry.date,
        cause: entry.cause,
        speciesCode: entry.speciesCode,
        count: entry.count,
        biomassLossKg: entry.biomassLossKg ?? null,
      })),
    },
    slaughter: {
      totalQuantity: payload.slaughter?.totalQuantity ?? 0,
      totalBiomassKg: payload.slaughter?.totalBiomassKg ?? 0,
      records: slaughterRecords.items.map((entry) => ({
        date: entry.date,
        speciesCode: entry.speciesCode,
        quantity: entry.quantity,
        biomassKg: entry.biomassKg,
      })),
    },
    transfers: transfers.items.map((entry) => ({
      date: entry.date,
      direction: String(entry.direction),
      speciesCode: entry.speciesCode,
      fishCount: entry.fishCount,
      biomassKg: entry.biomassKg,
      counterparty: entry.counterparty ?? null,
    })),
    feedConsumption: {
      totalKg: payload.feedConsumption?.totalKg ?? 0,
      byFeedType: feedEntries.items.map((entry) => ({
        feedName: entry.feedName,
        brandName: entry.brandName ?? null,
        quantityKg: entry.quantityKg,
      })),
    },
  };
}

// ---------------------------------------------------------------------------
// REG_REPORTS
// ---------------------------------------------------------------------------

/** One regulatory-report submission row (no form payload, no submitter PII). */
export interface RegulatoryReportDto {
  id: string;
  reportType: string;
  klientReferanse: string;
  siteId: string | null;
  lokalitetsnummer: number;
  reportYear: number | null;
  reportWeek: number | null;
  reportMonth: number | null;
  status: string;
  referanse: string | null;
  attemptCount: number;
  failureClass: string | null;
  submittedAt: string | null;
}

/**
 * Project a regulatory-report submission row. The full JSONB form payload
 * and the submitter identity stay behind the service surface.
 */
export function projectRegulatoryReport(
  row: RegulatoryReport,
): RegulatoryReportDto {
  return {
    id: row.id,
    reportType: String(row.reportType),
    klientReferanse: row.klientReferanse,
    siteId: row.siteId ?? null,
    lokalitetsnummer: row.lokalitetsnummer,
    reportYear: row.reportYear ?? null,
    reportWeek: row.reportWeek ?? null,
    reportMonth: row.reportMonth ?? null,
    status: String(row.status),
    referanse: row.referanse ?? null,
    attemptCount: row.attemptCount,
    failureClass: row.failureClass ? String(row.failureClass) : null,
    submittedAt: isoOrNull(row.submittedAt),
  };
}
