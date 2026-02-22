import 'reflect-metadata';
import { ToolMetadata } from './tool.interface';

const TOOL_METADATA_KEY = Symbol('tool:metadata');

/**
 * @Tool() decorator - marks a class as an AI tool with metadata.
 *
 * Usage:
 * @Tool({
 *   name: 'calculate_ammonia_toxicity',
 *   description: 'Calculate NH3 toxicity from TAN, pH, temperature and salinity',
 *   category: 'water_chemistry',
 *   runtime: 'both',
 *   requiredPermissions: ['operator', 'manager', 'expert'],
 *   inputSchema: { ... },
 *   requiresModule: null,
 *   requiresConfirmation: false,
 * })
 * export class CalculateAmmoniaToxicityTool extends BaseTool<Input, Output> { ... }
 */
export function Tool(metadata: ToolMetadata): ClassDecorator {
  return (target: Function) => {
    Reflect.defineMetadata(TOOL_METADATA_KEY, metadata, target);
  };
}

/** Helper to retrieve tool metadata from a decorated class */
export function getToolMetadata(target: Function): ToolMetadata | undefined {
  return Reflect.getMetadata(TOOL_METADATA_KEY, target);
}

export { TOOL_METADATA_KEY };
