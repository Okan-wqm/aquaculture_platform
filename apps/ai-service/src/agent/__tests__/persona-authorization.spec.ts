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

  it('a regular member (MODULE_USER) CANNOT reach the supervisor persona', async () => {
    const service = await build();
    await expect(
      service.resolveProfile(tenantId, 'supervisor-v1', ['MODULE_USER']),
    ).rejects.toBeInstanceOf(PersonaNotPermittedError);
  });

  it('a TENANT_ADMIN CAN reach the supervisor persona', async () => {
    const service = await build();
    const profile = await service.resolveProfile(tenantId, 'supervisor-v1', [
      'TENANT_ADMIN',
    ]);
    expect(profile.persona.id).toBe('supervisor-v1');
  });

  it('MODULE_MANAGER reaches expert but not supervisor', async () => {
    const service = await build();
    await expect(
      service.resolveProfile(tenantId, 'expert-v1', ['MODULE_MANAGER']),
    ).resolves.toMatchObject({ persona: { id: 'expert-v1' } });
    await expect(
      service.resolveProfile(tenantId, 'supervisor-v1', ['MODULE_MANAGER']),
    ).rejects.toBeInstanceOf(PersonaNotPermittedError);
  });

  it('the default operator persona is reachable by a plain member', async () => {
    const service = await build();
    const profile = await service.resolveProfile(tenantId, 'operator-v1', [
      'MODULE_USER',
    ]);
    expect(profile.persona.id).toBe('operator-v1');
  });

  it('an unknown/empty role set gets the lowest ceiling (fail-closed)', async () => {
    const service = await build();
    await expect(
      service.resolveProfile(tenantId, 'manager-v1', []),
    ).rejects.toBeInstanceOf(PersonaNotPermittedError);
    await expect(
      service.resolveProfile(tenantId, 'manager-v1', ['SOME_UNKNOWN_ROLE']),
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

    const profile = await service.resolveProfile(tenantId, 'operator-v1', [
      'MODULE_USER',
    ]);
    expect(profile.persona.model).toBe('claude-opus-4-8');
  });
});
