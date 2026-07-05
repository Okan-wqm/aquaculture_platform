import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { ToolRegistryModule } from '../tool-registry.module';
import { ToolRegistryService } from '../tool-registry.service';
import { WaterChemistryToolsModule } from '../water-chemistry/water-chemistry-tools.module';
import { SensorConfigToolsModule } from '../sensor-config/sensor-config-tools.module';

/**
 * FAZ0-BOOT-01 regression guard.
 *
 * WHY this spec exists: the previous TOOL_PROVIDERS "multi-provider" wiring
 * relied on Angular semantics NestJS does not have, so the registry ALWAYS
 * initialized with zero tools in a fully composed application — the agent had
 * an empty tool belt in every environment, silently. This spec composes the
 * registry with the real tool feature modules (no mocks) and proves discovery
 * finds every @Tool()-decorated provider.
 */
describe('ToolRegistryService discovery (FAZ0-BOOT-01)', () => {
  const EXPECTED_TOOL_NAMES = [
    // water-chemistry
    'calculate_ammonia_toxicity',
    'calculate_h2s_toxicity',
    'calculate_co2_level',
    'calculate_carbonate_chemistry',
    'calculate_reagent_dosing',
    'get_reagent_list',
    'simulate_dosing_effect',
    // sensor-config
    'analyze_sensor_data',
    'suggest_sensor_channels',
  ];

  it('registers every @Tool()-decorated provider from the feature modules', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ToolRegistryModule,
        WaterChemistryToolsModule,
        SensorConfigToolsModule,
      ],
    }).compile();

    // onModuleInit (where discovery runs) fires on init, not on compile.
    await moduleRef.init();

    const registry = moduleRef.get(ToolRegistryService);

    for (const name of EXPECTED_TOOL_NAMES) {
      expect(registry.hasTool(name)).toBe(true);
    }
    expect(registry.size).toBe(EXPECTED_TOOL_NAMES.length);

    await moduleRef.close();
  });

  it('exposes Claude tool definitions for the discovered tools (agent-facing contract)', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ToolRegistryModule,
        WaterChemistryToolsModule,
        SensorConfigToolsModule,
      ],
    }).compile();
    await moduleRef.init();

    const registry = moduleRef.get(ToolRegistryService);
    const definitions = registry.getClaudeToolDefinitions(EXPECTED_TOOL_NAMES);

    expect(definitions).toHaveLength(EXPECTED_TOOL_NAMES.length);
    for (const definition of definitions) {
      // Claude rejects tools without a JSON input schema — an empty schema on
      // the wire is the same production failure as a missing tool.
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.input_schema).toBeDefined();
    }

    await moduleRef.close();
  });

  it('registry without any tool module yields an empty-but-bootable registry', async () => {
    // Boot must not depend on tool modules being present (e.g. stripped-down
    // test harnesses) — discovery of zero tools is valid, crashing is not.
    const moduleRef = await Test.createTestingModule({
      imports: [ToolRegistryModule],
    }).compile();
    await moduleRef.init();

    const registry = moduleRef.get(ToolRegistryService);
    expect(registry.size).toBe(0);

    await moduleRef.close();
  });
});
