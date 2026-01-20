/**
 * @aquaculture/node-components
 *
 * Shared ReactFlow node components for the aquaculture platform.
 *
 * Usage:
 * ```typescript
 * import { nodeTypes, NodeRegistry, createScadaNode } from '@aquaculture/node-components';
 *
 * // Use nodeTypes directly in ReactFlow
 * <ReactFlow nodeTypes={nodeTypes} ... />
 *
 * // Or get SCADA-wrapped versions
 * import { createScadaNodeTypes } from '@aquaculture/node-components';
 * const scadaNodeTypes = createScadaNodeTypes(nodeTypes);
 * ```
 */

// Export all nodes and registry
export * from './nodes';

// Export all edges
export * from './edges';

// Export wrappers
export * from './wrappers';

// Export utilities
export * from './utils';

// Export config
export * from './config';

// Export registry directly
export { NodeRegistry } from './registry/NodeRegistry';
export type { NodeTypeConfig, NodeCategory, PaletteItem, PaletteGroup } from './registry/NodeRegistry';
