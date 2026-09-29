import { isValidUUID } from '@aquaculture/backend-common/database';

/**
 * The tenant an MCP session serves (K10 / MT-HIGH-064).
 *
 * WHY it is read from the session's OWN credential: the MCP child process
 * authenticates to the gateway with that token, so the token's `tenantId`
 * claim is the only tenant its answers can belong to. Nothing a caller passes
 * can change it. (The token is operator config, and the gateway verifies it on
 * every request the child makes; here it is only decoded to learn which tenant
 * that verified identity is.)
 *
 * Reuse seam: plan PR-T2 turns the bridge into a per-tenant session pool; each
 * pooled session carries its own binding and callers keep going through
 * {@link McpSessionBinding.admits}.
 */
export class McpSessionBinding {
  private constructor(readonly tenantId: string) {}

  /** The binding of a session credential, or null when it names no tenant (fail closed). */
  static fromCredential(token: string): McpSessionBinding | null {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[1] === undefined) return null;
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (typeof payload !== 'object' || payload === null || !('tenantId' in payload)) return null;
    const { tenantId } = payload;
    return typeof tenantId === 'string' && isValidUUID(tenantId)
      ? new McpSessionBinding(tenantId)
      : null;
  }

  /** True only for a caller of the session's own tenant. */
  admits(callerTenantId: string): boolean {
    return this.tenantId === callerTenantId;
  }
}
