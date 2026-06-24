import type { NodeTypes } from '@xyflow/react';

import {
  NodeTypeConfig,
  ResolvedNodeTypeConfig,
  NodeCategory,
  PaletteItem,
  PaletteGroup,
  CATEGORY_ORDER,
  CATEGORY_LABELS,
} from '../nodes/types';

const DEFAULT_NODE_SIZE = { width: 150, height: 100 } as const;
const DEFAULT_MIN_NODE_SIZE = { width: 100, height: 75 } as const;

/**
 * NodeRegistry - Single Source of Truth for Node Types
 *
 * All nodes must be registered here. The palette is automatically
 * generated from this registry. When you add a new node, simply
 * call NodeRegistry.register() and it will appear in the palette.
 *
 * @example
 * ```typescript
 * import { NodeRegistry } from '@aquaculture/node-components';
 * import MyNewNode from './MyNewNode';
 *
 * NodeRegistry.register({
 *   id: 'myNewNode',
 *   label: 'My New Node',
 *   labelTr: 'Yeni Node',
 *   category: 'pump',
 *   component: MyNewNode,
 * });
 * ```
 */

// Internal registry storage (defaults already resolved)
const registry: Map<string, ResolvedNodeTypeConfig> = new Map();

// Equipment type code to node type mapping
const equipmentTypeMap: Map<string, string> = new Map();

/**
 * Diagnostic warning sink for non-fatal registry conditions (e.g. a node id
 * being re-registered). A shared client-side library must not assume the host
 * wants console output, so warnings are routed through an injectable handler.
 * The default is a no-op; consumers opt into surfacing diagnostics via
 * {@link NodeRegistry.setWarnHandler} (e.g. wiring it to their own logger).
 */
type WarnHandler = (message: string) => void;

const noopWarnHandler: WarnHandler = () => {
  /* diagnostics disabled until a host installs a handler */
};

let warnHandler: WarnHandler = noopWarnHandler;

export const NodeRegistry = {
  /**
   * Install a diagnostic warning handler. Pass `undefined` to reset to the
   * default no-op sink. Lets a host route registry warnings to its own logger
   * without the library hard-coding a console dependency.
   */
  setWarnHandler(handler: WarnHandler | undefined): void {
    warnHandler = handler ?? noopWarnHandler;
  },

  /**
   * Register a new node type
   */
  register(config: NodeTypeConfig): void {
    // Validate required fields
    if (!config.id || !config.component) {
      throw new Error(`NodeRegistry: id and component are required. Got id=${config.id}`);
    }

    // Warn if overwriting
    if (registry.has(config.id)) {
      warnHandler(`NodeRegistry: Overwriting existing node type "${config.id}"`);
    }

    // Apply defaults. Coalesce explicit `undefined` from the caller to the
    // library defaults so the stored config structurally guarantees size info.
    const fullConfig: ResolvedNodeTypeConfig = {
      ...config,
      defaultSize: config.defaultSize ?? DEFAULT_NODE_SIZE,
      minSize: config.minSize ?? DEFAULT_MIN_NODE_SIZE,
      hideFromPalette: config.hideFromPalette ?? false,
    };

    registry.set(config.id, fullConfig);

    // Register equipment type mappings
    if (config.equipmentTypeCodes) {
      config.equipmentTypeCodes.forEach((code) => {
        equipmentTypeMap.set(code.toLowerCase(), config.id);
      });
    }
  },

  /**
   * Get a node type config by id (with registry defaults resolved)
   */
  get(id: string): ResolvedNodeTypeConfig | undefined {
    return registry.get(id);
  },

  /**
   * Get all registered node types (with registry defaults resolved)
   */
  getAll(): ResolvedNodeTypeConfig[] {
    return Array.from(registry.values());
  },

  /**
   * Get node types by category
   */
  getByCategory(category: NodeCategory): ResolvedNodeTypeConfig[] {
    return this.getAll().filter((n) => n.category === category);
  },

  /**
   * Get nodes visible in palette (excluding hideFromPalette=true)
   */
  getPaletteNodes(): ResolvedNodeTypeConfig[] {
    return this.getAll().filter((n) => !n.hideFromPalette);
  },

  /**
   * Get nodeTypes object for ReactFlow
   * Returns the ReactFlow nodeTypes map (xyflow v12 NodeTypes).
   */
  getNodeTypes(): NodeTypes {
    const types: NodeTypes = {};
    registry.forEach((config, id) => {
      types[id] = config.component;
    });
    return types;
  },

  /**
   * Get node type id from equipment type code
   */
  getNodeTypeForEquipment(equipmentTypeCode: string): string | undefined {
    return equipmentTypeMap.get(equipmentTypeCode.toLowerCase());
  },

  /**
   * Get palette items (simplified for UI rendering)
   */
  getPaletteItems(): PaletteItem[] {
    return this.getPaletteNodes().map((config) => ({
      id: config.id,
      label: config.label,
      labelTr: config.labelTr,
      category: config.category,
      description: config.description,
      icon: config.icon,
      defaultSize: config.defaultSize,
    }));
  },

  /**
   * Get palette grouped by category (sorted by CATEGORY_ORDER)
   */
  getPaletteGroups(): PaletteGroup[] {
    const items = this.getPaletteItems();

    // Group by category
    const groups: Map<NodeCategory, PaletteItem[]> = new Map();
    items.forEach((item) => {
      const existing = groups.get(item.category) || [];
      existing.push(item);
      groups.set(item.category, existing);
    });

    // Convert to array and sort by CATEGORY_ORDER
    const result: PaletteGroup[] = [];
    groups.forEach((groupItems, category) => {
      const labels = CATEGORY_LABELS[category];
      result.push({
        category,
        labelEn: labels.en,
        labelTr: labels.tr,
        order: CATEGORY_ORDER[category],
        items: groupItems.sort((a, b) => a.label.localeCompare(b.label)),
      });
    });

    return result.sort((a, b) => a.order - b.order);
  },

  /**
   * Check if a node type is registered
   */
  has(id: string): boolean {
    return registry.has(id);
  },

  /**
   * Get count of registered nodes
   */
  count(): number {
    return registry.size;
  },

  /**
   * Clear all registrations (useful for testing)
   */
  clear(): void {
    registry.clear();
    equipmentTypeMap.clear();
  },
};

// Export types
export type { NodeTypeConfig, ResolvedNodeTypeConfig, NodeCategory, PaletteItem, PaletteGroup };
