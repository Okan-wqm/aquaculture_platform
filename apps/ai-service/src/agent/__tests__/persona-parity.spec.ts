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
import { ToolExecutionAudit } from '../../audit/tool-execution-audit.entity';
import { SPECIALTIES } from '../personas';

const AUDIT_REPO_STUB = { create: jest.fn(), save: jest.fn(), find: jest.fn() };

/**
 * The four pre-composition personas, frozen exactly as they were shipped
 * (agent/personas/{operator,manager,expert,supervisor}.ts before the tier ×
 * specialty refactor). The composition must reproduce them field for field.
 */
const LEGACY_PERSONAS = Object.freeze({
  'operator-v1': {
    id: 'operator-v1',
    name: 'Operator',
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
    name: 'Manager',
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
    name: 'Expert',
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
    name: 'Supervisor',
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

  it.each(Object.keys(LEGACY_PERSONAS))('%s keeps its shipped system prompt', (id) => {
    expect(catalogue.resolve(id).systemPrompt).toMatchSnapshot();
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
    expect(operatorOps.defaultToolNames).toEqual(['get_farm_tanks', 'create_task']);
    const operatorWater = catalogue.resolve('operator-farm-water-health-v1');
    expect(operatorWater.defaultToolNames).not.toContain('calculate_reagent_dosing');
    const expertWater = catalogue.resolve('expert-farm-water-health-v1');
    expect(expertWater.defaultToolNames).toContain('calculate_reagent_dosing');
    expect(expertWater.requiredCapabilities).toEqual(['ai_personas:expert', 'ai_specialties:farm']);
  });
});
