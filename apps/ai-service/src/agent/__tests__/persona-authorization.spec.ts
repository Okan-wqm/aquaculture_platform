import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AgentProfileService, PersonaNotPermittedError } from '../agent-profile.service';
import {
  AgentPersonaCatalogueService,
  UnknownPersonaError,
} from '../agent-persona-catalogue.service';
import { AgentConfigService } from '../../tenant-config/agent-config.service';
import { ToolRegistryService } from '../../tools/tool-registry.service';
import { fakeToolRegistry } from './fixtures/fake-tool-registry';

/**
 * AISAFETY-MEDIUM-013 persona-escalation guard + RBAC-MEDIUM-016 specialty
 * entitlement + AISAFETY-MEDIUM-024 fail-closed resolution.
 *
 * The autonomous 'supervisor' persona (actuationPolicy 'allowed') must never be
 * reachable by naming it in the request; a module-scoped specialist needs the
 * tier capability AND `ai_specialties:<module>`; an unknown persona id is a
 * hard error, never a silent downgrade to the tenant default.
 */
describe('AgentProfileService persona authorization', () => {
  const tenantId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  interface ConfigOverrides {
    chatModel?: string | null;
    actuationPolicy?: string;
    additionalToolNames?: string[];
    blockedToolNames?: string[];
  }

  const build = async (overrides: ConfigOverrides = {}): Promise<AgentProfileService> => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentProfileService,
        AgentPersonaCatalogueService,
        {
          provide: AgentConfigService,
          useValue: {
            getConfig: jest.fn().mockResolvedValue({
              provider: 'anthropic',
              baseProfileId: 'operator-v1',
              additionalToolNames: overrides.additionalToolNames ?? [],
              blockedToolNames: overrides.blockedToolNames ?? [],
              actuationPolicy: overrides.actuationPolicy ?? 'confirm_required',
              customSystemPrompt: null,
              chatModel: overrides.chatModel ?? null,
            }),
          },
        },
        { provide: ToolRegistryService, useValue: fakeToolRegistry() },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(undefined) } },
      ],
    }).compile();
    return moduleRef.get(AgentProfileService);
  };

  // A caller = platform roles (feed the admin bypass) + tenant-RBAC grants.
  const caller = (
    roles: string[],
    resourcePermissions: string[],
  ): { roles: string[]; resourcePermissions: string[] } => ({ roles, resourcePermissions });

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
    expect(profile.persona.tier).toBe('supervisor');
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

  it('the per-tenant chatModel override wins over the tier default', async () => {
    const service = await build({ chatModel: 'claude-opus-4-8' });
    const profile = await service.resolveProfile(
      tenantId,
      'operator-v1',
      caller(['MODULE_USER'], ['ai_personas:operator']),
    );
    expect(profile.persona.model).toBe('claude-opus-4-8');
  });

  describe('module-scoped specialists (RBAC-MEDIUM-016)', () => {
    it('the tier capability alone does NOT reach a farm specialist', async () => {
      const service = await build();
      await expect(
        service.resolveProfile(
          tenantId,
          'expert-farm-production-v1',
          caller(
            ['MODULE_USER'],
            ['ai_personas:operator', 'ai_personas:manager', 'ai_personas:expert'],
          ),
        ),
      ).rejects.toBeInstanceOf(PersonaNotPermittedError);
    });

    it('the specialty capability alone does NOT reach a farm specialist', async () => {
      const service = await build();
      await expect(
        service.resolveProfile(
          tenantId,
          'operator-farm-operations-v1',
          caller(['MODULE_USER'], ['ai_specialties:farm']),
        ),
      ).rejects.toBeInstanceOf(PersonaNotPermittedError);
    });

    it('tier ∧ specialty reaches the farm specialist, composed from both axes', async () => {
      const service = await build();
      const profile = await service.resolveProfile(
        tenantId,
        'expert-farm-production-v1',
        caller(['MODULE_USER'], ['ai_personas:expert', 'ai_specialties:farm']),
      );
      expect(profile.persona).toMatchObject({
        id: 'expert-farm-production-v1',
        tier: 'expert',
        specialty: 'farm-production',
        model: 'claude-sonnet-5',
        maxTokensPerTurn: 16384,
      });
      // expert ceiling confirm_required ∧ farm cap confirm_required ∧ tenant confirm_required
      expect(profile.actuationPolicy).toBe('confirm_required');
      // The expert tier sees the whole production bundle including the
      // manager+ finance reads; an operator would not (see below).
      expect(profile.effectiveToolNames).toEqual(
        expect.arrayContaining([
          'get_farm_batches',
          'get_batch_performance',
          'get_finance_summary',
        ]),
      );
      const operator = await service.resolveProfile(
        tenantId,
        'operator-farm-production-v1',
        caller(['MODULE_USER'], ['ai_personas:operator', 'ai_specialties:farm']),
      );
      expect(operator.effectiveToolNames).toContain('get_batch_performance');
      expect(operator.effectiveToolNames).not.toContain('get_finance_summary');
      expect(operator.effectiveToolNames).not.toContain('get_finance_batch_totals');
    });

    it('a TENANT_ADMIN bypasses both capabilities', async () => {
      const service = await build();
      const profile = await service.resolveProfile(
        tenantId,
        'manager-farm-water-health-v1',
        caller(['TENANT_ADMIN'], []),
      );
      expect(profile.persona.specialty).toBe('farm-water-health');
    });
  });

  describe('fail-closed resolution (AISAFETY-MEDIUM-024)', () => {
    it('an unknown persona id is an UnknownPersonaError, never a fallback to the tenant default', async () => {
      const service = await build();
      await expect(
        service.resolveProfile(tenantId, 'bogus-v1', caller(['TENANT_ADMIN'], [])),
      ).rejects.toBeInstanceOf(UnknownPersonaError);
      // A farm specialist is never published at the supervisor tier.
      await expect(
        service.resolveProfile(
          tenantId,
          'supervisor-farm-production-v1',
          caller(['TENANT_ADMIN'], []),
        ),
      ).rejects.toBeInstanceOf(UnknownPersonaError);
    });
  });

  describe('effective tool set', () => {
    it('never offers a tool the persona tier cannot run, even when the tenant adds it', async () => {
      const service = await build({ additionalToolNames: ['calculate_reagent_dosing'] });
      const profile = await service.resolveProfile(
        tenantId,
        'operator-v1',
        caller(['MODULE_USER'], ['ai_personas:operator']),
      );
      expect(profile.effectiveToolNames).not.toContain('calculate_reagent_dosing');
    });

    it('under a blocked policy, withholds confirmation-class tools instead of offering-then-refusing', async () => {
      const service = await build({ actuationPolicy: 'blocked' });
      const profile = await service.resolveProfile(
        tenantId,
        'operator-farm-operations-v1',
        caller(['MODULE_USER'], ['ai_personas:operator', 'ai_specialties:farm']),
      );
      expect(profile.actuationPolicy).toBe('blocked');
      expect(profile.effectiveToolNames).not.toContain('create_task');
      expect(profile.effectiveToolNames).toEqual(
        expect.arrayContaining(['get_farm_tanks', 'list_todays_tasks', 'list_overdue_work_orders']),
      );
    });

    it('honours tenant blocks', async () => {
      const service = await build({ blockedToolNames: ['get_reagent_list'] });
      const profile = await service.resolveProfile(
        tenantId,
        'operator-v1',
        caller(['MODULE_USER'], ['ai_personas:operator']),
      );
      expect(profile.effectiveToolNames).not.toContain('get_reagent_list');
    });
  });
});
