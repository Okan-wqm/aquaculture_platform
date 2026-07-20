import type { BaseEvent } from './base-event';

/** Provider dispatched to the external Rust marine-analysis worker. */
export const MARINE_PROVIDERS = ['CMEMS'] as const;
export type MarineProvider = (typeof MARINE_PROVIDERS)[number];

/** Durable analysis resources created by farm-service. */
export const MARINE_ANALYSIS_JOB_KINDS = ['SNAPSHOT', 'AOI_STATS', 'TIME_SERIES'] as const;
export type MarineAnalysisJobKind = (typeof MARINE_ANALYSIS_JOB_KINDS)[number];

/**
 * Durable request emitted atomically with a marine analysis job.
 *
 * This event is deliberately a claim token, not an execution payload. The
 * authoritative job specification and any credential lease are obtained from
 * farm-service over the scoped worker control plane.
 */
export interface MarineAnalysisRequestedEvent extends BaseEvent {
  eventType: 'MarineAnalysisRequested';
  version: 1;
  aggregateId: string;
  aggregateType: 'MarineAnalysisJob';
  analysisJobId: string;
  executionId: string;
  siteId: string;
  marineAreaId: string;
  provider: MarineProvider;
  jobKind: MarineAnalysisJobKind;
  requestFingerprint: string;
  credentialGeneration: number;
  requestedAt: string;
}

export type MarineEvent = MarineAnalysisRequestedEvent;
