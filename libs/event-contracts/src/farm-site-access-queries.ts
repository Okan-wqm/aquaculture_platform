/**
 * Farm-owned site authority contract used before auth grants site membership.
 *
 * The farm service remains the only authority for site existence, tenant
 * ownership, and operational availability. Auth receives only a boolean so
 * this request cannot become a cross-tenant site metadata oracle.
 */
export const FARM_SITE_ACCESS_QUERY_SUBJECTS = {
  VALIDATE_ASSIGNMENT: 'request.farm.validateSiteAssignment',
} as const;

export interface ValidateFarmSiteAssignmentRequest {
  tenantId: string;
  siteId: string;
}

export interface ValidateFarmSiteAssignmentResponse {
  assignable: boolean;
}

/** Runtime trust-boundary validation for the NATS request envelope. */
export function isValidateFarmSiteAssignmentRequest(
  value: unknown,
): value is ValidateFarmSiteAssignmentRequest {
  if (typeof value !== 'object' || value === null) return false;
  return (
    Object.keys(value).length === 2 &&
    'tenantId' in value &&
    typeof value.tenantId === 'string' &&
    'siteId' in value &&
    typeof value.siteId === 'string'
  );
}

/** Runtime trust-boundary validation for the NATS reply. */
export function isValidateFarmSiteAssignmentResponse(
  value: unknown,
): value is ValidateFarmSiteAssignmentResponse {
  if (typeof value !== 'object' || value === null) return false;
  return (
    Object.keys(value).length === 1 &&
    'assignable' in value &&
    typeof value.assignable === 'boolean'
  );
}
