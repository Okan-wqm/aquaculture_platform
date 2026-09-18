import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AgentProfileService } from '../agent-profile.service';
import { AgentPersonaCatalogueService } from '../agent-persona-catalogue.service';
import { AgentConfigService } from '../../tenant-config/agent-config.service';
import { ToolRegistryService } from '../../tools/tool-registry.service';
import { OPERATOR_TIER, MANAGER_TIER, EXPERT_TIER, SUPERVISOR_TIER } from '../personas/tiers';

/**
 * FAZ0-BOOT-03 regression guard — now against the tier model (FARM-AI PR-2:
 * personas are composed tier × specialty, so the model lives on the TIER).
 *
 * WHY: tiers previously hardcoded nonexistent dated Anthropic model IDs
 * ('claude-haiku-4-5-20250515', 'claude-sonnet-4-5-20250514') — every chat
 * request would 404 at the Anthropic API. Tiers must carry catalog ALIASES
 * (no invented date suffixes), and the model must be resolvable from config
 * so a model retirement never requires a code change + redeploy.
 */
describe('tier model IDs (FAZ0-BOOT-03, FARM-AI PR-2)', () => {
  const tiers = [OPERATOR_TIER, MANAGER_TIER, EXPERT_TIER, SUPERVISOR_TIER];

  it('every tier uses a current catalog alias', () => {
    expect(OPERATOR_TIER.model).toBe('claude-haiku-4-5');
    expect(MANAGER_TIER.model).toBe('claude-sonnet-5');
    expect(EXPERT_TIER.model).toBe('claude-sonnet-5');
    expect(SUPERVISOR_TIER.model).toBe('claude-sonnet-5');
  });

  it('no tier carries an invented dated model suffix', () => {
    // The two broken IDs both matched claude-*-202505xx; dated snapshots are
    // only ever valid when they come verbatim from the Anthropic catalog, and
    // we standardize on aliases so retirements cannot 404 chat again.
    for (const tier of tiers) {
      expect(tier.model).not.toMatch(/-20\d{6}$/);
    }
  });
});

describe('AgentProfileService model resolution (FAZ0-BOOT-03)', () => {
  const tenantId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  const buildService = async (
    overrideModel: string | undefined,
  ): Promise<AgentProfileService> => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentProfileService,
        AgentPersonaCatalogueService,
        {
          provide: AgentConfigService,
          useValue: {
            getConfig: jest.fn().mockResolvedValue({
              baseProfileId: 'operator-v1',
              additionalToolNames: [],
              blockedToolNames: [],
              actuationPolicy: 'confirm_required',
              customSystemPrompt: null,
              provider: 'anthropic',
              chatModel: null,
            }),
          },
        },
        {
          provide: ToolRegistryService,
          useValue: { hasTool: jest.fn().mockReturnValue(true) },
        },
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

    return moduleRef.get(AgentProfileService);
  };

  it('resolves the tier default model when no override is configured', async () => {
    const service = await buildService(undefined);
    const profile = await service.resolveProfile(tenantId, 'operator-v1', {
      roles: ['MODULE_USER'],
      resourcePermissions: ['ai_personas:operator'],
    });
    expect(profile.persona.model).toBe('claude-haiku-4-5');
    expect(profile.personaTier).toBe('operator');
  });

  it('AI_CHAT_MODEL_OVERRIDE pins the model without mutating the composed singleton', async () => {
    const service = await buildService('claude-opus-4-8');
    const profile = await service.resolveProfile(tenantId, 'expert-v1', {
      roles: ['TENANT_ADMIN'],
      resourcePermissions: [],
    });

    expect(profile.persona.model).toBe('claude-opus-4-8');
    // Composed personas are module-level singletons shared across requests and
    // tenants — resolution must return a copy, never write through.
    expect(EXPERT_TIER.model).toBe('claude-sonnet-5');
    const resolvedAgain = await service.resolveProfile(tenantId, 'expert-v1', {
      roles: ['TENANT_ADMIN'],
      resourcePermissions: [],
    });
    expect(resolvedAgain.persona.model).toBe('claude-opus-4-8');
  });
});
