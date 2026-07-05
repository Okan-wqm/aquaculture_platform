import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AgentProfileService } from '../agent-profile.service';
import { AgentConfigService } from '../../tenant-config/agent-config.service';
import { ToolRegistryService } from '../../tools/tool-registry.service';
import {
  OPERATOR_PERSONA,
  MANAGER_PERSONA,
  EXPERT_PERSONA,
  SUPERVISOR_PERSONA,
} from '../personas';

/**
 * FAZ0-BOOT-03 regression guard.
 *
 * WHY: personas previously hardcoded nonexistent dated Anthropic model IDs
 * ('claude-haiku-4-5-20250515', 'claude-sonnet-4-5-20250514') — every chat
 * request would 404 at the Anthropic API. Personas must carry catalog
 * ALIASES (no invented date suffixes), and the model must be resolvable from
 * config so a model retirement never requires a code change + redeploy.
 */
describe('persona model IDs (FAZ0-BOOT-03)', () => {
  const personas = [
    OPERATOR_PERSONA,
    MANAGER_PERSONA,
    EXPERT_PERSONA,
    SUPERVISOR_PERSONA,
  ];

  it('every persona uses a current catalog alias', () => {
    expect(OPERATOR_PERSONA.model).toBe('claude-haiku-4-5');
    expect(MANAGER_PERSONA.model).toBe('claude-sonnet-5');
    expect(EXPERT_PERSONA.model).toBe('claude-sonnet-5');
    expect(SUPERVISOR_PERSONA.model).toBe('claude-sonnet-5');
  });

  it('no persona carries an invented dated model suffix', () => {
    // The two broken IDs both matched claude-*-202505xx; dated snapshots are
    // only ever valid when they come verbatim from the Anthropic catalog, and
    // we standardize on aliases so retirements cannot 404 chat again.
    for (const persona of personas) {
      expect(persona.model).not.toMatch(/-20\d{6}$/);
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
        {
          provide: AgentConfigService,
          useValue: {
            getConfig: jest.fn().mockResolvedValue({
              baseProfileId: 'operator-v1',
              additionalToolNames: [],
              blockedToolNames: [],
              actuationPolicy: 'confirm_required',
              customSystemPrompt: null,
              // Tenant enables all tiers for these model-resolution tests; the
              // persona-authorization spec covers the allowlist/ceiling gates.
              applicableRoles: ['operator', 'manager', 'expert', 'supervisor'],
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

  it('resolves the persona default model when no override is configured', async () => {
    const service = await buildService(undefined);
    const profile = await service.resolveProfile(tenantId, 'operator-v1', ['MODULE_USER']);
    expect(profile.persona.model).toBe('claude-haiku-4-5');
  });

  it('AI_CHAT_MODEL_OVERRIDE pins the model without mutating the shared persona singleton', async () => {
    const service = await buildService('claude-opus-4-8');
    const profile = await service.resolveProfile(tenantId, 'expert-v1', ['TENANT_ADMIN']);

    expect(profile.persona.model).toBe('claude-opus-4-8');
    // Personas are module-level singletons shared across requests/tenants —
    // resolution must return a copy, never write through.
    expect(EXPERT_PERSONA.model).toBe('claude-sonnet-5');
  });
});
