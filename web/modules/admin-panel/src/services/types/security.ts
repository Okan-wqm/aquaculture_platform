/**
 * Security wire contracts.
 *
 * Response shapes are generated from the named backend projections. UI-facing
 * value aliases below are indexed from those generated contracts, so this file
 * cannot become a second schema authority.
 */

import type {
  AdminResponseProjectionById,
  AdminResponseProjectionId,
} from './generated/admin-route-contracts';

type SecurityProjectionPrefix =
  'apps/admin-api-service/src/security/contracts/admin-http-response.contract.ts';
type SecurityProjectionId = Extract<
  AdminResponseProjectionId,
  `${SecurityProjectionPrefix}#${string}`
>;
type SecurityProjectionName =
  SecurityProjectionId extends `${SecurityProjectionPrefix}#${infer TName}` ? TName : never;
type SecurityProjection<TName extends SecurityProjectionName> =
  AdminResponseProjectionById<`${SecurityProjectionPrefix}#${TName}`>;

export type AnalyzeLoginResultDto = SecurityProjection<'SecurityMonitoringAnalyzeLoginResponseDto'>;
export type AnomalyDetectionConfigDto =
  SecurityProjection<'SecurityMonitoringAnomalyDetectionConfigDtoDto'>;
export type ComplianceCheckResultDto = SecurityProjection<'ComplianceComplianceCheckResultDtoDto'>;
export type ComplianceReportDto = SecurityProjection<'ComplianceComplianceReportDtoDto'>;
export type ComplianceRequirementDto = SecurityProjection<'ComplianceComplianceRequirementDtoDto'>;
export type DataInventoryDto = SecurityProjection<'ComplianceDataInventoryDtoDto'>;
export type DataRequestDto = SecurityProjection<'ComplianceDataRequestDtoDto'>;
export type DataRequestStatsDto = SecurityProjection<'ComplianceDataRequestStatsDtoDto'>;
export type SecurityDashboardStatsDto =
  SecurityProjection<'SecurityMonitoringSecurityDashboardStatsDtoDto'>;
export type SecurityEventDto = SecurityProjection<'SecurityMonitoringSecurityEventDtoDto'>;
export type SecurityEventStatsDto =
  SecurityProjection<'SecurityMonitoringGetSecurityEventStatsResponseDto'>;
export type SecurityHealthScoreDto =
  SecurityProjection<'SecurityMonitoringSecurityHealthScoreDtoDto'>;
export type SecurityIncidentDto = SecurityProjection<'SecurityMonitoringSecurityIncidentDtoDto'>;
export type SecurityIncidentStatsDto =
  SecurityProjection<'SecurityMonitoringGetIncidentStatsResponseDto'>;
export type ThreatCheckDto = SecurityProjection<'SecurityMonitoringCheckThreatResponseDto'>;
export type ThreatIntelligenceDto =
  SecurityProjection<'SecurityMonitoringThreatIntelligenceDtoDto'>;
export type ThreatIntelligenceStatsDto =
  SecurityProjection<'SecurityMonitoringGetThreatIntelStatsResponseDto'>;

export type SecurityEventSeverity = SecurityEventDto['threatLevel'];
export type SecurityEventType = SecurityEventDto['eventType'];
export type SecurityEventStatus = SecurityEventDto['status'];
export type SecurityIncidentStatus = SecurityIncidentDto['status'];
export type ThreatIndicatorType = ThreatIntelligenceDto['indicatorType'];
export type ComplianceType = DataRequestDto['complianceFramework'];
export type DataRequestType = DataRequestDto['requestType'];
export type DataRequestStatus = DataRequestDto['status'];
