import 'reflect-metadata';
import type { RedisService } from '@aquaculture/backend-common/redis';
import { collaborator } from '@aquaculture/testing';

import { AiInsightsService } from '../ai-insights.service';
import type { McpClientService } from '../mcp-client.service';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '99999999-9999-4999-8999-999999999999';
const TANK = '22222222-2222-4222-8222-222222222222';

/**
 * K10 / MT-HIGH-064 (V-T1b-3, V-T1b-7): the MCP bridge serves one tenant, so
 * AI insights are a quiet "feature unavailable" for every other tenant —
 * decided before the cache and before any MCP call. Cache keys live in the
 * `ai-insights:v2` family, so entries written before the bridge was bound are
 * unreachable after deploy.
 */
describe('AiInsightsService tenant gate', () => {
  let callTool: jest.Mock;
  let getJson: jest.Mock;
  let service: AiInsightsService;

  beforeEach(() => {
    callTool = jest.fn().mockResolvedValue(null);
    getJson = jest.fn().mockResolvedValue(null);
    service = new AiInsightsService(
      collaborator<McpClientService>(
        { servesTenant: (tenantId: string) => tenantId === TENANT_A, callTool },
        'McpClientService',
      ),
      collaborator<RedisService>({ getJson, setJson: jest.fn() }, 'RedisService'),
    );
  });

  it('answers "unavailable" for a tenant the session does not serve — no cache read, no MCP call', async () => {
    // SCENARIO: a tenant-B user opens the tank screen while the bridge serves tenant A.
    // EXPECTS: null / [] / the degraded dashboard; Redis and MCP are never touched,
    //          so no stale entry and no MCP answer of A's can reach B.
    await expect(service.getTankRiskAssessment(TANK, TENANT_B)).resolves.toBeNull();
    await expect(service.getBatchGrowthPrediction(TANK, TENANT_B)).resolves.toBeNull();
    await expect(service.getFeedingAdvice(TANK, TENANT_B)).resolves.toBeNull();
    await expect(service.getFarmAnomalies(TENANT_B)).resolves.toEqual([]);
    await expect(service.getDashboardInsights(TENANT_B)).resolves.toEqual({
      overallRiskScore: 0,
      tankRisks: [],
      anomalies: [],
      feedingAdvice: [],
    });
    expect(getJson).not.toHaveBeenCalled();
    expect(callTool).not.toHaveBeenCalled();
  });

  it('reads the v2 cache family and asks MCP for the served tenant', async () => {
    // SCENARIO: a tenant-A user asks for a tank risk.
    // EXPECTS: the cache is read under ai-insights:v2:…:<A>… and MCP is called for A.
    await service.getTankRiskAssessment(TANK, TENANT_A);
    expect(getJson).toHaveBeenCalledWith(expect.stringMatching(/^ai-insights:v2:risk:tank:/));
    expect(getJson.mock.calls[0]?.[0]).toContain(TENANT_A);
    expect(callTool).toHaveBeenCalledWith(TENANT_A, 'assess_risk', expect.any(Object));
  });
});
