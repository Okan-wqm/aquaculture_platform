import 'reflect-metadata';
import type { ConfigService } from '@nestjs/config';
import { SecurityEventService, tenantFingerprint } from '@aquaculture/backend-common/security';
import { collaborator } from '@aquaculture/testing';

import { McpClientService } from '../mcp-client.service';
import { McpSessionBinding } from '../mcp-session-binding';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '99999999-9999-4999-8999-999999999999';

/** An unsigned JWT-shaped credential — the bridge only decodes the claim, the gateway verifies. */
function credentialFor(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part(claims)}.signature`;
}

function configWith(values: Record<string, string>): ConfigService {
  // A typed double of the one method the service reads.
  const get = jest
    .fn()
    .mockImplementation((key: string, fallback?: string) => values[key] ?? fallback);
  return collaborator<ConfigService>({ get }, 'ConfigService');
}

/**
 * K10 (MT-HIGH-064): the farm-service MCP bridge runs ONE child process under
 * ONE credential for a multi-tenant service. Until the per-tenant session pool
 * (PR-T2, MT-MEDIUM-065), the bridge is bound to the credential's tenant and
 * refuses every other caller before any MCP call.
 */
describe('McpClientService tenant binding', () => {
  let securityEvents: SecurityEventService;
  let publishTenantAccessDenied: jest.Mock;
  let mcpCallTool: jest.Mock;

  const build = (token: string): McpClientService => {
    const service = new McpClientService(
      configWith({ MCP_ENABLED: 'true', MCP_JWT_TOKEN: token }),
      securityEvents,
    );
    // Simulate a connected SDK session without spawning a child process.
    service['available'] = true;
    service['client'] = { connect: jest.fn(), close: jest.fn(), callTool: mcpCallTool };
    jest.spyOn(service['logger'], 'error').mockImplementation(() => undefined);
    return service;
  };

  beforeEach(() => {
    securityEvents = new SecurityEventService();
    publishTenantAccessDenied = jest.fn().mockResolvedValue(undefined);
    securityEvents.publishTenantAccessDenied = publishTenantAccessDenied;
    mcpCallTool = jest.fn().mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify({ overallRisk: 12 }) }],
    });
  });

  it('refuses a caller from another tenant: no MCP call, null result, security event', async () => {
    // SCENARIO: the session credential belongs to tenant A; a tenant-B user asks for a tank risk.
    // EXPECTS: the MCP child is never called and B gets nothing of A's.
    const service = build(credentialFor({ sub: 'svc', tenantId: TENANT_A }));

    const result = await service.callTool(TENANT_B, 'assess_risk', {
      scope: 'tank',
      entityId: 'x',
    });

    expect(result).toBeNull();
    expect(mcpCallTool).not.toHaveBeenCalled();
    expect(publishTenantAccessDenied).toHaveBeenCalledWith({
      tenantId: TENANT_B,
      // Tenant B's event names the session tenant only by fingerprint (V-T1a-10).
      requestedTenantId: tenantFingerprint(TENANT_A),
      reason: 'mcp_session_tenant_mismatch:assess_risk',
    });
    expect(JSON.stringify(publishTenantAccessDenied.mock.calls)).not.toContain(TENANT_A);
  });

  it("serves a caller of the session's own tenant", async () => {
    const service = build(credentialFor({ sub: 'svc', tenantId: TENANT_A }));

    await expect(service.callTool(TENANT_A, 'assess_risk', { scope: 'farm' })).resolves.toEqual({
      overallRisk: 12,
    });
    expect(publishTenantAccessDenied).not.toHaveBeenCalled();
  });

  it('refuses every caller when the credential names no tenant (fail closed)', async () => {
    const service = build(credentialFor({ sub: 'svc' }));

    expect(await service.callTool(TENANT_A, 'assess_risk', {})).toBeNull();
    expect(mcpCallTool).not.toHaveBeenCalled();
  });
});

describe('McpSessionBinding', () => {
  it('takes the tenant from the credential only', () => {
    expect(McpSessionBinding.fromCredential(credentialFor({ tenantId: TENANT_A }))?.tenantId).toBe(
      TENANT_A,
    );
  });

  it.each(['', 'not-a-jwt', credentialFor({ tenantId: 'tenant_a' }), 'a.%%%.c'])(
    'binds nothing for credential %p',
    (token) => {
      expect(McpSessionBinding.fromCredential(token)).toBeNull();
    },
  );

  it('admits only its own tenant', () => {
    const binding = McpSessionBinding.fromCredential(credentialFor({ tenantId: TENANT_A }));
    expect(binding?.admits(TENANT_A)).toBe(true);
    expect(binding?.admits(TENANT_B)).toBe(false);
  });
});
