/**
 * Field-provenance model for server-assembled regulatory report drafts.
 *
 * Every leaf the assembler writes into a draft payload carries a
 * ReportFieldMeta describing WHERE the value came from:
 *   - RECORDS: aggregated from operational source-of-truth rows
 *     (mortality_records, feeding_records, harvest_records, …). The report
 *     never forks from operations — corrections flow to the source records
 *     and the draft re-assembles.
 *   - SENSOR: read from a sensor-fed projection (e.g. water temperature);
 *     carries the sensor identity + measurement time so the operator can
 *     judge freshness and override by recording a MANUAL measurement.
 *   - MANUAL_REQUIRED: the platform holds no source for this field — the
 *     operator must supply it. `blocking` marks the subset the official
 *     schema requires, which prevents submission until filled.
 */

export enum ReportFieldProvenance {
  RECORDS = 'RECORDS',
  SENSOR = 'SENSOR',
  MANUAL_REQUIRED = 'MANUAL_REQUIRED',
}

export interface ReportFieldMeta {
  /** JSON pointer into the draft payload, e.g. "/mortality/byCause/0/count". */
  path: string;
  provenance: ReportFieldProvenance;
  /** RECORDS: number of source rows aggregated into the value. */
  sourceRecordCount?: number;
  /** RECORDS: the query/service that produced the value (debuggability + audit). */
  sourceQuery?: string;
  /** SENSOR: identity of the sensor whose reading was used. */
  sensorId?: string;
  /** SENSOR: when the used reading was measured. */
  measuredAt?: Date;
  /** MANUAL_REQUIRED: actionable reason ("No feeding records for 2026-06"). */
  message?: string;
  /** True when the field is schema-required and still MANUAL_REQUIRED. */
  blocking: boolean;
}

export interface AssembledDraft<TPayload extends object> {
  draftPayload: TPayload;
  fields: ReportFieldMeta[];
}

/** Convenience builders keeping assembler code declarative. */
export function fromRecords(
  path: string,
  sourceQuery: string,
  sourceRecordCount: number,
): ReportFieldMeta {
  return {
    path,
    provenance: ReportFieldProvenance.RECORDS,
    sourceQuery,
    sourceRecordCount,
    blocking: false,
  };
}

export function manualRequired(path: string, message: string, blocking: boolean): ReportFieldMeta {
  return { path, provenance: ReportFieldProvenance.MANUAL_REQUIRED, message, blocking };
}

export function fromSensor(path: string, sensorId: string, measuredAt: Date): ReportFieldMeta {
  return { path, provenance: ReportFieldProvenance.SENSOR, sensorId, measuredAt, blocking: false };
}
