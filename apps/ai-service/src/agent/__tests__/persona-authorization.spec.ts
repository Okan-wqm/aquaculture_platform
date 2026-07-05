import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  AgentProfileService,
  PersonaNotPermittedError,
} from '../agent-profile.service';
import { AgentConfigService } from '../../tenant-config/agent-config.service';
import { ToolRegistryService } from '../../tools/tool-registry.service';

/**
 * AISAFETY-MEDIUM-013 persona-escalation guard.
 *
 * The autonomous 'supervisor' persona (actuationPolicy 'allowed') must never be
 * reachable by naming it in the request. The control is the caller's
 * platform-role ceiling: MODULE_USER→operator, MODULE_MANAGER→expert,
 * TENANT_ADMIN/SUPER_ADMIN→supervisor. (The per-tenant persona allowlist moves
 * to Faz 7 RBAC — enforcing it here with no admin write surface would brick
 * manager/expert/supervisor for everyone.)
 */
describe('AgentProfileService persona authorization (AISAFETY-MEDIUM-013)', () => {
  const tenantId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  const build = async (): Promise<AgentProfileService> => {
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
              chatModel: null,
            }),
          },
        },
        {
          provide: ToolRegistryService,
          useValue: { hasTool: jest.fn().mockReturnValue(true) },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
      ],
    }).compile();
    return moduleRef.get(AgentProfileService);
  };

  // A caller = platform roles (feed the admin bypass) + tenant-RBAC grants.
  const caller = (roles: string[], resourcePermissions: string[]) => ({
    roles,
    resourcePermissions,
  });

  it('a member without ai_personas:supervisor CANNOT reach the supervisor persona', async () => {
    const service = await build();
    await expect(
      service.resolveProfile(
        tenantId,
        'supervisor-v1',
        caller(['MODULE_USER'], ['ai_personas:operator']),
      ),
    ).rejects.toBeInstanceOf(PersonaNotPermittedError);
  });

  it('a TENANT_ADMIN bypasses and CAN reach the supervisor persona', async () => {
    const service = await build();
    const profile = await service.resolveProfile(
      tenantId,
      'supervisor-v1',
      caller(['TENANT_ADMIN'], []),
    );
    expect(profile.persona.id).toBe('supervisor-v1');
  });

  it('a caller granted ai_personas:expert reaches expert but not supervisor', async () => {
    const service = await build();
    const grants = ['ai_personas:operator', 'ai_personas:manager', 'ai_personas:expert'];
    await expect(
      service.resolveProfile(tenantId, 'expert-v1', caller(['MODULE_USER'], grants)),
    ).resolves.toMatchObject({ persona: { id: 'expert-v1' } });
    await expect(
      service.resolveProfile(tenantId, 'supervisor-v1', caller(['MODULE_USER'], grants)),
    ).rejects.toBeInstanceOf(PersonaNotPermittedError);
  });

  it('the operator persona is reachable by a caller granted ai_personas:operator', async () => {
    const service = await build();
    const profile = await service.resolveProfile(
      tenantId,
      'operator-v1',
      caller(['MODULE_USER'], ['ai_personas:operator']),
    );
    expect(profile.persona.id).toBe('operator-v1');
  });

  it('a caller with no persona grants is denied every tier (fail-closed)', async () => {
    const service = await build();
    await expect(
      service.resolveProfile(tenantId, 'manager-v1', caller(['MODULE_USER'], [])),
    ).rejects.toBeInstanceOf(PersonaNotPermittedError);
    await expect(
      service.resolveProfile(tenantId, 'operator-v1', caller([], [])),
    ).rejects.toBeInstanceOf(PersonaNotPermittedError);
  });

  it('the per-tenant chatModel override wins over the persona default', async () => {
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
              chatModel: 'claude-opus-4-8',
            }),
          },
        },
        {
          provide: ToolRegistryService,
          useValue: { hasTool: jest.fn().mockReturnValue(true) },
        },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
      ],
    }).compile();
    const service = moduleRef.get(AgentProfileService);

    const profile = await service.resolveProfile(
      tenantId,
      'operator-v1',
      caller(['MODULE_USER'], ['ai_personas:operator']),
    );
    expect(profile.persona.model).toBe('claude-opus-4-8');
  });
});
