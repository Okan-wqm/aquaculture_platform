import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import {
  AgentProfileService,
  PersonaNotPermittedError,
} from '../agent-profile.service';
import { AgentConfigService } from '../../tenant-config/agent-config.service';
import { ToolRegistryService } from '../../tools/tool-registry.service';
import { AgentRole } from '../../tenant-config/agent-config.entity';

/**
 * AISAFETY-MEDIUM-013 persona-escalation guard.
 *
 * The autonomous 'supervisor' persona (actuationPolicy 'allowed') must never be
 * reachable by naming it in the request. Two independent fail-closed gates:
 * the tenant allowlist (applicableRoles) and the caller's platform-role ceiling.
 */
describe('AgentProfileService persona authorization (AISAFETY-MEDIUM-013)', () => {
  const tenantId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  const build = async (
    applicableRoles: AgentRole[],
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
              applicableRoles,
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

  const ALL: AgentRole[] = ['operator', 'manager', 'expert', 'supervisor'];

  it('a regular member (MODULE_USER) CANNOT reach the supervisor persona even if the tenant allows the tier', async () => {
    const service = await build(ALL); // tenant allows supervisor…
    await expect(
      // …but the user's role ceiling is operator.
      service.resolveProfile(tenantId, 'supervisor-v1', ['MODULE_USER']),
    ).rejects.toBeInstanceOf(PersonaNotPermittedError);
  });

  it('a TENANT_ADMIN CAN reach the supervisor persona when the tenant allows the tier', async () => {
    const service = await build(ALL);
    const profile = await service.resolveProfile(tenantId, 'supervisor-v1', [
      'TENANT_ADMIN',
    ]);
    expect(profile.persona.id).toBe('supervisor-v1');
  });

  it('the tenant allowlist blocks a tier even for an admin (both gates required)', async () => {
    // Tenant enables only operator; admin ceiling reaches supervisor, but the
    // tenant gate denies — both must pass.
    const service = await build(['operator']);
    await expect(
      service.resolveProfile(tenantId, 'expert-v1', ['TENANT_ADMIN']),
    ).rejects.toBeInstanceOf(PersonaNotPermittedError);
  });

  it('MODULE_MANAGER reaches expert but not supervisor', async () => {
    const service = await build(ALL);
    await expect(
      service.resolveProfile(tenantId, 'expert-v1', ['MODULE_MANAGER']),
    ).resolves.toMatchObject({ persona: { id: 'expert-v1' } });
    await expect(
      service.resolveProfile(tenantId, 'supervisor-v1', ['MODULE_MANAGER']),
    ).rejects.toBeInstanceOf(PersonaNotPermittedError);
  });

  it('the default operator persona is reachable by a plain member', async () => {
    const service = await build(['operator']);
    const profile = await service.resolveProfile(tenantId, 'operator-v1', [
      'MODULE_USER',
    ]);
    expect(profile.persona.id).toBe('operator-v1');
  });

  it('an unknown/empty role set gets the lowest ceiling (fail-closed)', async () => {
    const service = await build(ALL);
    await expect(
      service.resolveProfile(tenantId, 'manager-v1', []),
    ).rejects.toBeInstanceOf(PersonaNotPermittedError);
    await expect(
      service.resolveProfile(tenantId, 'manager-v1', ['SOME_UNKNOWN_ROLE']),
    ).rejects.toBeInstanceOf(PersonaNotPermittedError);
  });
});
