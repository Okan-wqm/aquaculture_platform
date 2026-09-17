/**
 * Equipment Types Seed Data
 * Sistem tanımlı ekipman tipleri ve specification şemaları
 *
 * Kategori yapısı: Frontend'de iki aşamalı seçim için tasarlandı
 * 1. Kategori seçimi (TANK, PUMP, FILTRATION, etc.)
 * 2. Alt tip seçimi (tank-circular, pump-centrifugal, etc.)
 */
import { EquipmentCategory, SpecificationSchema } from '../entities/equipment-type.entity';

export interface EquipmentTypeSeed {
  name: string;
  code: string;
  description: string;
  category: EquipmentCategory;
  icon: string;
  specificationSchema: SpecificationSchema;
  allowedSubEquipmentTypes: string[];
  sortOrder: number;
}

export const EQUIPMENT_TYPES_SEED: EquipmentTypeSeed[] = [
  // ============================================
  // TANK Category - Tank tipleri
  // ============================================
  {
    name: 'Circular Tank',
    code: 'tank-circular',
    description: 'Dairesel balık yetiştirme tankı',
    category: EquipmentCategory.TANK,
    icon: 'tank',
    sortOrder: 1,
    allowedSubEquipmentTypes: ['inlet', 'outlet', 'drain', 'feed-drop-point', 'fish-trap', 'aerator', 'sensor-probe'],
    specificationSchema: {
      groups: [
        { name: 'dimensions', label: 'Dimensions', description: 'Tank dimensions' },
        { name: 'material', label: 'Material & Shape', description: 'Tank material properties' },
      ],
      fields: [
        { name: 'volume', label: 'Volume', type: 'number', unit: 'm³', required: true, group: 'dimensions', min: 0.1 },
        { name: 'depth', label: 'Depth', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'diameter', label: 'Diameter', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'material', label: 'Material', type: 'select', required: true, group: 'material', options: [
          { value: 'fiberglass', label: 'Fiberglass' },
          { value: 'concrete', label: 'Concrete' },
          { value: 'steel', label: 'Steel' },
          { value: 'hdpe', label: 'HDPE' },
          { value: 'plastic', label: 'Plastic' },
        ]},
        { name: 'shape', label: 'Shape', type: 'select', group: 'material', options: [
          { value: 'circular', label: 'Circular' },
          { value: 'rectangular', label: 'Rectangular' },
          { value: 'square', label: 'Square' },
          { value: 'oval', label: 'Oval' },
        ]},
      ],
    },
  },
  {
    name: 'Rectangular Tank',
    code: 'tank-rectangular',
    description: 'Dikdörtgen balık yetiştirme tankı',
    category: EquipmentCategory.TANK,
    icon: 'tank',
    sortOrder: 2,
    allowedSubEquipmentTypes: ['inlet', 'outlet', 'drain', 'feed-drop-point', 'fish-trap', 'aerator', 'sensor-probe'],
    specificationSchema: {
      groups: [
        { name: 'dimensions', label: 'Dimensions', description: 'Tank dimensions' },
        { name: 'material', label: 'Material & Shape', description: 'Tank material properties' },
      ],
      fields: [
        { name: 'volume', label: 'Volume', type: 'number', unit: 'm³', required: true, group: 'dimensions', min: 0.1 },
        { name: 'depth', label: 'Depth', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'length', label: 'Length', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'width', label: 'Width', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'material', label: 'Material', type: 'select', required: true, group: 'material', options: [
          { value: 'fiberglass', label: 'Fiberglass' },
          { value: 'concrete', label: 'Concrete' },
          { value: 'steel', label: 'Steel' },
          { value: 'hdpe', label: 'HDPE' },
          { value: 'plastic', label: 'Plastic' },
        ]},
        { name: 'shape', label: 'Shape', type: 'select', group: 'material', options: [
          { value: 'circular', label: 'Circular' },
          { value: 'rectangular', label: 'Rectangular' },
          { value: 'square', label: 'Square' },
          { value: 'oval', label: 'Oval' },
        ]},
      ],
    },
  },
  {
    name: 'Raceway',
    code: 'tank-raceway',
    description: 'Akarsu tipi yetiştirme kanalı',
    category: EquipmentCategory.TANK,
    icon: 'raceway',
    sortOrder: 3,
    allowedSubEquipmentTypes: ['inlet', 'outlet', 'drain', 'feed-drop-point', 'fish-trap', 'aerator', 'screen'],
    specificationSchema: {
      groups: [
        { name: 'dimensions', label: 'Dimensions', description: 'Tank dimensions' },
        { name: 'material', label: 'Material & Shape', description: 'Tank material properties' },
      ],
      fields: [
        { name: 'volume', label: 'Volume', type: 'number', unit: 'm³', required: true, group: 'dimensions', min: 0.1 },
        { name: 'depth', label: 'Depth', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'length', label: 'Length', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'width', label: 'Width', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'material', label: 'Material', type: 'select', required: true, group: 'material', options: [
          { value: 'fiberglass', label: 'Fiberglass' },
          { value: 'concrete', label: 'Concrete' },
          { value: 'steel', label: 'Steel' },
          { value: 'hdpe', label: 'HDPE' },
          { value: 'plastic', label: 'Plastic' },
        ]},
        { name: 'shape', label: 'Shape', type: 'select', group: 'material', options: [
          { value: 'circular', label: 'Circular' },
          { value: 'rectangular', label: 'Rectangular' },
          { value: 'square', label: 'Square' },
          { value: 'oval', label: 'Oval' },
        ]},
      ],
    },
  },
  {
    name: 'D-End Raceway',
    code: 'tank-d-end',
    description: 'D-uçlu raceway tank (yarı dairesel uçlar)',
    category: EquipmentCategory.TANK,
    icon: 'raceway',
    sortOrder: 4,
    allowedSubEquipmentTypes: ['inlet', 'outlet', 'drain', 'feed-drop-point', 'fish-trap', 'aerator', 'screen'],
    specificationSchema: {
      groups: [
        { name: 'dimensions', label: 'Dimensions', description: 'Tank dimensions' },
        { name: 'material', label: 'Material & Shape', description: 'Tank material properties' },
      ],
      fields: [
        { name: 'volume', label: 'Volume', type: 'number', unit: 'm³', required: true, group: 'dimensions', min: 0.1 },
        { name: 'depth', label: 'Depth', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'length', label: 'Length', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'width', label: 'Width', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'material', label: 'Material', type: 'select', required: true, group: 'material', options: [
          { value: 'fiberglass', label: 'Fiberglass' },
          { value: 'concrete', label: 'Concrete' },
          { value: 'steel', label: 'Steel' },
          { value: 'hdpe', label: 'HDPE' },
        ]},
      ],
    },
  },
  {
    name: 'Oval Tank',
    code: 'tank-oval',
    description: 'Oval balık yetiştirme tankı',
    category: EquipmentCategory.TANK,
    icon: 'tank',
    sortOrder: 5,
    allowedSubEquipmentTypes: ['inlet', 'outlet', 'drain', 'feed-drop-point', 'fish-trap', 'aerator', 'sensor-probe'],
    specificationSchema: {
      groups: [
        { name: 'dimensions', label: 'Dimensions', description: 'Tank dimensions' },
        { name: 'material', label: 'Material', description: 'Tank material properties' },
      ],
      fields: [
        { name: 'volume', label: 'Volume', type: 'number', unit: 'm³', required: true, group: 'dimensions', min: 0.1 },
        { name: 'depth', label: 'Depth', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'diameter', label: 'Diameter (major axis)', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'material', label: 'Material', type: 'select', required: true, group: 'material', options: [
          { value: 'fiberglass', label: 'Fiberglass' },
          { value: 'concrete', label: 'Concrete' },
          { value: 'steel', label: 'Steel' },
          { value: 'hdpe', label: 'HDPE' },
        ]},
      ],
    },
  },
  {
    name: 'Square Tank',
    code: 'tank-square',
    description: 'Kare balık yetiştirme tankı',
    category: EquipmentCategory.TANK,
    icon: 'tank',
    sortOrder: 6,
    allowedSubEquipmentTypes: ['inlet', 'outlet', 'drain', 'feed-drop-point', 'fish-trap', 'aerator', 'sensor-probe'],
    specificationSchema: {
      groups: [
        { name: 'dimensions', label: 'Dimensions', description: 'Tank dimensions' },
        { name: 'material', label: 'Material', description: 'Tank material properties' },
      ],
      fields: [
        { name: 'volume', label: 'Volume', type: 'number', unit: 'm³', required: true, group: 'dimensions', min: 0.1 },
        { name: 'depth', label: 'Depth', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'length', label: 'Side Length', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'width', label: 'Side Width', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'material', label: 'Material', type: 'select', required: true, group: 'material', options: [
          { value: 'fiberglass', label: 'Fiberglass' },
          { value: 'concrete', label: 'Concrete' },
          { value: 'steel', label: 'Steel' },
          { value: 'hdpe', label: 'HDPE' },
        ]},
      ],
    },
  },
  {
    name: 'Tank (Generic)',
    code: 'tank-generic',
    description: 'Genel amaçlı balık yetiştirme tankı - diğer kategorilere uymayan tipler için',
    category: EquipmentCategory.TANK,
    icon: 'tank',
    sortOrder: 7,
    allowedSubEquipmentTypes: ['inlet', 'outlet', 'drain', 'feed-drop-point', 'fish-trap', 'aerator', 'sensor-probe'],
    specificationSchema: {
      groups: [
        { name: 'dimensions', label: 'Dimensions', description: 'Tank dimensions' },
        { name: 'material', label: 'Material', description: 'Tank material properties' },
      ],
      fields: [
        { name: 'volume', label: 'Volume', type: 'number', unit: 'm³', required: true, group: 'dimensions', min: 0.1 },
        { name: 'depth', label: 'Depth', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'customShape', label: 'Custom Shape Description', type: 'text', group: 'dimensions' },
        { name: 'material', label: 'Material', type: 'select', required: true, group: 'material', options: [
          { value: 'fiberglass', label: 'Fiberglass' },
          { value: 'concrete', label: 'Concrete' },
          { value: 'steel', label: 'Steel' },
          { value: 'hdpe', label: 'HDPE' },
          { value: 'other', label: 'Other' },
        ]},
      ],
    },
  },

  // ============================================
  // POND Category - Havuz tipleri
  // ============================================
  {
    name: 'Earthen Pond',
    code: 'pond-earthen',
    description: 'Toprak havuz - geleneksel balık yetiştirme havuzu',
    category: EquipmentCategory.POND,
    icon: 'pond',
    sortOrder: 8,
    allowedSubEquipmentTypes: ['inlet', 'outlet', 'drain', 'feed-drop-point', 'aerator', 'screen'],
    specificationSchema: {
      groups: [
        { name: 'dimensions', label: 'Dimensions', description: 'Pond dimensions' },
        { name: 'features', label: 'Features', description: 'Pond features' },
      ],
      fields: [
        { name: 'surfaceArea', label: 'Surface Area', type: 'number', unit: 'm²', required: true, group: 'dimensions', min: 1 },
        { name: 'volume', label: 'Volume', type: 'number', unit: 'm³', required: true, group: 'dimensions', min: 0.1 },
        { name: 'depth', label: 'Average Depth', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'maxDepth', label: 'Maximum Depth', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'linerType', label: 'Liner Type', type: 'select', group: 'features', options: [
          { value: 'none', label: 'None (Natural)' },
          { value: 'clay', label: 'Clay Lining' },
          { value: 'hdpe', label: 'HDPE Liner' },
          { value: 'pvc', label: 'PVC Liner' },
          { value: 'concrete', label: 'Concrete Lining' },
        ]},
        { name: 'waterSource', label: 'Water Source', type: 'select', group: 'features', options: [
          { value: 'well', label: 'Well' },
          { value: 'river', label: 'River' },
          { value: 'reservoir', label: 'Reservoir' },
          { value: 'rain', label: 'Rainwater' },
          { value: 'mixed', label: 'Mixed' },
        ]},
      ],
    },
  },
  {
    name: 'Lined Pond',
    code: 'pond-lined',
    description: 'Kaplama havuz - liner veya beton kaplı',
    category: EquipmentCategory.POND,
    icon: 'pond',
    sortOrder: 9,
    allowedSubEquipmentTypes: ['inlet', 'outlet', 'drain', 'feed-drop-point', 'aerator', 'screen'],
    specificationSchema: {
      groups: [
        { name: 'dimensions', label: 'Dimensions', description: 'Pond dimensions' },
        { name: 'features', label: 'Features', description: 'Pond features' },
      ],
      fields: [
        { name: 'surfaceArea', label: 'Surface Area', type: 'number', unit: 'm²', required: true, group: 'dimensions', min: 1 },
        { name: 'volume', label: 'Volume', type: 'number', unit: 'm³', required: true, group: 'dimensions', min: 0.1 },
        { name: 'depth', label: 'Average Depth', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'linerType', label: 'Liner Type', type: 'select', required: true, group: 'features', options: [
          { value: 'hdpe', label: 'HDPE Liner' },
          { value: 'pvc', label: 'PVC Liner' },
          { value: 'epdm', label: 'EPDM Liner' },
          { value: 'concrete', label: 'Concrete' },
        ]},
        { name: 'linerThickness', label: 'Liner Thickness', type: 'number', unit: 'mm', group: 'features' },
      ],
    },
  },
  {
    name: 'Pond (Generic)',
    code: 'pond-generic',
    description: 'Genel havuz - diğer kategorilere uymayan havuzlar için',
    category: EquipmentCategory.POND,
    icon: 'pond',
    sortOrder: 10,
    allowedSubEquipmentTypes: ['inlet', 'outlet', 'drain', 'feed-drop-point', 'aerator', 'screen'],
    specificationSchema: {
      groups: [
        { name: 'dimensions', label: 'Dimensions', description: 'Pond dimensions' },
      ],
      fields: [
        { name: 'surfaceArea', label: 'Surface Area', type: 'number', unit: 'm²', required: true, group: 'dimensions', min: 1 },
        { name: 'volume', label: 'Volume', type: 'number', unit: 'm³', required: true, group: 'dimensions', min: 0.1 },
        { name: 'depth', label: 'Average Depth', type: 'number', unit: 'm', group: 'dimensions' },
      ],
    },
  },

  // ============================================
  // CAGE Category - Kafes tipleri
  // ============================================
  {
    name: 'Floating Cage',
    code: 'cage-floating',
    description: 'Yüzer kafes - deniz balıkçılığı için',
    category: EquipmentCategory.CAGE,
    icon: 'cage',
    sortOrder: 11,
    allowedSubEquipmentTypes: ['net', 'mooring', 'feed-drop-point', 'sensor-probe', 'camera'],
    specificationSchema: {
      groups: [
        { name: 'dimensions', label: 'Dimensions', description: 'Cage dimensions' },
        { name: 'structure', label: 'Structure', description: 'Cage structure' },
      ],
      fields: [
        { name: 'volume', label: 'Volume', type: 'number', unit: 'm³', required: true, group: 'dimensions', min: 1 },
        { name: 'diameter', label: 'Diameter', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'circumference', label: 'Circumference', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'depth', label: 'Net Depth', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'frameType', label: 'Frame Type', type: 'select', group: 'structure', options: [
          { value: 'hdpe', label: 'HDPE' },
          { value: 'steel', label: 'Steel' },
          { value: 'galvanized', label: 'Galvanized Steel' },
        ]},
        { name: 'netMaterial', label: 'Net Material', type: 'select', group: 'structure', options: [
          { value: 'nylon', label: 'Nylon' },
          { value: 'polyethylene', label: 'Polyethylene' },
          { value: 'copper_alloy', label: 'Copper Alloy' },
        ]},
        { name: 'meshSize', label: 'Mesh Size', type: 'number', unit: 'mm', group: 'structure' },
      ],
    },
  },
  {
    name: 'Submersible Cage',
    code: 'cage-submersible',
    description: 'Batırılabilir kafes - derin su balıkçılığı için',
    category: EquipmentCategory.CAGE,
    icon: 'cage',
    sortOrder: 12,
    allowedSubEquipmentTypes: ['net', 'mooring', 'feed-drop-point', 'sensor-probe', 'camera', 'ballast-system'],
    specificationSchema: {
      groups: [
        { name: 'dimensions', label: 'Dimensions', description: 'Cage dimensions' },
        { name: 'structure', label: 'Structure', description: 'Cage structure' },
      ],
      fields: [
        { name: 'volume', label: 'Volume', type: 'number', unit: 'm³', required: true, group: 'dimensions', min: 1 },
        { name: 'diameter', label: 'Diameter', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'depth', label: 'Net Depth', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'maxSubmersionDepth', label: 'Max Submersion Depth', type: 'number', unit: 'm', group: 'dimensions' },
        { name: 'frameType', label: 'Frame Type', type: 'select', group: 'structure', options: [
          { value: 'hdpe', label: 'HDPE' },
          { value: 'steel', label: 'Steel' },
        ]},
        { name: 'netMaterial', label: 'Net Material', type: 'select', group: 'structure', options: [
          { value: 'nylon', label: 'Nylon' },
          { value: 'polyethylene', label: 'Polyethylene' },
          { value: 'copper_alloy', label: 'Copper Alloy' },
        ]},
      ],
    },
  },
  {
    name: 'Cage (Generic)',
    code: 'cage-generic',
    description: 'Genel kafes - diğer kategorilere uymayan kafesler için',
    category: EquipmentCategory.CAGE,
    icon: 'cage',
    sortOrder: 13,
    allowedSubEquipmentTypes: ['net', 'mooring', 'feed-drop-point', 'sensor-probe'],
    specificationSchema: {
      groups: [
        { name: 'dimensions', label: 'Dimensions', description: 'Cage dimensions' },
      ],
      fields: [
        { name: 'volume', label: 'Volume', type: 'number', unit: 'm³', required: true, group: 'dimensions', min: 1 },
        { name: 'depth', label: 'Net Depth', type: 'number', unit: 'm', group: 'dimensions' },
      ],
    },
  },

  // ============================================
  // PUMP Category - Pompa tipleri
  // ============================================
  {
    name: 'Centrifugal Pump',
    code: 'pump-centrifugal',
    description: 'Santrifüj su pompası',
    category: EquipmentCategory.PUMP,
    icon: 'pump',
    sortOrder: 14,
    allowedSubEquipmentTypes: ['inlet-valve', 'outlet-valve', 'pressure-gauge', 'flowmeter'],
    specificationSchema: {
      groups: [
        { name: 'performance', label: 'Performance', description: 'Pump performance values' },
        { name: 'electrical', label: 'Electrical', description: 'Electrical specifications' },
      ],
      fields: [
        { name: 'flowRate', label: 'Flow Rate', type: 'number', unit: 'm³/h', required: true, group: 'performance' },
        { name: 'head', label: 'Head', type: 'number', unit: 'm', group: 'performance' },
        { name: 'power', label: 'Power', type: 'number', unit: 'kW', group: 'electrical' },
        { name: 'voltage', label: 'Voltage', type: 'number', unit: 'V', group: 'electrical' },
        { name: 'phase', label: 'Phase', type: 'select', group: 'electrical', options: [
          { value: 'single', label: 'Single Phase' },
          { value: 'three', label: 'Three Phase' },
        ]},
      ],
    },
  },
  {
    name: 'Submersible Pump',
    code: 'pump-submersible',
    description: 'Dalgıç pompa',
    category: EquipmentCategory.PUMP,
    icon: 'pump',
    sortOrder: 15,
    allowedSubEquipmentTypes: ['outlet-valve', 'pressure-gauge', 'flowmeter'],
    specificationSchema: {
      groups: [
        { name: 'performance', label: 'Performance', description: 'Pump performance values' },
        { name: 'electrical', label: 'Electrical', description: 'Electrical specifications' },
      ],
      fields: [
        { name: 'flowRate', label: 'Flow Rate', type: 'number', unit: 'm³/h', required: true, group: 'performance' },
        { name: 'head', label: 'Head', type: 'number', unit: 'm', group: 'performance' },
        { name: 'power', label: 'Power', type: 'number', unit: 'kW', group: 'electrical' },
        { name: 'voltage', label: 'Voltage', type: 'number', unit: 'V', group: 'electrical' },
        { name: 'phase', label: 'Phase', type: 'select', group: 'electrical', options: [
          { value: 'single', label: 'Single Phase' },
          { value: 'three', label: 'Three Phase' },
        ]},
      ],
    },
  },

  // ============================================
  // AERATION Category - Havalandırma ekipmanları
  // ============================================
  {
    name: 'Blower',
    code: 'blower',
    description: 'Hava üfleyici (blower)',
    category: EquipmentCategory.AERATION,
    icon: 'blower',
    sortOrder: 20,
    allowedSubEquipmentTypes: ['air-filter', 'silencer', 'pressure-gauge', 'check-valve'],
    specificationSchema: {
      fields: [
        { name: 'airflow', label: 'Airflow', type: 'number', unit: 'CFM', required: true },
        { name: 'pressure', label: 'Pressure', type: 'number', unit: 'PSI' },
        { name: 'power', label: 'Power', type: 'number', unit: 'HP' },
      ],
    },
  },
  {
    name: 'Aerator',
    code: 'aerator',
    description: 'Havalandırıcı',
    category: EquipmentCategory.AERATION,
    icon: 'aerator',
    sortOrder: 21,
    allowedSubEquipmentTypes: ['diffuser', 'air-stone'],
    specificationSchema: {
      fields: [
        { name: 'airflow', label: 'Airflow', type: 'number', unit: 'CFM', required: true },
        { name: 'pressure', label: 'Pressure', type: 'number', unit: 'PSI' },
        { name: 'power', label: 'Power', type: 'number', unit: 'HP' },
      ],
    },
  },

  // ============================================
  // HEATING_COOLING Category - Isıtma/Soğutma ekipmanları
  // ============================================
  {
    name: 'Heater',
    code: 'heater',
    description: 'Su ısıtıcı',
    category: EquipmentCategory.HEATING_COOLING,
    icon: 'heater',
    sortOrder: 30,
    allowedSubEquipmentTypes: ['inlet-valve', 'outlet-valve', 'temperature-sensor'],
    specificationSchema: {
      fields: [
        { name: 'heatingCapacity', label: 'Heating Capacity', type: 'number', unit: 'kW', required: true },
        { name: 'powerConsumption', label: 'Power Consumption', type: 'number', unit: 'kW' },
        { name: 'efficiency', label: 'Efficiency', type: 'number', unit: '%' },
        { name: 'fuelType', label: 'Fuel Type', type: 'select', required: true, options: [
          { value: 'electric', label: 'Electric' },
          { value: 'gas', label: 'Gas' },
          { value: 'oil', label: 'Oil' },
          { value: 'solar', label: 'Solar' },
        ]},
        { name: 'maxTemperature', label: 'Max Temperature', type: 'number', unit: '°C' },
      ],
    },
  },
  {
    name: 'Chiller',
    code: 'chiller',
    description: 'Su soğutucu',
    category: EquipmentCategory.HEATING_COOLING,
    icon: 'chiller',
    sortOrder: 31,
    allowedSubEquipmentTypes: ['inlet-valve', 'outlet-valve', 'temperature-sensor'],
    specificationSchema: {
      fields: [
        { name: 'coolingCapacity', label: 'Cooling Capacity', type: 'number', unit: 'kW', required: true },
        { name: 'powerConsumption', label: 'Power Consumption', type: 'number', unit: 'kW' },
        { name: 'cop', label: 'COP (Efficiency)', type: 'number' },
        { name: 'refrigerantType', label: 'Refrigerant Type', type: 'text', placeholder: 'e.g., R410A' },
        { name: 'maxFlowRate', label: 'Max Flow Rate', type: 'number', unit: 'm³/h' },
      ],
    },
  },
  {
    name: 'Heat Exchanger',
    code: 'heat-exchanger',
    description: 'Isı eşanjörü',
    category: EquipmentCategory.HEATING_COOLING,
    icon: 'heat-exchanger',
    sortOrder: 32,
    allowedSubEquipmentTypes: ['inlet-valve', 'outlet-valve', 'temperature-sensor', 'flowmeter'],
    specificationSchema: {
      fields: [
        { name: 'heatingCapacity', label: 'Heating Capacity', type: 'number', unit: 'kW', required: true },
        { name: 'powerConsumption', label: 'Power Consumption', type: 'number', unit: 'kW' },
        { name: 'efficiency', label: 'Efficiency', type: 'number', unit: '%' },
        { name: 'fuelType', label: 'Fuel Type', type: 'select', required: true, options: [
          { value: 'electric', label: 'Electric' },
          { value: 'gas', label: 'Gas' },
          { value: 'oil', label: 'Oil' },
          { value: 'solar', label: 'Solar' },
        ]},
        { name: 'maxTemperature', label: 'Max Temperature', type: 'number', unit: '°C' },
      ],
    },
  },

  // ============================================
  // FILTRATION Category - Filtrasyon ekipmanları
  // ============================================
  {
    name: 'Mechanical Filter',
    code: 'filter-mechanical',
    description: 'Mekanik filtre',
    category: EquipmentCategory.FILTRATION,
    icon: 'filter',
    sortOrder: 40,
    allowedSubEquipmentTypes: ['inlet-valve', 'outlet-valve', 'pressure-sensor'],
    specificationSchema: {
      fields: [
        { name: 'flowRate', label: 'Flow Rate', type: 'number', unit: 'm³/h', required: true },
        { name: 'filtrationSize', label: 'Filtration Size', type: 'number', unit: 'µm' },
        { name: 'mediaType', label: 'Media Type', type: 'text', placeholder: 'e.g., Sand, Cartridge' },
      ],
    },
  },
  {
    name: 'Biological Filter',
    code: 'filter-biological',
    description: 'Biyolojik filtre',
    category: EquipmentCategory.FILTRATION,
    icon: 'biofilter',
    sortOrder: 41,
    allowedSubEquipmentTypes: ['inlet-valve', 'outlet-valve', 'aerator', 'media-support'],
    specificationSchema: {
      fields: [
        { name: 'flowRate', label: 'Flow Rate', type: 'number', unit: 'm³/h', required: true },
        { name: 'mediaVolume', label: 'Media Volume', type: 'number', unit: 'L' },
        { name: 'mediaType', label: 'Media Type', type: 'select', options: [
          { value: 'moving_bed', label: 'Moving Bed (MBBR)' },
          { value: 'fixed_bed', label: 'Fixed Bed' },
          { value: 'fluidized_bed', label: 'Fluidized Bed' },
        ]},
        { name: 'surfaceArea', label: 'Surface Area', type: 'number', unit: 'm²/m³' },
      ],
    },
  },
  {
    name: 'UV Filter',
    code: 'filter-uv',
    description: 'UV filtre/sterilizatör',
    category: EquipmentCategory.FILTRATION,
    icon: 'uv',
    sortOrder: 42,
    allowedSubEquipmentTypes: ['inlet-valve', 'outlet-valve', 'uv-lamp', 'quartz-sleeve'],
    specificationSchema: {
      fields: [
        { name: 'flowRate', label: 'Flow Rate', type: 'number', unit: 'm³/h', required: true },
        { name: 'uvDose', label: 'UV Dose', type: 'number', unit: 'mJ/cm²' },
        { name: 'power', label: 'Power', type: 'number', unit: 'W' },
        { name: 'lampCount', label: 'Lamp Count', type: 'number', min: 1 },
      ],
    },
  },
  {
    name: 'Drum Filter',
    code: 'filter-drum',
    description: 'Tambur filtre',
    category: EquipmentCategory.FILTRATION,
    icon: 'drum-filter',
    sortOrder: 43,
    allowedSubEquipmentTypes: ['inlet-valve', 'outlet-valve', 'backwash-valve', 'pressure-sensor'],
    specificationSchema: {
      fields: [
        { name: 'flowRate', label: 'Flow Rate', type: 'number', unit: 'm³/h', required: true },
        { name: 'screenSize', label: 'Screen Size', type: 'number', unit: 'µm' },
        { name: 'drumDiameter', label: 'Drum Diameter', type: 'number', unit: 'mm' },
        { name: 'backwashInterval', label: 'Backwash Interval', type: 'number', unit: 'min' },
      ],
    },
  },
  {
    name: 'Bead Filter',
    code: 'filter-bead',
    description: 'Boncuk filtre',
    category: EquipmentCategory.FILTRATION,
    icon: 'filter',
    sortOrder: 44,
    allowedSubEquipmentTypes: ['inlet-valve', 'outlet-valve', 'pressure-sensor'],
    specificationSchema: {
      fields: [
        { name: 'flowRate', label: 'Flow Rate', type: 'number', unit: 'm³/h', required: true },
        { name: 'beadVolume', label: 'Bead Volume', type: 'number', unit: 'L' },
        { name: 'beadType', label: 'Bead Type', type: 'select', options: [
          { value: 'polyethylene', label: 'Polyethylene' },
          { value: 'polypropylene', label: 'Polypropylene' },
        ]},
        { name: 'backwashFrequency', label: 'Backwash Frequency', type: 'text', placeholder: 'e.g., Daily' },
      ],
    },
  },

  // ============================================
  // FEEDING Category - Yemleme ekipmanları
  // ============================================
  {
    name: 'Automatic Feeder',
    code: 'feeder-automatic',
    description: 'Otomatik yemleme sistemi',
    category: EquipmentCategory.FEEDING,
    icon: 'feeder',
    sortOrder: 50,
    allowedSubEquipmentTypes: ['hopper', 'spreading-disc', 'feed-sensor'],
    specificationSchema: {
      fields: [
        { name: 'capacity', label: 'Capacity', type: 'number', unit: 'kg', required: true },
        { name: 'feedingRate', label: 'Feeding Rate', type: 'text', placeholder: 'e.g., 1-10 kg/h' },
        { name: 'controlType', label: 'Control Type', type: 'select', options: [
          { value: 'timer', label: 'Timer' },
          { value: 'remote', label: 'Remote' },
          { value: 'automatic', label: 'Automatic' },
        ]},
        { name: 'siloVolume', label: 'Silo Volume', type: 'number', unit: 'L', required: true },
        { name: 'autoFilling', label: 'Auto Filling', type: 'boolean', defaultValue: false, helpText: 'Otomatik dolum sistemi var mi?' },
      ],
    },
  },
  {
    name: 'Demand Feeder',
    code: 'feeder-demand',
    description: 'Talep bazlı yemleme sistemi',
    category: EquipmentCategory.FEEDING,
    icon: 'feeder',
    sortOrder: 51,
    allowedSubEquipmentTypes: ['hopper', 'trigger-mechanism'],
    specificationSchema: {
      fields: [
        { name: 'capacity', label: 'Capacity', type: 'number', unit: 'kg', required: true },
        { name: 'feedingRate', label: 'Feeding Rate', type: 'text', placeholder: 'e.g., 1-10 kg/h' },
        { name: 'controlType', label: 'Control Type', type: 'select', options: [
          { value: 'timer', label: 'Timer' },
          { value: 'remote', label: 'Remote' },
          { value: 'automatic', label: 'Automatic' },
        ]},
        { name: 'siloVolume', label: 'Silo Volume', type: 'number', unit: 'L', required: true },
        { name: 'autoFilling', label: 'Auto Filling', type: 'boolean', defaultValue: false, helpText: 'Otomatik dolum sistemi var mi?' },
      ],
    },
  },
  {
    name: 'Semi-Automatic Feeder',
    code: 'feeder-semi-automatic',
    description: 'Yarı otomatik yemleme sistemi',
    category: EquipmentCategory.FEEDING,
    icon: 'feeder',
    sortOrder: 52,
    allowedSubEquipmentTypes: ['hopper', 'spreading-disc'],
    specificationSchema: {
      fields: [
        { name: 'capacity', label: 'Capacity', type: 'number', unit: 'kg', required: true },
        { name: 'feedingRate', label: 'Feeding Rate', type: 'text', placeholder: 'e.g., 1-10 kg/h' },
        { name: 'siloVolume', label: 'Silo Volume', type: 'number', unit: 'L', required: true },
        { name: 'autoFilling', label: 'Auto Filling', type: 'boolean', defaultValue: false, helpText: 'Otomatik dolum sistemi var mi?' },
      ],
    },
  },

  // ============================================
  // PLUMBING Category - Tesisat ekipmanları
  // ============================================
  {
    name: 'Tank Inlet',
    code: 'tank-inlet',
    description: 'Tank su giriş borusu - su dağıtım delikleri ile',
    category: EquipmentCategory.PLUMBING,
    icon: 'inlet',
    sortOrder: 53,
    allowedSubEquipmentTypes: ['valve', 'flowmeter'],
    specificationSchema: {
      fields: [
        { name: 'pipeSize', label: 'Pipe Size', type: 'number', unit: 'mm', required: true, defaultValue: 110 },
        { name: 'holeCount', label: 'Distribution Holes', type: 'number', required: false, defaultValue: 6 },
        { name: 'material', label: 'Material', type: 'select', options: [
          { value: 'pvc', label: 'PVC' },
          { value: 'hdpe', label: 'HDPE' },
          { value: 'stainless', label: 'Stainless Steel' },
        ], defaultValue: 'pvc' },
      ],
    },
  },

  // ============================================
  // MONITORING Category - Sensör ekipmanları
  // ============================================
  {
    name: 'Temperature Sensor',
    code: 'sensor-temperature',
    description: 'Sıcaklık sensörü',
    category: EquipmentCategory.MONITORING,
    icon: 'sensor',
    sortOrder: 60,
    allowedSubEquipmentTypes: ['sensor-housing', 'calibration-chamber'],
    specificationSchema: {
      fields: [
        { name: 'measurementRange', label: 'Measurement Range', type: 'text', placeholder: 'e.g., 0-50°C', required: true },
        { name: 'accuracy', label: 'Accuracy', type: 'text', placeholder: 'e.g., ±0.1°C' },
        { name: 'connectivity', label: 'Connectivity', type: 'select', options: [
          { value: 'wifi', label: 'WiFi' },
          { value: '4g5g', label: '4G/5G' },
          { value: 'rs485', label: 'RS485' },
          { value: 'modbus', label: 'Modbus' },
          { value: 'analog', label: 'Analog' },
        ]},
        { name: 'calibrationDate', label: 'Last Calibration Date', type: 'date' },
      ],
    },
  },
  {
    name: 'pH Sensor',
    code: 'sensor-ph',
    description: 'pH sensörü',
    category: EquipmentCategory.MONITORING,
    icon: 'sensor',
    sortOrder: 61,
    allowedSubEquipmentTypes: ['sensor-housing', 'calibration-chamber'],
    specificationSchema: {
      fields: [
        { name: 'measurementRange', label: 'Measurement Range', type: 'text', placeholder: 'e.g., 0-14 pH', required: true },
        { name: 'accuracy', label: 'Accuracy', type: 'text', placeholder: 'e.g., ±0.01 pH' },
        { name: 'connectivity', label: 'Connectivity', type: 'select', options: [
          { value: 'wifi', label: 'WiFi' },
          { value: '4g5g', label: '4G/5G' },
          { value: 'rs485', label: 'RS485' },
          { value: 'modbus', label: 'Modbus' },
          { value: 'analog', label: 'Analog' },
        ]},
        { name: 'calibrationDate', label: 'Last Calibration Date', type: 'date' },
      ],
    },
  },
  {
    name: 'DO Sensor',
    code: 'sensor-do',
    description: 'Çözünmüş oksijen sensörü',
    category: EquipmentCategory.MONITORING,
    icon: 'sensor',
    sortOrder: 62,
    allowedSubEquipmentTypes: ['sensor-housing', 'calibration-chamber'],
    specificationSchema: {
      fields: [
        { name: 'measurementRange', label: 'Measurement Range', type: 'text', placeholder: 'e.g., 0-20 mg/L', required: true },
        { name: 'accuracy', label: 'Accuracy', type: 'text', placeholder: 'e.g., ±0.1 mg/L' },
        { name: 'connectivity', label: 'Connectivity', type: 'select', options: [
          { value: 'wifi', label: 'WiFi' },
          { value: '4g5g', label: '4G/5G' },
          { value: 'rs485', label: 'RS485' },
          { value: 'modbus', label: 'Modbus' },
          { value: 'analog', label: 'Analog' },
        ]},
        { name: 'calibrationDate', label: 'Last Calibration Date', type: 'date' },
      ],
    },
  },
  {
    name: 'Salinity Sensor',
    code: 'sensor-salinity',
    description: 'Tuzluluk sensörü',
    category: EquipmentCategory.MONITORING,
    icon: 'sensor',
    sortOrder: 63,
    allowedSubEquipmentTypes: ['sensor-housing', 'calibration-chamber'],
    specificationSchema: {
      fields: [
        { name: 'measurementRange', label: 'Measurement Range', type: 'text', placeholder: 'e.g., 0-50 ppt', required: true },
        { name: 'accuracy', label: 'Accuracy', type: 'text', placeholder: 'e.g., ±0.1 ppt' },
        { name: 'connectivity', label: 'Connectivity', type: 'select', options: [
          { value: 'wifi', label: 'WiFi' },
          { value: '4g5g', label: '4G/5G' },
          { value: 'rs485', label: 'RS485' },
          { value: 'modbus', label: 'Modbus' },
          { value: 'analog', label: 'Analog' },
        ]},
        { name: 'calibrationDate', label: 'Last Calibration Date', type: 'date' },
      ],
    },
  },
  {
    name: 'Ammonia Sensor',
    code: 'sensor-ammonia',
    description: 'Amonyak sensörü',
    category: EquipmentCategory.MONITORING,
    icon: 'sensor',
    sortOrder: 64,
    allowedSubEquipmentTypes: ['sensor-housing', 'calibration-chamber'],
    specificationSchema: {
      fields: [
        { name: 'measurementRange', label: 'Measurement Range', type: 'text', placeholder: 'e.g., 0-10 mg/L', required: true },
        { name: 'accuracy', label: 'Accuracy', type: 'text', placeholder: 'e.g., ±0.01 mg/L' },
        { name: 'connectivity', label: 'Connectivity', type: 'select', options: [
          { value: 'wifi', label: 'WiFi' },
          { value: '4g5g', label: '4G/5G' },
          { value: 'rs485', label: 'RS485' },
          { value: 'modbus', label: 'Modbus' },
          { value: 'analog', label: 'Analog' },
        ]},
        { name: 'calibrationDate', label: 'Last Calibration Date', type: 'date' },
      ],
    },
  },
  {
    name: 'Flow Sensor',
    code: 'sensor-flow',
    description: 'Akış sensörü',
    category: EquipmentCategory.MONITORING,
    icon: 'sensor',
    sortOrder: 65,
    allowedSubEquipmentTypes: ['sensor-housing'],
    specificationSchema: {
      fields: [
        { name: 'measurementRange', label: 'Measurement Range', type: 'text', placeholder: 'e.g., 0-100 m³/h', required: true },
        { name: 'accuracy', label: 'Accuracy', type: 'text', placeholder: 'e.g., ±1%' },
        { name: 'connectivity', label: 'Connectivity', type: 'select', options: [
          { value: 'wifi', label: 'WiFi' },
          { value: '4g5g', label: '4G/5G' },
          { value: 'rs485', label: 'RS485' },
          { value: 'modbus', label: 'Modbus' },
          { value: 'analog', label: 'Analog' },
        ]},
        { name: 'calibrationDate', label: 'Last Calibration Date', type: 'date' },
      ],
    },
  },
  {
    name: 'Level Sensor',
    code: 'sensor-level',
    description: 'Seviye sensörü',
    category: EquipmentCategory.MONITORING,
    icon: 'sensor',
    sortOrder: 66,
    allowedSubEquipmentTypes: ['sensor-housing'],
    specificationSchema: {
      fields: [
        { name: 'measurementRange', label: 'Measurement Range', type: 'text', placeholder: 'e.g., 0-10 m', required: true },
        { name: 'accuracy', label: 'Accuracy', type: 'text', placeholder: 'e.g., ±1 cm' },
        { name: 'connectivity', label: 'Connectivity', type: 'select', options: [
          { value: 'wifi', label: 'WiFi' },
          { value: '4g5g', label: '4G/5G' },
          { value: 'rs485', label: 'RS485' },
          { value: 'modbus', label: 'Modbus' },
          { value: 'analog', label: 'Analog' },
        ]},
        { name: 'calibrationDate', label: 'Last Calibration Date', type: 'date' },
      ],
    },
  },
  {
    name: 'Pressure Sensor',
    code: 'sensor-pressure',
    description: 'Basınç sensörü',
    category: EquipmentCategory.MONITORING,
    icon: 'sensor',
    sortOrder: 67,
    allowedSubEquipmentTypes: ['sensor-housing'],
    specificationSchema: {
      fields: [
        { name: 'measurementRange', label: 'Measurement Range', type: 'text', placeholder: 'e.g., 0-10 bar', required: true },
        { name: 'accuracy', label: 'Accuracy', type: 'text', placeholder: 'e.g., ±0.1%' },
        { name: 'connectivity', label: 'Connectivity', type: 'select', options: [
          { value: 'wifi', label: 'WiFi' },
          { value: '4g5g', label: '4G/5G' },
          { value: 'rs485', label: 'RS485' },
          { value: 'modbus', label: 'Modbus' },
          { value: 'analog', label: 'Analog' },
        ]},
        { name: 'calibrationDate', label: 'Last Calibration Date', type: 'date' },
      ],
    },
  },
  {
    name: 'Multiparameter Probe',
    code: 'sensor-multiparameter',
    description: 'Çoklu parametre ölçüm probu',
    category: EquipmentCategory.MONITORING,
    icon: 'probe',
    sortOrder: 68,
    allowedSubEquipmentTypes: ['sensor-housing', 'calibration-chamber'],
    specificationSchema: {
      fields: [
        { name: 'parameters', label: 'Measured Parameters', type: 'multiselect', required: true, options: [
          { value: 'temperature', label: 'Temperature' },
          { value: 'ph', label: 'pH' },
          { value: 'do', label: 'Dissolved Oxygen' },
          { value: 'salinity', label: 'Salinity' },
          { value: 'conductivity', label: 'Conductivity' },
          { value: 'turbidity', label: 'Turbidity' },
        ]},
        { name: 'measurementRange', label: 'Measurement Range', type: 'text', placeholder: 'e.g., Multiple parameters' },
        { name: 'accuracy', label: 'Accuracy', type: 'text', placeholder: 'e.g., Varies by parameter' },
        { name: 'connectivity', label: 'Connectivity', type: 'select', options: [
          { value: 'wifi', label: 'WiFi' },
          { value: '4g5g', label: '4G/5G' },
          { value: 'rs485', label: 'RS485' },
          { value: 'modbus', label: 'Modbus' },
          { value: 'analog', label: 'Analog' },
        ]},
        { name: 'calibrationDate', label: 'Last Calibration Date', type: 'date' },
      ],
    },
  },

  // ============================================
  // ELECTRICAL Category - Elektrik ekipmanları
  // ============================================
  {
    name: 'Generator',
    code: 'generator',
    description: 'Jeneratör / Yedek güç kaynağı',
    category: EquipmentCategory.ELECTRICAL,
    icon: 'generator',
    sortOrder: 70,
    allowedSubEquipmentTypes: ['fuel-tank', 'transfer-switch', 'control-panel'],
    specificationSchema: {
      fields: [
        { name: 'powerOutput', label: 'Power Output', type: 'number', unit: 'kW', required: true },
        { name: 'fuelType', label: 'Fuel Type', type: 'select', required: true, options: [
          { value: 'diesel', label: 'Diesel' },
          { value: 'gasoline', label: 'Gasoline' },
          { value: 'natural_gas', label: 'Natural Gas' },
          { value: 'propane', label: 'Propane' },
        ]},
        { name: 'fuelConsumption', label: 'Fuel Consumption', type: 'number', unit: 'L/h' },
      ],
    },
  },

  // ============================================
  // OTHER Category - Diğer ekipmanlar
  // ============================================
  {
    name: 'Other Equipment',
    code: 'other',
    description: 'Diğer ekipmanlar',
    category: EquipmentCategory.OTHER,
    icon: 'other',
    sortOrder: 100,
    allowedSubEquipmentTypes: [],
    specificationSchema: {
      fields: [
        { name: 'customField1', label: 'Custom Field 1', type: 'text' },
        { name: 'customField2', label: 'Custom Field 2', type: 'text' },
        { name: 'customField3', label: 'Custom Field 3', type: 'text' },
        { name: 'notes', label: 'Notes', type: 'textarea' },
      ],
    },
  },

  // ============================================
  // WATER_TREATMENT Category - Su arıtma ekipmanları
  // ============================================
  {
    name: 'UV Sterilizer',
    code: 'uv-sterilizer',
    description: 'UV sterilizatör',
    category: EquipmentCategory.WATER_TREATMENT,
    icon: 'uv',
    sortOrder: 80,
    allowedSubEquipmentTypes: ['inlet-valve', 'outlet-valve', 'uv-lamp', 'quartz-sleeve'],
    specificationSchema: {
      fields: [
        { name: 'flowRate', label: 'Debi', type: 'number', unit: 'm³/h', required: true },
        { name: 'uvDose', label: 'UV Dozu', type: 'number', unit: 'mJ/cm²', required: true },
        { name: 'power', label: 'Güç', type: 'number', unit: 'W', required: true },
        { name: 'lampCount', label: 'Lamba Sayısı', type: 'number', min: 1 },
        { name: 'lampType', label: 'Lamba Tipi', type: 'select', options: [
          { value: 'low_pressure', label: 'Düşük Basınç' },
          { value: 'medium_pressure', label: 'Orta Basınç' },
          { value: 'amalgam', label: 'Amalgam' },
        ]},
        { name: 'lampLifeHours', label: 'Lamba Ömrü', type: 'number', unit: 'saat' },
        { name: 'transmittance', label: 'Min. Transmittans', type: 'number', unit: '%' },
      ],
    },
  },
  {
    name: 'Ozone Generator',
    code: 'ozone-generator',
    description: 'Ozon jeneratörü',
    category: EquipmentCategory.WATER_TREATMENT,
    icon: 'ozone',
    sortOrder: 81,
    allowedSubEquipmentTypes: ['ozone-contactor', 'orp-controller', 'destruct-unit'],
    specificationSchema: {
      fields: [
        { name: 'ozoneProduction', label: 'Ozon Üretimi', type: 'number', unit: 'g/h', required: true },
        { name: 'power', label: 'Güç', type: 'number', unit: 'kW', required: true },
        { name: 'generationType', label: 'Üretim Tipi', type: 'select', required: true, options: [
          { value: 'corona', label: 'Corona Discharge' },
          { value: 'uv', label: 'UV' },
        ]},
        { name: 'feedGas', label: 'Besleme Gazı', type: 'select', options: [
          { value: 'air', label: 'Hava' },
          { value: 'oxygen', label: 'Oksijen' },
        ]},
        { name: 'concentration', label: 'Ozon Konsantrasyonu', type: 'number', unit: '%' },
        { name: 'coolingType', label: 'Soğutma Tipi', type: 'select', options: [
          { value: 'air', label: 'Hava' },
          { value: 'water', label: 'Su' },
        ]},
      ],
    },
  },
];


// ============================================================================
// SUB-EQUIPMENT TIER — compatibility is DERIVED, never declared twice
// ============================================================================

/**
 * WHAT: one sub-equipment type, declaring only what a sub-component genuinely
 * owns — its identity and its own specification form.
 *
 * WHY there is no `compatibleEquipmentTypes` field here: the equipment ↔
 * sub-equipment relation is ALREADY declared, exactly once, on the equipment
 * side (`EquipmentTypeSeed.allowedSubEquipmentTypes`). Declaring it a second
 * time on the sub-equipment side meant two catalogues describing one relation in
 * opposite directions, and they drifted — the sub side listed `'fish-tank'`,
 * `'auto-feeder'`, `'water-pump'` while the live catalogue ships
 * `'tank-circular'`, `'feeder-automatic'`, `'pump-centrifugal'`. Nothing caught
 * it because the constant was imported by no one and the tier was never seeded;
 * the moment it were, `CreateSubEquipmentHandler`'s compatibility check would
 * have rejected every single pairing an operator could make.
 * {@link buildSubEquipmentTypeSeed} now INVERTS the equipment-side relation, so
 * the two sides cannot disagree: there is only one side.
 */
export interface SubEquipmentTypeDeclaration {
  name: string;
  code: string;
  description: string;
  specificationSchema: SpecificationSchema;
}

/** A seeded sub-equipment row: the declaration plus its derived inverse index. */
export interface SubEquipmentTypeSeed extends SubEquipmentTypeDeclaration {
  /**
   * DERIVED from `EQUIPMENT_TYPES_SEED[].allowedSubEquipmentTypes`. Never
   * hand-edit — {@link buildSubEquipmentTypeSeed} recomputes it on every import.
   */
  compatibleEquipmentTypes: string[];
  sortOrder: number;
}

/**
 * WHAT: invert the equipment-side relation into the sub-equipment catalogue and
 * assert that the relation is TOTAL in both directions.
 *
 * WHY it throws rather than filters: both halves of an incomplete relation are
 * operator-visible defects that are silent at runtime.
 *   - a referenced-but-undeclared sub-code lets the setup UI offer a slot no
 *     sub-equipment type can fill (the tier ships with 20 such codes before this
 *     change);
 *   - a declared-but-unreferenced sub-type is unreachable — no parent equipment
 *     type accepts it, so it can never be created.
 * Throwing at module load makes both fail at seed time and in CI (the seed is
 * imported by `FarmSeedService` and by
 * `equipment/__tests__/equipment-types.seed.spec.ts`), which is the detectable
 * tier; the derivation itself is the structural tier — the relation has exactly
 * one author.
 */
export function buildSubEquipmentTypeSeed(
  equipmentTypes: readonly EquipmentTypeSeed[],
  declarations: readonly SubEquipmentTypeDeclaration[],
): SubEquipmentTypeSeed[] {
  const declaredCodes = new Set<string>();
  for (const declaration of declarations) {
    if (declaredCodes.has(declaration.code)) {
      throw new Error(
        `[equipment-types.seed] Sub-equipment type code "${declaration.code}" is declared twice.`,
      );
    }
    declaredCodes.add(declaration.code);
  }

  // Inverse index: sub-equipment code -> equipment type codes that accept it.
  const acceptedBy = new Map<string, string[]>();
  for (const equipmentType of equipmentTypes) {
    for (const subCode of equipmentType.allowedSubEquipmentTypes) {
      const owners = acceptedBy.get(subCode);
      if (owners) {
        owners.push(equipmentType.code);
      } else {
        acceptedBy.set(subCode, [equipmentType.code]);
      }
    }
  }

  const referencedButUndeclared = [...acceptedBy.keys()]
    .filter((code) => !declaredCodes.has(code))
    .sort();
  if (referencedButUndeclared.length > 0) {
    throw new Error(
      `[equipment-types.seed] EQUIPMENT_TYPES_SEED accepts sub-equipment codes that no ` +
        `SubEquipmentTypeDeclaration provides: ${referencedButUndeclared.join(', ')}. ` +
        `Declare them below or stop listing them in allowedSubEquipmentTypes.`,
    );
  }

  const declaredButUnreachable = [...declaredCodes]
    .filter((code) => !acceptedBy.has(code))
    .sort();
  if (declaredButUnreachable.length > 0) {
    throw new Error(
      `[equipment-types.seed] These sub-equipment types are declared but no equipment type ` +
        `accepts them, so an operator can never create one: ${declaredButUnreachable.join(', ')}.`,
    );
  }

  return declarations.map((declaration, index) => ({
    ...declaration,
    compatibleEquipmentTypes: [...(acceptedBy.get(declaration.code) ?? [])].sort(),
    sortOrder: index + 1,
  }));
}

/**
 * The sub-equipment catalogue.
 *
 * NOTE on `feed-drop-point` (formerly `feeder`): a tank's feed drop point is the
 * nozzle/spout where feed lands in the water — it is NOT the dosing machine.
 * The dosing machine is an Equipment row of category FEEDING (`feeder-automatic`
 * and siblings): it is what carries a silo volume, what
 * `feeder_calibrations.equipment_id` calibrates, and what a unit-to-feeder
 * assignment binds. The old name invited exactly the confusion that put
 * "SubEquipment feeder ID" in `daily_feeding_executions.feederEquipmentId` while
 * calibration wrote against Equipment — two tables describing different objects.
 * There is deliberately no sub-equipment type called a "feeder" any more.
 */
const SUB_EQUIPMENT_TYPE_DECLARATIONS: SubEquipmentTypeDeclaration[] = [
  // ── Tank / pond / cage attachments ────────────────────────────────────────
  { name: 'Inlet', code: 'inlet', description: 'Su girişi', specificationSchema: { fields: [
    { name: 'diameter', label: 'Çap', type: 'number', unit: 'mm', required: true },
    { name: 'material', label: 'Malzeme', type: 'select', options: [{ value: 'pvc', label: 'PVC' }, { value: 'hdpe', label: 'HDPE' }] },
  ]}},
  { name: 'Outlet', code: 'outlet', description: 'Su çıkışı', specificationSchema: { fields: [
    { name: 'diameter', label: 'Çap', type: 'number', unit: 'mm', required: true },
    { name: 'type', label: 'Tip', type: 'select', options: [{ value: 'center', label: 'Merkez' }, { value: 'side', label: 'Yan' }, { value: 'overflow', label: 'Taşma' }] },
  ]}},
  { name: 'Drain', code: 'drain', description: 'Drenaj', specificationSchema: { fields: [
    { name: 'diameter', label: 'Çap', type: 'number', unit: 'mm', required: true },
    { name: 'valveType', label: 'Vana Tipi', type: 'select', options: [{ value: 'standpipe', label: 'Standpipe' }, { value: 'external', label: 'Harici' }] },
  ]}},
  { name: 'Feed Drop Point', code: 'feed-drop-point', description: 'Yemin suya düştüğü nokta (dozajlayıcı makine DEĞİL)', specificationSchema: { fields: [
    { name: 'position', label: 'Konum', type: 'select', options: [{ value: 'center', label: 'Merkez' }, { value: 'edge', label: 'Kenar' }] },
    { name: 'spreadDiameter', label: 'Yayılma Çapı', type: 'number', unit: 'm' },
  ]}},
  { name: 'Fish Trap', code: 'fish-trap', description: 'Balık toplama kapanı', specificationSchema: { fields: [
    { name: 'size', label: 'Boyut', type: 'text' },
    { name: 'material', label: 'Malzeme', type: 'text' },
  ]}},
  { name: 'Aerator', code: 'aerator', description: 'Havalandırma noktası', specificationSchema: { fields: [
    { name: 'type', label: 'Tip', type: 'select', options: [{ value: 'diffuser', label: 'Difüzör' }, { value: 'air_stone', label: 'Hava Taşı' }] },
    { name: 'airFlow', label: 'Hava Debisi', type: 'number', unit: 'L/min' },
  ]}},
  { name: 'Sensor Probe', code: 'sensor-probe', description: 'Sensör probu', specificationSchema: { fields: [
    { name: 'parameter', label: 'Parametre', type: 'select', options: [{ value: 'do', label: 'DO' }, { value: 'ph', label: 'pH' }, { value: 'temp', label: 'Sıcaklık' }] },
  ]}},
  { name: 'Screen', code: 'screen', description: 'Elek/Izgara', specificationSchema: { fields: [
    { name: 'meshSize', label: 'Elek Açıklığı', type: 'number', unit: 'mm' },
    { name: 'material', label: 'Malzeme', type: 'text' },
  ]}},
  { name: 'Net', code: 'net', description: 'Kafes ağı', specificationSchema: { fields: [
    { name: 'meshSize', label: 'Göz Açıklığı', type: 'number', unit: 'mm', required: true },
    { name: 'depth', label: 'Derinlik', type: 'number', unit: 'm' },
    { name: 'material', label: 'Malzeme', type: 'select', options: [{ value: 'nylon', label: 'Naylon' }, { value: 'dyneema', label: 'Dyneema' }, { value: 'copper_alloy', label: 'Bakır Alaşım' }] },
  ]}},
  { name: 'Mooring', code: 'mooring', description: 'Demirleme sistemi', specificationSchema: { fields: [
    { name: 'anchorType', label: 'Çapa Tipi', type: 'select', options: [{ value: 'gravity', label: 'Ağırlık' }, { value: 'embedded', label: 'Gömülü' }, { value: 'pile', label: 'Kazık' }] },
    { name: 'lineLength', label: 'Halat Boyu', type: 'number', unit: 'm' },
  ]}},
  { name: 'Ballast System', code: 'ballast-system', description: 'Balast/daldırma sistemi', specificationSchema: { fields: [
    { name: 'ballastVolume', label: 'Balast Hacmi', type: 'number', unit: 'm³' },
    { name: 'controlType', label: 'Kontrol Tipi', type: 'select', options: [{ value: 'manual', label: 'Manuel' }, { value: 'remote', label: 'Uzaktan' }] },
  ]}},
  { name: 'Camera', code: 'camera', description: 'Sualtı kamerası', specificationSchema: { fields: [
    { name: 'resolution', label: 'Çözünürlük', type: 'text', placeholder: 'ör. 1080p' },
    { name: 'depthRating', label: 'Derinlik Sınıfı', type: 'number', unit: 'm' },
  ]}},

  // ── Pump / valve / line fittings ──────────────────────────────────────────
  { name: 'Inlet Valve', code: 'inlet-valve', description: 'Giriş vanası', specificationSchema: { fields: [
    { name: 'size', label: 'Boyut', type: 'number', unit: 'mm' },
    { name: 'type', label: 'Tip', type: 'select', options: [{ value: 'gate', label: 'Sürgülü' }, { value: 'ball', label: 'Küresel' }, { value: 'butterfly', label: 'Kelebek' }] },
  ]}},
  { name: 'Outlet Valve', code: 'outlet-valve', description: 'Çıkış vanası', specificationSchema: { fields: [
    { name: 'size', label: 'Boyut', type: 'number', unit: 'mm' },
    { name: 'type', label: 'Tip', type: 'select', options: [{ value: 'gate', label: 'Sürgülü' }, { value: 'ball', label: 'Küresel' }, { value: 'butterfly', label: 'Kelebek' }] },
  ]}},
  { name: 'Valve', code: 'valve', description: 'Hat vanası', specificationSchema: { fields: [
    { name: 'size', label: 'Boyut', type: 'number', unit: 'mm' },
    { name: 'type', label: 'Tip', type: 'select', options: [{ value: 'gate', label: 'Sürgülü' }, { value: 'ball', label: 'Küresel' }, { value: 'butterfly', label: 'Kelebek' }, { value: 'check', label: 'Çek' }] },
  ]}},
  { name: 'Backwash Valve', code: 'backwash-valve', description: 'Geri yıkama vanası', specificationSchema: { fields: [
    { name: 'size', label: 'Boyut', type: 'number', unit: 'mm' },
    { name: 'actuation', label: 'Tahrik', type: 'select', options: [{ value: 'manual', label: 'Manuel' }, { value: 'pneumatic', label: 'Pnömatik' }, { value: 'electric', label: 'Elektrikli' }] },
  ]}},
  { name: 'Check Valve', code: 'check-valve', description: 'Çek valf', specificationSchema: { fields: [
    { name: 'size', label: 'Boyut', type: 'number', unit: 'mm' },
  ]}},
  { name: 'Pressure Gauge', code: 'pressure-gauge', description: 'Basınç göstergesi', specificationSchema: { fields: [
    { name: 'range', label: 'Aralık', type: 'text' },
    { name: 'unit', label: 'Birim', type: 'select', options: [{ value: 'bar', label: 'bar' }, { value: 'psi', label: 'psi' }, { value: 'mbar', label: 'mbar' }] },
  ]}},
  { name: 'Pressure Sensor', code: 'pressure-sensor', description: 'Basınç sensörü', specificationSchema: { fields: [
    { name: 'range', label: 'Aralık', type: 'text' },
    { name: 'output', label: 'Çıkış', type: 'select', options: [{ value: '4-20ma', label: '4-20 mA' }, { value: '0-10v', label: '0-10 V' }, { value: 'modbus', label: 'Modbus' }] },
  ]}},
  { name: 'Flowmeter', code: 'flowmeter', description: 'Debimetre', specificationSchema: { fields: [
    { name: 'range', label: 'Aralık', type: 'text' },
    { name: 'type', label: 'Tip', type: 'select', options: [{ value: 'electromagnetic', label: 'Elektromanyetik' }, { value: 'ultrasonic', label: 'Ultrasonik' }, { value: 'mechanical', label: 'Mekanik' }] },
  ]}},

  // ── Blower / aeration ─────────────────────────────────────────────────────
  { name: 'Air Filter', code: 'air-filter', description: 'Hava filtresi', specificationSchema: { fields: [
    { name: 'filterClass', label: 'Filtre Sınıfı', type: 'text' },
  ]}},
  { name: 'Silencer', code: 'silencer', description: 'Susturucu', specificationSchema: { fields: [
    { name: 'noiseReduction', label: 'Gürültü Azaltma', type: 'number', unit: 'dB' },
  ]}},
  { name: 'Diffuser', code: 'diffuser', description: 'Hava difüzörü', specificationSchema: { fields: [
    { name: 'bubbleSize', label: 'Kabarcık Boyutu', type: 'select', options: [{ value: 'fine', label: 'İnce' }, { value: 'coarse', label: 'Kaba' }] },
    { name: 'airFlow', label: 'Hava Debisi', type: 'number', unit: 'L/min' },
  ]}},
  { name: 'Air Stone', code: 'air-stone', description: 'Hava taşı', specificationSchema: { fields: [
    { name: 'diameter', label: 'Çap', type: 'number', unit: 'mm' },
    { name: 'material', label: 'Malzeme', type: 'text' },
  ]}},

  // ── Feeder machine parts (parts OF a FEEDING-category Equipment row) ──────
  { name: 'Hopper', code: 'hopper', description: 'Yem haznesi', specificationSchema: { fields: [
    { name: 'capacity', label: 'Kapasite', type: 'number', unit: 'kg' },
  ]}},
  { name: 'Spreading Disc', code: 'spreading-disc', description: 'Yayıcı disk', specificationSchema: { fields: [
    { name: 'diameter', label: 'Çap', type: 'number', unit: 'cm' },
  ]}},
  { name: 'Feed Sensor', code: 'feed-sensor', description: 'Yem seviye/akış sensörü', specificationSchema: { fields: [
    { name: 'measures', label: 'Ölçüm', type: 'select', options: [{ value: 'level', label: 'Seviye' }, { value: 'flow', label: 'Akış' }, { value: 'pellet_count', label: 'Pelet Sayısı' }] },
    { name: 'output', label: 'Çıkış', type: 'select', options: [{ value: '4-20ma', label: '4-20 mA' }, { value: 'digital', label: 'Dijital' }, { value: 'modbus', label: 'Modbus' }] },
  ]}},
  { name: 'Trigger Mechanism', code: 'trigger-mechanism', description: 'Talep yemleyici tetik mekanizması', specificationSchema: { fields: [
    { name: 'pendulumLength', label: 'Sarkaç Boyu', type: 'number', unit: 'cm' },
    { name: 'sensitivity', label: 'Hassasiyet', type: 'select', options: [{ value: 'low', label: 'Düşük' }, { value: 'medium', label: 'Orta' }, { value: 'high', label: 'Yüksek' }] },
  ]}},

  // ── Filtration internals ──────────────────────────────────────────────────
  { name: 'Media Support', code: 'media-support', description: 'Biyofiltre medya yatağı', specificationSchema: { fields: [
    { name: 'mediaType', label: 'Medya Tipi', type: 'text' },
    { name: 'mediaVolume', label: 'Medya Hacmi', type: 'number', unit: 'm³' },
  ]}},

  // ── UV / ozone ────────────────────────────────────────────────────────────
  { name: 'UV Lamp', code: 'uv-lamp', description: 'UV lambası', specificationSchema: { fields: [
    { name: 'power', label: 'Güç', type: 'number', unit: 'W' },
    { name: 'lifeHours', label: 'Ömür', type: 'number', unit: 'saat' },
  ]}},
  { name: 'Quartz Sleeve', code: 'quartz-sleeve', description: 'Kuvars kılıf', specificationSchema: { fields: [
    { name: 'length', label: 'Uzunluk', type: 'number', unit: 'mm' },
    { name: 'diameter', label: 'Çap', type: 'number', unit: 'mm' },
  ]}},
  { name: 'Ozone Contactor', code: 'ozone-contactor', description: 'Ozon temas tankı', specificationSchema: { fields: [
    { name: 'volume', label: 'Hacim', type: 'number', unit: 'm³' },
    { name: 'contactTime', label: 'Temas Süresi', type: 'number', unit: 'dk' },
  ]}},
  { name: 'ORP Controller', code: 'orp-controller', description: 'ORP kontrol ünitesi', specificationSchema: { fields: [
    { name: 'setpoint', label: 'Set Değeri', type: 'number', unit: 'mV' },
    { name: 'range', label: 'Aralık', type: 'text' },
  ]}},
  { name: 'Destruct Unit', code: 'destruct-unit', description: 'Artık ozon parçalayıcı', specificationSchema: { fields: [
    { name: 'method', label: 'Yöntem', type: 'select', options: [{ value: 'thermal', label: 'Termal' }, { value: 'catalytic', label: 'Katalitik' }] },
  ]}},

  // ── Sensor housings / calibration ─────────────────────────────────────────
  { name: 'Temperature Sensor', code: 'temperature-sensor', description: 'Sıcaklık sensörü', specificationSchema: { fields: [
    { name: 'type', label: 'Tip', type: 'select', options: [{ value: 'pt100', label: 'PT100' }, { value: 'thermocouple', label: 'Termokupl' }] },
    { name: 'range', label: 'Aralık', type: 'text' },
  ]}},
  { name: 'Sensor Housing', code: 'sensor-housing', description: 'Sensör muhafazası', specificationSchema: { fields: [
    { name: 'material', label: 'Malzeme', type: 'text' },
    { name: 'ipRating', label: 'IP Sınıfı', type: 'text', placeholder: 'ör. IP68' },
  ]}},
  { name: 'Calibration Chamber', code: 'calibration-chamber', description: 'Kalibrasyon haznesi', specificationSchema: { fields: [
    { name: 'volume', label: 'Hacim', type: 'number', unit: 'mL' },
    { name: 'bufferType', label: 'Tampon Çözelti', type: 'text' },
  ]}},

  // ── Electrical ────────────────────────────────────────────────────────────
  { name: 'Fuel Tank', code: 'fuel-tank', description: 'Yakıt deposu', specificationSchema: { fields: [
    { name: 'capacity', label: 'Kapasite', type: 'number', unit: 'L', required: true },
    { name: 'fuelType', label: 'Yakıt Tipi', type: 'select', options: [{ value: 'diesel', label: 'Dizel' }, { value: 'gasoline', label: 'Benzin' }, { value: 'lpg', label: 'LPG' }] },
  ]}},
  { name: 'Transfer Switch', code: 'transfer-switch', description: 'Otomatik transfer şalteri', specificationSchema: { fields: [
    { name: 'ratedCurrent', label: 'Anma Akımı', type: 'number', unit: 'A' },
    { name: 'transferType', label: 'Transfer Tipi', type: 'select', options: [{ value: 'automatic', label: 'Otomatik' }, { value: 'manual', label: 'Manuel' }] },
  ]}},
  { name: 'Control Panel', code: 'control-panel', description: 'Kontrol panosu', specificationSchema: { fields: [
    { name: 'ipRating', label: 'IP Sınıfı', type: 'text', placeholder: 'ör. IP54' },
    { name: 'hasPlc', label: 'PLC Var mı', type: 'boolean', defaultValue: false },
  ]}},
];

/**
 * Seedable sub-equipment catalogue. `compatibleEquipmentTypes` is computed by
 * inverting `EQUIPMENT_TYPES_SEED`, so the pairing an operator sees in the setup
 * UI is by construction the pairing `CreateSubEquipmentHandler` accepts.
 */
export const SUB_EQUIPMENT_TYPES_SEED: SubEquipmentTypeSeed[] = buildSubEquipmentTypeSeed(
  EQUIPMENT_TYPES_SEED,
  SUB_EQUIPMENT_TYPE_DECLARATIONS,
);
