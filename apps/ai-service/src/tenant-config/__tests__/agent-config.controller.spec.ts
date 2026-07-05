import 'reflect-metadata';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { AgentConfigController } from '../agent-config.controller';

/**
 * FAZ1-BYOK CRUD contract: masked reads, validate-before-persist, key clearing,
 * masked-hint rejection, tenant scoping from the verified context.
 */
describe('AgentConfigController (BYOK settings)', () => {
  const agentConfig = {
    getConfig: jest.fn(),
    resolveEnablement: jest.fn(),
    upsertConfig: jest.fn(),
  };
  const validateCredential = jest.fn();
  const providerFactory = {
    get: jest.fn().mockReturnValue({ validateCredential }),
    supports: jest.fn().mockReturnValue(true),
    availableProviders: jest.fn().mockReturnValue(['anthropic']),
  };

  const controller = new AgentConfigController(
    agentConfig as never,
    providerFactory as never,
  );

  const req = (tenantId?: string) =>
    ({ tenantId, user: { sub: 'u1', tenantId, roles: ['TENANT_ADMIN'] } }) as never;

  beforeEach(() => {
    jest.clearAllMocks();
    agentConfig.getConfig.mockResolvedValue({
      provider: 'anthropic',
      anthropicApiKey: 'sk-ant-abcd1234',
      openaiApiKey: null,
      chatModel: null,
      monthlyTokenBudget: 1_000_000,
      hourlyRequestLimit: 60,
    });
    agentConfig.resolveEnablement.mockResolvedValue({
      enabled: true,
      reason: 'ok',
      provider: 'anthropic',
    });
  });

  it('GET returns a masked last-4 hint, never the raw key', async () => {
    const view = await controller.getSettings(req('t1'));
    expect(view.anthropicKeyHint).toBe('••••1234');
    expect(view.openaiKeyHint).toBeNull();
    // The raw key must not appear anywhere in the serialized view.
    expect(JSON.stringify(view)).not.toContain('sk-ant-abcd1234');
  });

  it('PUT validates a new key against the live provider before persisting', async () => {
    validateCredential.mockResolvedValue(true);
    await controller.updateSettings(req('t1'), { anthropicApiKey: 'sk-ant-new' } as never);

    expect(validateCredential).toHaveBeenCalledWith({
      provider: 'anthropic',
      apiKey: 'sk-ant-new',
    });
    expect(agentConfig.upsertConfig).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ anthropicApiKey: 'sk-ant-new' }),
    );
  });

  it('PUT rejects an invalid key with 400 (not 401) and does NOT persist it', async () => {
    validateCredential.mockResolvedValue(false);
    await expect(
      controller.updateSettings(req('t1'), { anthropicApiKey: 'sk-bad' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(agentConfig.upsertConfig).not.toHaveBeenCalled();
  });

  it('PUT clears a key on empty string without a validation ping', async () => {
    await controller.updateSettings(req('t1'), { anthropicApiKey: '' } as never);
    expect(validateCredential).not.toHaveBeenCalled();
    expect(agentConfig.upsertConfig).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ anthropicApiKey: null }),
    );
  });

  it('PUT rejects an echoed masked hint being submitted as a key (400)', async () => {
    await expect(
      controller.updateSettings(req('t1'), { anthropicApiKey: '••••1234' } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(validateCredential).not.toHaveBeenCalled();
  });

  it('PUT rejects a key for an unwired provider with 400 (not 500)', async () => {
    providerFactory.supports = jest.fn().mockReturnValue(false);
    providerFactory.availableProviders = jest.fn().mockReturnValue(['anthropic']);
    await expect(
      controller.updateSettings(
        req('t1'),
        { provider: 'openai', openaiApiKey: 'sk-openai' } as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(agentConfig.upsertConfig).not.toHaveBeenCalled();
  });

  it('requires a tenant context (no tenant → Unauthorized)', async () => {
    await expect(controller.getSettings(req(undefined))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
