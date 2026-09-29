import { getTenantSchemaName, isValidUUID } from '@aquaculture/backend-common/database';

/**
 * Thrown when a trusted entry point hands over something that is not a tenant
 * UUID. The entry points validate first; reaching this is a wiring bug.
 */
export class UntrustedTenantError extends Error {
  constructor() {
    super('A tenant binding can only be minted from a valid tenant UUID');
    this.name = 'UntrustedTenantError';
  }
}

/**
 * The ONE tenant an AI execution may touch (K10 / PR-T1, MT-HIGH-062).
 *
 * WHY a class with an ES private brand instead of a plain `tenantId: string`:
 *   - a string can be copied from anywhere (a tool input, a reply, a log line);
 *     a binding can only come from `fromTrustedRequest`, and the invariant
 *     tests/invariants/ai-tenant-boundary.spec.ts allows that call only in
 *     tool-context.factory.ts — the runner's context builder, fed from the
 *     verified request (gateway JWT / messaging / sensor-service mTLS CN);
 *   - TypeScript lets `{ tenantId } as TenantBinding` compile (a downcast),
 *     but `#brand` is not structural: `isGenuine` rejects such a forgery at
 *     runtime, and TenantBoundNatsClient calls it before every request.
 *
 * INVARIANT: every tenant id that reaches a tool request was minted here from
 * a trusted request; if violated → a model-influenced value could pick the
 * tenant a tool reads.
 */
export class TenantBinding {
  readonly #brand = true;

  private constructor(
    /** Canonical tenant UUID, exactly as the trusted request carried it. */
    readonly tenantId: string,
    /** The tenant's schema, derived by the platform SSoT — never supplied separately. */
    readonly schemaName: string,
  ) {}

  /**
   * Mint a binding from a trusted request's tenant id.
   * Allowed caller: tool-context.factory.ts only (invariant-enforced).
   */
  static fromTrustedRequest(tenantId: unknown): TenantBinding {
    if (typeof tenantId !== 'string' || !isValidUUID(tenantId)) {
      throw new UntrustedTenantError();
    }
    return new TenantBinding(tenantId, getTenantSchemaName(tenantId));
  }

  /** True only for an instance this class minted — a structural copy fails. */
  static isGenuine(value: unknown): value is TenantBinding {
    return typeof value === 'object' && value !== null && #brand in value;
  }
}
