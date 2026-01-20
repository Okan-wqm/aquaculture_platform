/**
 * Equipment Type Definitions
 * Defines all equipment types, their sizes, and connection point configurations
 */

export type ConnectionPointPosition = 'top' | 'right' | 'bottom' | 'left';
export type ConnectionPointType = 'input' | 'output';

export interface ConnectionPointConfig {
  id: string;
  position: ConnectionPointPosition;
  defaultType: ConnectionPointType;
}

export interface EquipmentSize {
  width: number;
  height: number;
}

export interface EquipmentTypeConfig {
  code: string;
  name: string;
  nameTr: string;
  category: string;
  defaultSize: EquipmentSize;
  connectionPoints: ConnectionPointConfig[];
}

// Size presets
export const SIZES = {
  SMALL: { width: 120, height: 100 },
  MEDIUM: { width: 140, height: 120 },
  MEDIUM_LARGE: { width: 160, height: 140 },
  LARGE: { width: 180, height: 160 },
  EXTRA_LARGE: { width: 200, height: 180 },
  WIDE: { width: 200, height: 140 },
} as const;

// Default connection points (4 circular points)
const DEFAULT_CONNECTION_POINTS: ConnectionPointConfig[] = [
  { id: 'top', position: 'top', defaultType: 'input' },
  { id: 'right', position: 'right', defaultType: 'output' },
  { id: 'bottom', position: 'bottom', defaultType: 'output' },
  { id: 'left', position: 'left', defaultType: 'input' },
];

/**
 * Equipment Types Configuration
 */
export const EQUIPMENT_TYPES: Record<string, EquipmentTypeConfig> = {
  // Tank - Large
  'tank': {
    code: 'tank',
    name: 'Tank',
    nameTr: 'Tank',
    category: 'tank',
    defaultSize: SIZES.EXTRA_LARGE,
    connectionPoints: DEFAULT_CONNECTION_POINTS,
  },

  // Pump - Medium
  'pump': {
    code: 'pump',
    name: 'Pump',
    nameTr: 'Pompa',
    category: 'pump',
    defaultSize: SIZES.MEDIUM,
    connectionPoints: DEFAULT_CONNECTION_POINTS,
  },

  // Chiller - Medium Large
  'chiller': {
    code: 'chiller',
    name: 'Chiller',
    nameTr: 'Soğutucu',
    category: 'heating_cooling',
    defaultSize: SIZES.MEDIUM_LARGE,
    connectionPoints: DEFAULT_CONNECTION_POINTS,
  },

  // Heater - Medium Large
  'heater': {
    code: 'heater',
    name: 'Heater',
    nameTr: 'Isıtıcı',
    category: 'heating_cooling',
    defaultSize: SIZES.MEDIUM_LARGE,
    connectionPoints: DEFAULT_CONNECTION_POINTS,
  },

  // Root Blower - Medium Large
  'root-blower': {
    code: 'root-blower',
    name: 'Root Blower',
    nameTr: 'Root Blower',
    category: 'aeration',
    defaultSize: { width: 150, height: 130 },
    connectionPoints: DEFAULT_CONNECTION_POINTS,
  },

  // Fan - Small
  'fan': {
    code: 'fan',
    name: 'Fan',
    nameTr: 'Fan',
    category: 'aeration',
    defaultSize: SIZES.SMALL,
    connectionPoints: DEFAULT_CONNECTION_POINTS,
  },

  // Feeder - Medium
  'feeder': {
    code: 'feeder',
    name: 'Feeder',
    nameTr: 'Yemleme',
    category: 'feeding',
    defaultSize: SIZES.MEDIUM,
    connectionPoints: DEFAULT_CONNECTION_POINTS,
  },

  // Drum Filter - Large
  'drum-filter': {
    code: 'drum-filter',
    name: 'Drum Filter',
    nameTr: 'Drum Filtre',
    category: 'filtration',
    defaultSize: SIZES.LARGE,
    connectionPoints: DEFAULT_CONNECTION_POINTS,
  },

  // Sand Filter - Large
  'sand-filter': {
    code: 'sand-filter',
    name: 'Sand Filter',
    nameTr: 'Kum Filtre',
    category: 'filtration',
    defaultSize: SIZES.LARGE,
    connectionPoints: DEFAULT_CONNECTION_POINTS,
  },

  // Electric Generator - Medium Large
  'electric-generator': {
    code: 'electric-generator',
    name: 'Electric Generator',
    nameTr: 'Elektrik Jeneratörü',
    category: 'power',
    defaultSize: SIZES.MEDIUM_LARGE,
    connectionPoints: DEFAULT_CONNECTION_POINTS,
  },

  // Oxygen Generator - Medium Large
  'oxygen-generator': {
    code: 'oxygen-generator',
    name: 'Oxygen Generator',
    nameTr: 'Oksijen Jeneratörü',
    category: 'aeration',
    defaultSize: SIZES.MEDIUM_LARGE,
    connectionPoints: DEFAULT_CONNECTION_POINTS,
  },

  // Belt Filter - Wide
  'belt-filter': {
    code: 'belt-filter',
    name: 'Belt Filter',
    nameTr: 'Bant Filtre',
    category: 'filtration',
    defaultSize: SIZES.WIDE,
    connectionPoints: DEFAULT_CONNECTION_POINTS,
  },
};

/**
 * Get equipment type configuration by code
 */
export const getEquipmentTypeConfig = (code: string): EquipmentTypeConfig | undefined => {
  const normalizedCode = code.toLowerCase().replace(/_/g, '-');
  return EQUIPMENT_TYPES[normalizedCode];
};

/**
 * Get equipment size by code (returns default if not found)
 */
export const getEquipmentSize = (code: string): EquipmentSize => {
  const config = getEquipmentTypeConfig(code);
  return config?.defaultSize ?? SIZES.MEDIUM;
};

/**
 * Get all equipment types as array
 */
export const getAllEquipmentTypes = (): EquipmentTypeConfig[] => {
  return Object.values(EQUIPMENT_TYPES);
};

/**
 * Get equipment types by category
 */
export const getEquipmentTypesByCategory = (category: string): EquipmentTypeConfig[] => {
  return Object.values(EQUIPMENT_TYPES).filter(t => t.category === category);
};

/**
 * Equipment categories for grouping
 */
export const EQUIPMENT_CATEGORIES = {
  tank: { name: 'Tank', nameTr: 'Tank', order: 1 },
  pump: { name: 'Pump', nameTr: 'Pompa', order: 2 },
  filtration: { name: 'Filtration', nameTr: 'Filtrasyon', order: 3 },
  aeration: { name: 'Aeration', nameTr: 'Havalandırma', order: 4 },
  heating_cooling: { name: 'Heating/Cooling', nameTr: 'Isıtma/Soğutma', order: 5 },
  feeding: { name: 'Feeding', nameTr: 'Yemleme', order: 6 },
  power: { name: 'Power', nameTr: 'Güç', order: 7 },
} as const;
