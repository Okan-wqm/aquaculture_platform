import { canonicalWireJsonSha256V1, type CanonicalHashAuthorityV1 } from './canonical-json';

export const AUDIT_STATISTICS_SCOPE_SCHEMA_VERSION = 'audit-statistics-scope.v2' as const;
export const AUDIT_STATISTICS_SCOPE_HASH_AUTHORITY_V2: CanonicalHashAuthorityV1 = Object.freeze({
  domain: 'aquaculture.admin-audit-statistics-scope',
  schemaVersion: 'audit-statistics-scope/v2',
});

export interface AuditStatisticsScopeEvidenceV2 {
  readonly schemaVersion: typeof AUDIT_STATISTICS_SCOPE_SCHEMA_VERSION;
  readonly source: 'admin.audit_logs';
  readonly qualification: 'AUTHORITATIVE_RUNTIME_ONLY';
  readonly tenantId: string | null;
  readonly startDate: string | null;
  readonly endDate: string;
  readonly asOf: string;
}

export interface AuditStatisticsScopeV2 extends AuditStatisticsScopeEvidenceV2 {
  readonly scopeSha256: string;
}

export function auditStatisticsScopeSha256V2(evidence: AuditStatisticsScopeEvidenceV2): string {
  return canonicalWireJsonSha256V1(AUDIT_STATISTICS_SCOPE_HASH_AUTHORITY_V2, evidence);
}

export function createAuditStatisticsScopeV2(input: {
  readonly tenantId?: string | null;
  readonly startDate?: Date | null;
  readonly endDate: Date;
  readonly asOf: Date;
}): AuditStatisticsScopeV2 {
  const startDate = input.startDate?.toISOString() ?? null;
  const endDate = input.endDate.toISOString();
  const asOf = input.asOf.toISOString();
  if (Date.parse(endDate) > Date.parse(asOf)) {
    throw new TypeError('Audit statistics scope cannot end after its asOf cut');
  }
  if (startDate !== null && Date.parse(startDate) > Date.parse(endDate)) {
    throw new TypeError('Audit statistics scope startDate must not exceed endDate');
  }
  const evidence: AuditStatisticsScopeEvidenceV2 = Object.freeze({
    schemaVersion: AUDIT_STATISTICS_SCOPE_SCHEMA_VERSION,
    source: 'admin.audit_logs',
    qualification: 'AUTHORITATIVE_RUNTIME_ONLY',
    tenantId: input.tenantId ?? null,
    startDate,
    endDate,
    asOf,
  });
  return Object.freeze({
    ...evidence,
    scopeSha256: auditStatisticsScopeSha256V2(evidence),
  });
}

export function auditStatisticsScopeHasValidIdentityV2(scope: AuditStatisticsScopeV2): boolean {
  const { scopeSha256, ...evidence } = scope;
  return scopeSha256 === auditStatisticsScopeSha256V2(evidence);
}

interface AuditStatisticsNamedCountV2 {
  readonly count: number;
}

export interface AuditStatisticsProjectionEvidenceV2 {
  readonly scope: AuditStatisticsScopeV2;
  /** Rows eligible for completeness/security claims. */
  readonly totalLogs: number;
  /** Every row in the cut, including searchable unverified imports. */
  readonly observedLogs: number;
  readonly legacyUnverifiedLogs: number;
  readonly last24Hours: number;
  readonly byAction: readonly AuditStatisticsNamedCountV2[];
  readonly bySeverity: readonly AuditStatisticsNamedCountV2[];
  readonly byEntityType: readonly AuditStatisticsNamedCountV2[];
  readonly topUsers: readonly AuditStatisticsNamedCountV2[];
}

function isValidAuditCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function countSum(entries: readonly AuditStatisticsNamedCountV2[]): number | null {
  let total = 0;
  for (const entry of entries) {
    if (!isValidAuditCount(entry.count)) return null;
    total += entry.count;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

export function auditStatisticsProjectionHasValidEvidenceV2(
  projection: AuditStatisticsProjectionEvidenceV2,
): boolean {
  if (
    !auditStatisticsScopeHasValidIdentityV2(projection.scope) ||
    !isValidAuditCount(projection.totalLogs) ||
    !isValidAuditCount(projection.observedLogs) ||
    !isValidAuditCount(projection.legacyUnverifiedLogs) ||
    projection.observedLogs !== projection.totalLogs + projection.legacyUnverifiedLogs ||
    !isValidAuditCount(projection.last24Hours) ||
    projection.last24Hours > projection.totalLogs
  ) {
    return false;
  }
  if (
    countSum(projection.byAction) !== projection.totalLogs ||
    countSum(projection.bySeverity) !== projection.totalLogs ||
    countSum(projection.byEntityType) !== projection.totalLogs
  ) {
    return false;
  }
  return projection.topUsers.every(
    ({ count }) => isValidAuditCount(count) && count <= projection.totalLogs,
  );
}
