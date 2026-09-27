import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AI_PERSONA_CATALOGUE } from '@aquaculture/shared-contracts';
import { AgentPersonaCatalogueModule } from '../agent-persona-catalogue.module';
import { AgentPersonaCatalogueService } from '../agent-persona-catalogue.service';
import { ToolRegistryModule } from '../../tools/tool-registry.module';
import { WaterChemistryToolsModule } from '../../tools/water-chemistry/water-chemistry-tools.module';
import { SensorConfigToolsModule } from '../../tools/sensor-config/sensor-config-tools.module';
import { FarmToolsModule } from '../../tools/farm/farm-tools.module';
import { AquacultureMathToolsModule } from '../../tools/aquaculture-math/aquaculture-math-tools.module';
import { ToolExecutionAudit } from '../../audit/tool-execution-audit.entity';
import { SPECIALTIES } from '../personas';

const AUDIT_REPO_STUB = { create: jest.fn(), save: jest.fn(), find: jest.fn() };

/**
 * The four legacy persona ids, frozen as the composition ships them. The
 * shape (tools, model, policy, budget) is exactly what the retired
 * agent/personas/{operator,manager,expert,supervisor}.ts carried; the display
 * names come from the shared catalogue (the pre-composition 'Operator' …
 * labels collided with the farm specialists' names).
 */
const LEGACY_PERSONAS = Object.freeze({
  'operator-v1': {
    id: 'operator-v1',
    name: 'Operations Assistant (General)',
    model: 'claude-haiku-4-5',
    defaultToolNames: [
      'calculate_ammonia_toxicity',
      'calculate_h2s_toxicity',
      'calculate_co2_level',
      'calculate_carbonate_chemistry',
      'get_reagent_list',
    ],
    actuationPolicy: 'confirm_required',
    maxTokensPerTurn: 4096,
  },
  'manager-v1': {
    id: 'manager-v1',
    name: 'Management Assistant (General)',
    model: 'claude-sonnet-5',
    defaultToolNames: [
      'calculate_ammonia_toxicity',
      'calculate_h2s_toxicity',
      'calculate_co2_level',
      'calculate_carbonate_chemistry',
      'calculate_reagent_dosing',
      'get_reagent_list',
      'simulate_dosing_effect',
    ],
    actuationPolicy: 'blocked',
    maxTokensPerTurn: 8192,
  },
  'expert-v1': {
    id: 'expert-v1',
    name: 'Aquaculture Expert (General)',
    model: 'claude-sonnet-5',
    defaultToolNames: [
      'calculate_ammonia_toxicity',
      'calculate_h2s_toxicity',
      'calculate_co2_level',
      'calculate_carbonate_chemistry',
      'calculate_reagent_dosing',
      'get_reagent_list',
      'simulate_dosing_effect',
    ],
    actuationPolicy: 'confirm_required',
    maxTokensPerTurn: 16384,
  },
  'supervisor-v1': {
    id: 'supervisor-v1',
    name: 'SCADA Supervisor (General)',
    model: 'claude-sonnet-5',
    defaultToolNames: [
      'calculate_ammonia_toxicity',
      'calculate_h2s_toxicity',
      'calculate_co2_level',
      'calculate_carbonate_chemistry',
      'calculate_reagent_dosing',
      'get_reagent_list',
      'simulate_dosing_effect',
    ],
    actuationPolicy: 'allowed',
    maxTokensPerTurn: 16384,
  },
} as const);

/**
 * Tier × specialty composition parity. Composes the catalogue against the
 * REAL tool modules (no registry double) and proves:
 *   1. the four legacy ids resolve to exactly what shipped before (shape) and
 *      their system prompts match the pinned snapshot (text);
 *   2. every published catalogue id composes and every specialty bundle is
 *      registered (the boot invariant, exercised here so a dangling tool name
 *      is a red build, not a silent empty belt).
 */
describe('persona composition parity', () => {
  let catalogue: AgentPersonaCatalogueService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ToolRegistryModule,
        WaterChemistryToolsModule,
        SensorConfigToolsModule,
        FarmToolsModule,
        AquacultureMathToolsModule,
        AgentPersonaCatalogueModule,
      ],
    })
      .overrideProvider(getRepositoryToken(ToolExecutionAudit))
      .useValue(AUDIT_REPO_STUB)
      .overrideProvider('NATS_SERVICE')
      .useValue({ send: jest.fn() })
      .compile();
    await moduleRef.init();
    catalogue = moduleRef.get(AgentPersonaCatalogueService);
  });

  it.each(Object.keys(LEGACY_PERSONAS))('%s composes to the shipped persona shape', (id) => {
    const legacy = LEGACY_PERSONAS[id as keyof typeof LEGACY_PERSONAS];
    const composed = catalogue.resolve(id);
    expect({
      id: composed.id,
      name: composed.name,
      model: composed.model,
      defaultToolNames: composed.defaultToolNames,
      actuationPolicy: composed.actuationPolicy,
      maxTokensPerTurn: composed.maxTokensPerTurn,
    }).toEqual(legacy);
  });

  // The prompt snapshots ARE the reviewed prompt text: any change to the
  // preamble, a tier fragment or a specialty fragment shows up as a snapshot
  // diff in review, never as a silent behaviour change.
  it.each(AI_PERSONA_CATALOGUE.map((entry) => entry.id))('%s system prompt is pinned', (id) => {
    expect(catalogue.resolve(id).systemPrompt).toMatchSnapshot();
  });

  it('every composed prompt opens with the operating contract, carries exactly one decision bullet matching its actuation ceiling, and never a reserved delimiter', () => {
    for (const persona of catalogue.list()) {
      expect(persona.systemPrompt.startsWith('OPERATING CONTRACT')).toBe(true);
      // The decision bullet follows the tier ceiling: advisory tiers never
      // act, the autonomous supervisor may — a persona never carries both.
      const advisory = persona.systemPrompt.includes('You advise; the user decides.');
      const autonomous = persona.systemPrompt.includes(
        'You may act through your tools within the platform',
      );
      expect({ id: persona.id, advisory, autonomous }).toEqual({
        id: persona.id,
        advisory: persona.tier !== 'supervisor',
        autonomous: persona.tier === 'supervisor',
      });
      expect(persona.systemPrompt).toContain('Always respond in the user');
      for (const delimiter of ['[SYSTEM', 'IMMUTABLE', 'DO NOT OVERRIDE', '[END SYSTEM]']) {
        expect(persona.systemPrompt).not.toContain(delimiter);
      }
    }
  });

  it('every published catalogue id composes, and nothing else does', () => {
    const composedIds = catalogue.list().map((persona) => persona.id);
    expect(composedIds).toEqual(AI_PERSONA_CATALOGUE.map((entry) => entry.id));
  });

  it('every specialty bundle names only registered tools', () => {
    for (const specialty of Object.values(SPECIALTIES)) {
      for (const toolName of specialty.toolNames) {
        expect(
          catalogue.list().some((persona) => persona.defaultToolNames.includes(toolName)),
        ).toBe(true);
      }
    }
  });

  it('farm specialists are capped at confirm_required and carry their farm bundle per tier', () => {
    const operatorOps = catalogue.resolve('operator-farm-operations-v1');
    expect(operatorOps.actuationPolicy).toBe('confirm_required');
    expect(operatorOps.defaultToolNames[0]).toBe('get_farm_tanks');
    expect(operatorOps.defaultToolNames.at(-1)).toBe('create_task');
    expect(operatorOps.defaultToolNames).toEqual(
      expect.arrayContaining([
        'list_todays_tasks',
        'list_overdue_work_orders',
        'get_farm_stock_inventory',
      ]),
    );
    const operatorWater = catalogue.resolve('operator-farm-water-health-v1');
    expect(operatorWater.defaultToolNames).not.toContain('calculate_reagent_dosing');
    const expertWater = catalogue.resolve('expert-farm-water-health-v1');
    expect(expertWater.defaultToolNames).toContain('calculate_reagent_dosing');
    expect(expertWater.requiredCapabilities).toEqual(['ai_personas:expert', 'ai_specialties:farm']);
  });
});
