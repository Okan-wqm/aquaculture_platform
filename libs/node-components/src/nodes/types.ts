import { ComponentType } from 'react';
import { NodeProps } from 'reactflow';

/**
 * Node category types for palette organization
 */
export type NodeCategory =
  | 'tank'
  | 'pump'
  | 'filtration'
  | 'aeration'
  | 'heating_cooling'
  | 'power'
  | 'feeding'
  | 'monitoring'
  | 'utility'
  | 'algae'
  | 'disinfection'
  | 'distribution'
  | 'water_treatment'
  | 'equipment';

/**
 * Category display order for palette
 */
export const CATEGORY_ORDER: Record<NodeCategory, number> = {
  tank: 1,
  pump: 2,
  filtration: 3,
  aeration: 4,
  heating_cooling: 5,
  disinfection: 6,
  water_treatment: 7,
  feeding: 8,
  power: 9,
  monitoring: 10,
  distribution: 11,
  utility: 12,
  algae: 13,
  equipment: 14,
};

/**
 * Category labels
 */
export const CATEGORY_LABELS: Record<NodeCategory, { en: string; tr: string }> = {
  tank: { en: 'Tanks', tr: 'Tanklar' },
  pump: { en: 'Pumps', tr: 'Pompalar' },
  filtration: { en: 'Filtration', tr: 'Filtrasyon' },
  aeration: { en: 'Aeration', tr: 'Havalandirma' },
  heating_cooling: { en: 'Heating/Cooling', tr: 'Isitma/Sogutma' },
  disinfection: { en: 'Disinfection', tr: 'Dezenfeksiyon' },
  water_treatment: { en: 'Water Treatment', tr: 'Su Aritma' },
  feeding: { en: 'Feeding', tr: 'Besleme' },
  power: { en: 'Power', tr: 'Guc' },
  monitoring: { en: 'Monitoring', tr: 'Izleme' },
  distribution: { en: 'Distribution', tr: 'Dagitim' },
  utility: { en: 'Utility', tr: 'Yardimci' },
  algae: { en: 'Algae', tr: 'Alg' },
  equipment: { en: 'Equipment', tr: 'Ekipman' },
};

/**
 * Configuration for a registered node type
 */
export interface NodeTypeConfig {
  /** Unique identifier (used as nodeTypes key) */
  id: string;
  /** Display label (English) */
  label: string;
  /** Display label (Turkish) */
  labelTr: string;
  /** Category for palette grouping */
  category: NodeCategory;
  /** Description for tooltip */
  description?: string;
  /** The React component */
  component: ComponentType<NodeProps>;
  /** Icon name or SVG (optional) */
  icon?: string;
  /** Default size when created */
  defaultSize?: { width: number; height: number };
  /** Minimum size for resizing */
  minSize?: { width: number; height: number };
  /** Hide from palette (for internal/abstract nodes) */
  hideFromPalette?: boolean;
  /** Equipment type codes that map to this node */
  equipmentTypeCodes?: string[];
}

/**
 * Node data interface (passed to components)
 */
export interface BaseNodeData {
  label?: string;
  status?: 'operational' | 'active' | 'maintenance' | 'out_of_service' | 'inactive';
  width?: number;
  height?: number;
  rotation?: number;
  equipmentId?: string;
  isScadaMode?: boolean;
  [key: string]: unknown;
}

/**
 * Palette item for UI rendering
 */
export interface PaletteItem {
  id: string;
  label: string;
  labelTr: string;
  category: NodeCategory;
  description?: string;
  icon?: string;
  defaultSize: { width: number; height: number };
}

/**
 * Palette group (category with items)
 */
export interface PaletteGroup {
  category: NodeCategory;
  labelEn: string;
  labelTr: string;
  order: number;
  items: PaletteItem[];
}
