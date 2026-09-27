import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AgentProfileService } from '../agent-profile.service';
import { AgentPersonaCatalogueService } from '../agent-persona-catalogue.service';
import { AgentConfigService } from '../../tenant-config/agent-config.service';
import { ToolRegistryService } from '../../tools/tool-registry.service';
import { TIERS } from '../personas';
import { fakeToolRegistry } from './fixtures/fake-tool-registry';

/**
 * FAZ0-BOOT-03 regression guard.
 *
 * WHY: personas previously hardcoded nonexistent dated Anthropic model IDs
 * ('claude-haiku-4-5-20250515', 'claude-sonnet-4-5-20250514') — every chat
 * request would 404 at the Anthropic API. Tiers must carry catalog ALIASES
 * (no invented date suffixes), and the model must be resolvable from config
 * so a model retirement never requires a code change + redeploy.
 */
describe('tier model IDs (FAZ0-BOOT-03)', () => {
  it('every tier uses a current catalog alias', () => {
    expect(TIERS.operator.model).toBe('claude-haiku-4-5');
    expect(TIERS.manager.model).toBe('claude-sonnet-5');
    expect(TIERS.expert.model).toBe('claude-sonnet-5');
    expect(TIERS.supervisor.model).toBe('claude-sonnet-5');
  });

  it('no tier carries an invented dated model suffix', () => {
    // The two broken IDs both matched claude-*-202505xx; dated snapshots are
    // only ever valid when they come verbatim from the Anthropic catalog, and
    // we standardize on aliases so retirements cannot 404 chat again.
    for (const tier of Object.values(TIERS)) {
      expect(tier.model).not.toMatch(/-20\d{6}$/);
    }
  });
});

describe('AgentProfileService model resolution (FAZ0-BOOT-03)', () => {
  const tenantId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  const buildService = async (
    overrideModel: string | undefined,
    provider: 'anthropic' | 'zai' = 'anthropic',
  ): Promise<{ service: AgentProfileService; catalogue: AgentPersonaCatalogueService }> => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentProfileService,
        AgentPersonaCatalogueService,
        {
          provide: AgentConfigService,
          useValue: {
            getConfig: jest.fn().mockResolvedValue({
              provider,
              baseProfileId: 'operator-v1',
              additionalToolNames: [],
              blockedToolNames: [],
              actuationPolicy: 'confirm_required',
              customSystemPrompt: null,
              chatModel: null,
            }),
          },
        },
        { provide: ToolRegistryService, useValue: fakeToolRegistry() },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) =>
              key === 'AI_CHAT_MODEL_OVERRIDE' ? overrideModel : undefined,
            ),
          },
        },
      ],
    }).compile();

    return {
      service: moduleRef.get(AgentProfileService),
      catalogue: moduleRef.get(AgentPersonaCatalogueService),
    };
  };

  it('resolves the tier default model when no override is configured', async () => {
    const { service } = await buildService(undefined);
    const profile = await service.resolveProfile(tenantId, 'operator-v1', {
      roles: ['MODULE_USER'],
      resourcePermissions: ['ai_personas:operator'],
    });
    expect(profile.persona.model).toBe('claude-haiku-4-5');
  });

  it('AI_CHAT_MODEL_OVERRIDE pins the model without mutating the composed persona singleton', async () => {
    const { service, catalogue } = await buildService('claude-opus-4-8');
    const profile = await service.resolveProfile(tenantId, 'expert-v1', {
      roles: ['TENANT_ADMIN'],
      resourcePermissions: [],
    });

    expect(profile.persona.model).toBe('claude-opus-4-8');
    // Composed personas are shared across requests/tenants — resolution must
    // return a copy, never write through.
    expect(catalogue.resolve('expert-v1').model).toBe('claude-sonnet-5');
    expect(TIERS.expert.model).toBe('claude-sonnet-5');
  });

  it('a Z.ai tenant without a chatModel falls back to the Z.ai default, not the Anthropic alias', async () => {
    const { service } = await buildService(undefined, 'zai');
    const profile = await service.resolveProfile(tenantId, 'operator-v1', {
      roles: ['MODULE_USER'],
      resourcePermissions: ['ai_personas:operator'],
    });
    expect(profile.persona.model).not.toBe('claude-haiku-4-5');
    expect(profile.persona.model.startsWith('glm')).toBe(true);
  });
});
