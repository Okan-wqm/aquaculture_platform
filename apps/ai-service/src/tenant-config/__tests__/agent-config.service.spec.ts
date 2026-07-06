import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AgentConfigService } from '../agent-config.service';
import { TenantAgentConfig } from '../agent-config.entity';

/**
 * FAZ1-BYOK fail-closed enablement + cross-tenant isolation + credential resolution.
 *
 * London-school: the repository is a mock. These specs pin the security-critical
 * contract — key-less tenants are NOT enabled, the credential resolves to the
 * SELECTED provider's key, and one tenant's read is scoped to its own row.
 */
describe('AgentConfigService (BYOK)', () => {
  const findOne = jest.fn();
  let service: AgentConfigService;

  const build = async (): Promise<void> => {
    findOne.mockReset();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentConfigService,
        {
          provide: getRepositoryToken(TenantAgentConfig),
          useValue: { findOne, save: jest.fn(), create: jest.fn() },
        },
      ],
    }).compile();
    service = moduleRef.get(AgentConfigService);
  };

  beforeEach(build);

  const configRow = (over: Partial<TenantAgentConfig>): TenantAgentConfig =>
    ({
      tenantId: 't1',
      isEnabled: true,
      provider: 'anthropic',
      anthropicApiKey: null,
      openaiApiKey: null,
      chatModel: null,
      monthlyTokenBudget: 1_000_000,
      hourlyRequestLimit: 60,
      ...over,
    }) as TenantAgentConfig;

  describe('resolveEnablement (fail-closed)', () => {
    it('enabled + provider key present → ok', async () => {
      findOne.mockResolvedValue(
        configRow({ isEnabled: true, provider: 'anthropic', anthropicApiKey: 'sk-ant-x' }),
      );
      await expect(service.resolveEnablement('t1')).resolves.toEqual({
        enabled: true,
        reason: 'ok',
        provider: 'anthropic',
      });
    });

    it('enabled + NO key for the selected provider → key_missing (NOT enabled)', async () => {
      findOne.mockResolvedValue(
        configRow({ isEnabled: true, provider: 'anthropic', anthropicApiKey: null }),
      );
      const result = await service.resolveEnablement('t1');
      expect(result.enabled).toBe(false);
      expect(result.reason).toBe('key_missing');
    });

    it('switch off → disabled even when a key exists', async () => {
      findOne.mockResolvedValue(
        configRow({ isEnabled: false, provider: 'anthropic', anthropicApiKey: 'sk-ant-x' }),
      );
      const result = await service.resolveEnablement('t1');
      expect(result.enabled).toBe(false);
      expect(result.reason).toBe('disabled');
    });

    it('provider=openai only checks the OpenAI key, not the Anthropic key', async () => {
      // Has an Anthropic key but the selected provider is OpenAI with no key →
      // still key_missing (must not silently spend the wrong provider's key).
      findOne.mockResolvedValue(
        configRow({
          isEnabled: true,
          provider: 'openai',
          anthropicApiKey: 'sk-ant-x',
          openaiApiKey: null,
        }),
      );
      const result = await service.resolveEnablement('t1');
      expect(result.enabled).toBe(false);
      expect(result.reason).toBe('key_missing');
      expect(result.provider).toBe('openai');
    });

    it('whitespace-only key counts as absent', async () => {
      findOne.mockResolvedValue(
        configRow({ isEnabled: true, provider: 'anthropic', anthropicApiKey: '   ' }),
      );
      await expect(service.resolveEnablement('t1')).resolves.toMatchObject({
        enabled: false,
        reason: 'key_missing',
      });
    });
  });

  describe('resolveCredential', () => {
    it('returns the selected provider and its key', async () => {
      findOne.mockResolvedValue(
        configRow({ provider: 'anthropic', anthropicApiKey: 'sk-ant-live' }),
      );
      await expect(service.resolveCredential('t1')).resolves.toEqual({
        provider: 'anthropic',
        apiKey: 'sk-ant-live',
      });
    });

    it('returns null when the selected provider has no key', async () => {
      findOne.mockResolvedValue(
        configRow({ provider: 'openai', openaiApiKey: null }),
      );
      await expect(service.resolveCredential('t1')).resolves.toBeNull();
    });
  });

  describe('cross-tenant isolation', () => {
    it('scopes the read to the requested tenant id (where clause)', async () => {
      findOne.mockResolvedValue(configRow({ tenantId: 'tenant-A', anthropicApiKey: 'sk-A' }));
      await service.resolveCredential('tenant-A');
      expect(findOne).toHaveBeenCalledWith({ where: { tenantId: 'tenant-A' } });
    });

    it('a tenant with no row gets defaults (no key), never another tenant’s data', async () => {
      findOne.mockResolvedValue(null);
      await expect(service.resolveCredential('tenant-new')).resolves.toBeNull();
      await expect(service.resolveEnablement('tenant-new')).resolves.toMatchObject({
        enabled: false,
        reason: 'key_missing',
      });
    });
  });
});
