import 'reflect-metadata';
import { ToolMetadata } from './tool.interface';

const TOOL_METADATA_KEY = Symbol('tool:metadata');

/**
 * Decorator / lookup target: the class constructor metadata is keyed off.
 *
 * `reflect-metadata` stores entries against the constructor object, so the
 * precise type is `object` — a class constructor is an object, and a class
 * instance's `.constructor` (the value `getToolMetadata()` is called with)
 * is assignable to it. This replaces the over-broad `Function` type (which
 * also accepts plain functions and forced unsafe metadata reads) while
 * staying assignable from both `@Tool()`'s class target and `this.constructor`.
 */
type ToolTarget = object;

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
export function Tool(metadata: ToolMetadata): (target: ToolTarget) => void {
  return (target: ToolTarget): void => {
    Reflect.defineMetadata(TOOL_METADATA_KEY, metadata, target);
  };
}

/** Helper to retrieve tool metadata from a decorated class */
export function getToolMetadata(target: ToolTarget): ToolMetadata | undefined {
  return Reflect.getMetadata(TOOL_METADATA_KEY, target) as
    | ToolMetadata
    | undefined;
}

export { TOOL_METADATA_KEY };
