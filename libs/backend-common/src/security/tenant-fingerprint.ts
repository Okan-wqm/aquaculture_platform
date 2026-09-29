import { createHash } from 'node:crypto';

/**
 * A stable, non-reversible fingerprint of a tenant id: `sha256:<16 hex>`.
 *
 * WHY (K10 / PR-T1, V-T1a-10): a TenantAccessDenied event belongs to the tenant
 * whose request was refused and may surface in that tenant's security views.
 * When the refusal names ANOTHER tenant (the tenant a foreign reply claimed,
 * the tenant an MCP session serves), writing that tenant's UUID into the event
 * would itself disclose it across the boundary. The fingerprint still lets an
 * operator correlate incidents per tenant.
 */
export function tenantFingerprint(tenantId: string): string {
  return `sha256:${createHash('sha256').update(tenantId).digest('hex').slice(0, 16)}`;
}
