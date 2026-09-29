/** Why a tenant-boundary check stopped an AI execution (K10 / MT-HIGH-062). */
export type TenantBoundaryViolationReason =
  /** A reply named a tenant other than the one the request was bound to. */
  | 'reply_tenant_mismatch'
  /** A reply carried no tenant-bound envelope, so it cannot prove whose data it holds. */
  | 'reply_without_tenant'
  /** A tool tried to put a tenant/schema field into a request the client builds. */
  | 'tenant_field_in_request'
  /** The context's tenant binding was not minted by TenantBinding (a structural copy). */
  | 'forged_binding';

/**
 * Thrown when an AI execution would cross a tenant boundary.
 *
 * WHY an exception that BaseTool re-throws instead of a tool error: a tool
 * error goes back to the model, which may retry or work around it. A boundary
 * violation must end the run (K10 layer 3: "çalıştırma tenant_mismatch ile
 * düşer"), so it travels past BaseTool, the executor (which audits it) and the
 * runner up to the entry point, which answers with a fixed error code.
 *
 * INVARIANT: the message carries no tenant id and no reply data, because it
 * can reach logs and the caller; if violated → the foreign tenant id leaks.
 */
export class TenantBoundaryViolation extends Error {
  readonly code = 'tenant_mismatch' as const;

  constructor(
    readonly subject: string,
    readonly reason: TenantBoundaryViolationReason,
  ) {
    super(`tenant_mismatch: ${subject} was stopped by the tenant-boundary check (${reason})`);
    this.name = 'TenantBoundaryViolation';
  }
}
