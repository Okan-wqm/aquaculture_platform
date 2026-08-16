/** Audit wire contracts generated from backend executable projections. */

import type {
  AdminResponseProjectionById,
  AdminResponseProjectionId,
} from './generated/admin-route-contracts';

type AuditProjectionPrefix =
  'apps/admin-api-service/src/audit/contracts/admin-http-response.contract.ts';
type AuditProjectionId = Extract<
  AdminResponseProjectionId,
  `${AuditProjectionPrefix}#${string}`
>;
type AuditProjectionName =
  AuditProjectionId extends `${AuditProjectionPrefix}#${infer TName}` ? TName : never;
type AuditProjection<TName extends AuditProjectionName> =
  AdminResponseProjectionById<`${AuditProjectionPrefix}#${TName}`>;

export type AuditLogDto = AuditProjection<'AuditLogAuditLogDtoDto'>;
export type AuditStatisticsDto = AuditProjection<'AuditLogAuditStatisticsDtoDto'>;
