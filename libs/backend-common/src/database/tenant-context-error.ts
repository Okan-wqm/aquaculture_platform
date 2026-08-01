/**
 * Failure states for the tenant database boundary assertion.
 *
 * The names are the backend subset of the FarmDataReadTrace `resultState`
 * taxonomy so a thrown error maps 1:1 onto an observable diagnostic state
 * instead of a silent empty result.
 */
export type TenantContextFailureState =
  | 'TENANT_CONTEXT_MISSING'
  | 'SCHEMA_MISMATCH'
  | 'RLS_MISMATCH';

export interface TenantContextErrorDetails {
  readonly state: TenantContextFailureState;
  /** Schema the boundary expected to be active (`tenant_<16hex>`). */
  readonly expectedSchema: string;
  /** Schema actually resolved by `current_schema()`, or null if unavailable. */
  readonly resolvedSchema: string | null;
  /** Source schema in the search_path fallback chain (e.g. `farm`). */
  readonly sourceSchema: string;
}

/**
 * Thrown by the tenant DB boundary when — after pinning `search_path` and the
 * `app.current_tenant` RLS GUC — the live connection does NOT actually resolve
 * to the expected tenant schema / tenant id.
 *
 * This converts the platform's worst silent failure mode (an RLS-denied or
 * wrong-schema read that returns an empty list indistinguishable from a
 * legitimately-empty table) into a hard, observable error. The boundary either
 * runs the domain query in a verified tenant context, or it throws. See the
 * Farm Data SSOT plan §5-1 and `tenant-transaction.ts`.
 *
 * Authority identifiers remain available only as typed internal properties for
 * the boundary's control flow. The Error message is safe to cross an admission
 * or telemetry boundary: it contains the stable failure state but no tenant or
 * schema value.
 */
export class TenantContextError extends Error implements TenantContextErrorDetails {
  readonly state: TenantContextFailureState;
  readonly expectedSchema: string;
  readonly resolvedSchema: string | null;
  readonly sourceSchema: string;

  constructor(details: TenantContextErrorDetails) {
    super(
      `Tenant DB boundary assertion failed [${details.state}]. ` +
        'Refusing to run a domain query against an unverified tenant context.',
    );
    this.name = 'TenantContextError';
    this.state = details.state;
    this.expectedSchema = details.expectedSchema;
    this.resolvedSchema = details.resolvedSchema;
    this.sourceSchema = details.sourceSchema;
  }
}
