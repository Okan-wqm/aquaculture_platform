/** Report wire contracts generated from backend executable projections. */

import type {
  AdminResponseProjectionById,
  AdminResponseProjectionId,
} from './generated/admin-route-contracts';

type ReportProjectionPrefix =
  'apps/admin-api-service/src/analytics/contracts/admin-http-response.contract.ts';
type ReportProjectionId = Extract<
  AdminResponseProjectionId,
  `${ReportProjectionPrefix}#${string}`
>;
type ReportProjectionName =
  ReportProjectionId extends `${ReportProjectionPrefix}#${infer TName}` ? TName : never;
type ReportProjection<TName extends ReportProjectionName> =
  AdminResponseProjectionById<`${ReportProjectionPrefix}#${TName}`>;

export type ReportDefinitionDto = ReportProjection<'ReportsReportDefinitionDtoDto'>;
export type ReportExecutionDto = ReportProjection<'ReportsReportExecutionDtoDto'>;
export type ReportType = ReportDefinitionDto['type'];
export type ReportFormat = ReportDefinitionDto['defaultFormat'];
export type ReportStatus = ReportExecutionDto['status'];

export interface ReportData {
  columns: Array<{ key: string; label: string; type: string }>;
  rows: Array<Record<string, unknown>>;
  summary?: Record<string, unknown>;
  generatedAt: string;
}
