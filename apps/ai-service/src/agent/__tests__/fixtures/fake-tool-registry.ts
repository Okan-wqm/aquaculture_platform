import type { AiPersonaTier, AiSpecialtyModule } from '@aquaculture/shared-contracts';
import type { ITool, ToolMetadata } from '../../../tools/core/tool.interface';
import type { ToolRegistryService } from '../../../tools/tool-registry.service';

const ALL_TIERS: readonly AiPersonaTier[] = ['operator', 'manager', 'expert', 'supervisor'];
const MANAGER_UP: readonly AiPersonaTier[] = ['manager', 'expert', 'supervisor'];

export interface FakeToolSpec {
  readonly name: string;
  readonly requiredPermissions?: readonly AiPersonaTier[];
  readonly requiresModule?: AiSpecialtyModule | null;
  readonly requiresConfirmation?: boolean;
}

/**
 * The registered tool set as the composition sees it (names, tiers, module,
 * confirmation). Mirrors the real @Tool metadata of every tool module so the
 * London-school persona specs compose against the same facts the app boots
 * with; the parity spec composes the REAL modules and pins the same shape.
 */
export const REGISTERED_TOOLS: readonly FakeToolSpec[] = [
  { name: 'calculate_ammonia_toxicity' },
  { name: 'calculate_h2s_toxicity' },
  { name: 'calculate_co2_level' },
  { name: 'calculate_carbonate_chemistry' },
  { name: 'calculate_reagent_dosing', requiredPermissions: MANAGER_UP },
  { name: 'get_reagent_list' },
  { name: 'simulate_dosing_effect', requiredPermissions: MANAGER_UP },
  { name: 'analyze_sensor_data' },
  { name: 'suggest_sensor_channels' },
  { name: 'get_farm_tanks' },
  { name: 'get_farm_batches' },
  { name: 'get_farm_water_quality' },
  { name: 'get_farm_harvest' },
  { name: 'get_farm_feeding' },
  { name: 'create_task', requiresConfirmation: true },
];

function toMetadata(spec: FakeToolSpec): ToolMetadata {
  return {
    name: spec.name,
    description: `fake ${spec.name}`,
    category: 'farm_query',
    runtime: 'cloud',
    requiredPermissions: spec.requiredPermissions ?? ALL_TIERS,
    inputSchema: { type: 'object', properties: {} },
    requiresModule: spec.requiresModule ?? null,
    requiresConfirmation: spec.requiresConfirmation ?? false,
  };
}

/** A registry double exposing exactly what persona composition reads. */
export function fakeToolRegistry(
  tools: readonly FakeToolSpec[] = REGISTERED_TOOLS,
): Pick<ToolRegistryService, 'hasTool' | 'getTool'> {
  const byName = new Map<string, ITool>(
    tools.map((spec) => {
      const metadata = toMetadata(spec);
      const tool: ITool = {
        getMetadata: () => metadata,
        validate: async () => ({ valid: true }),
        execute: async () => ({ success: true, data: undefined, durationMs: 0, cacheable: false }),
      };
      return [spec.name, tool];
    }),
  );
  return {
    hasTool: (name: string) => byName.has(name),
    getTool: (name: string) => byName.get(name),
  };
}
