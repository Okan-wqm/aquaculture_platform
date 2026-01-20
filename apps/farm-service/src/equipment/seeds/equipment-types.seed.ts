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
    allowedSubEquipmentTypes: ['inlet', 'outlet', 'drain', 'feeder', 'fish-trap', 'aerator', 'sensor-probe'],
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
    allowedSubEquipmentTypes: ['inlet', 'outlet', 'drain', 'feeder', 'fish-trap', 'aerator', 'sensor-probe'],
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
    allowedSubEquipmentTypes: ['inlet', 'outlet', 'drain', 'feeder', 'fish-trap', 'aerator', 'screen'],
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

  // ============================================
  // PUMP Category - Pompa tipleri
  // ============================================
  {
    name: 'Centrifugal Pump',
    code: 'pump-centrifugal',
    description: 'Santrifüj su pompası',
    category: EquipmentCategory.PUMP,
    icon: 'pump',
    sortOrder: 10,
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
    sortOrder: 11,
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
    sortOrder: 52,
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
    sortOrder: 70,
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
    sortOrder: 71,
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

export const SUB_EQUIPMENT_TYPES_SEED = [
  // Tank sub-equipment
  { name: 'Inlet', code: 'inlet', description: 'Su girişi', compatibleEquipmentTypes: ['fish-tank', 'raceway', 'biofilter'], specificationSchema: { fields: [
    { name: 'diameter', label: 'Çap', type: 'number', unit: 'mm', required: true },
    { name: 'material', label: 'Malzeme', type: 'select', options: [{ value: 'pvc', label: 'PVC' }, { value: 'hdpe', label: 'HDPE' }] },
  ]}},
  { name: 'Outlet', code: 'outlet', description: 'Su çıkışı', compatibleEquipmentTypes: ['fish-tank', 'raceway', 'biofilter'], specificationSchema: { fields: [
    { name: 'diameter', label: 'Çap', type: 'number', unit: 'mm', required: true },
    { name: 'type', label: 'Tip', type: 'select', options: [{ value: 'center', label: 'Merkez' }, { value: 'side', label: 'Yan' }, { value: 'overflow', label: 'Taşma' }] },
  ]}},
  { name: 'Drain', code: 'drain', description: 'Drenaj', compatibleEquipmentTypes: ['fish-tank', 'raceway'], specificationSchema: { fields: [
    { name: 'diameter', label: 'Çap', type: 'number', unit: 'mm', required: true },
    { name: 'valveType', label: 'Vana Tipi', type: 'select', options: [{ value: 'standpipe', label: 'Standpipe' }, { value: 'external', label: 'Harici' }] },
  ]}},
  { name: 'Feeder', code: 'feeder', description: 'Yemleme noktası', compatibleEquipmentTypes: ['fish-tank', 'raceway'], specificationSchema: { fields: [
    { name: 'type', label: 'Tip', type: 'select', options: [{ value: 'manual', label: 'Manuel' }, { value: 'automatic', label: 'Otomatik' }] },
    { name: 'capacity', label: 'Kapasite', type: 'number', unit: 'kg' },
  ]}},
  { name: 'Fish Trap', code: 'fish-trap', description: 'Balık toplama kapanı', compatibleEquipmentTypes: ['fish-tank', 'raceway'], specificationSchema: { fields: [
    { name: 'size', label: 'Boyut', type: 'text' },
    { name: 'material', label: 'Malzeme', type: 'text' },
  ]}},
  { name: 'Aerator', code: 'aerator', description: 'Havalandırma noktası', compatibleEquipmentTypes: ['fish-tank', 'raceway', 'biofilter'], specificationSchema: { fields: [
    { name: 'type', label: 'Tip', type: 'select', options: [{ value: 'diffuser', label: 'Difüzör' }, { value: 'air_stone', label: 'Hava Taşı' }] },
    { name: 'airFlow', label: 'Hava Debisi', type: 'number', unit: 'L/min' },
  ]}},
  { name: 'Sensor Probe', code: 'sensor-probe', description: 'Sensör probu', compatibleEquipmentTypes: ['fish-tank', 'raceway'], specificationSchema: { fields: [
    { name: 'parameter', label: 'Parametre', type: 'select', options: [{ value: 'do', label: 'DO' }, { value: 'ph', label: 'pH' }, { value: 'temp', label: 'Sıcaklık' }] },
  ]}},
  { name: 'Screen', code: 'screen', description: 'Elek/Izgara', compatibleEquipmentTypes: ['raceway', 'drum-filter'], specificationSchema: { fields: [
    { name: 'meshSize', label: 'Elek Açıklığı', type: 'number', unit: 'mm' },
    { name: 'material', label: 'Malzeme', type: 'text' },
  ]}},

  // Pump sub-equipment
  { name: 'Inlet Valve', code: 'inlet-valve', description: 'Giriş vanası', compatibleEquipmentTypes: ['water-pump', 'heat-exchanger', 'drum-filter', 'biofilter', 'uv-sterilizer', 'chiller'], specificationSchema: { fields: [
    { name: 'size', label: 'Boyut', type: 'number', unit: 'mm' },
    { name: 'type', label: 'Tip', type: 'select', options: [{ value: 'gate', label: 'Sürgülü' }, { value: 'ball', label: 'Küresel' }, { value: 'butterfly', label: 'Kelebek' }] },
  ]}},
  { name: 'Outlet Valve', code: 'outlet-valve', description: 'Çıkış vanası', compatibleEquipmentTypes: ['water-pump', 'heat-exchanger', 'drum-filter', 'biofilter', 'uv-sterilizer', 'chiller'], specificationSchema: { fields: [
    { name: 'size', label: 'Boyut', type: 'number', unit: 'mm' },
    { name: 'type', label: 'Tip', type: 'select', options: [{ value: 'gate', label: 'Sürgülü' }, { value: 'ball', label: 'Küresel' }, { value: 'butterfly', label: 'Kelebek' }] },
  ]}},
  { name: 'Pressure Gauge', code: 'pressure-gauge', description: 'Basınç göstergesi', compatibleEquipmentTypes: ['water-pump', 'blower', 'drum-filter'], specificationSchema: { fields: [
    { name: 'range', label: 'Aralık', type: 'text' },
    { name: 'unit', label: 'Birim', type: 'select', options: [{ value: 'bar', label: 'bar' }, { value: 'psi', label: 'psi' }, { value: 'mbar', label: 'mbar' }] },
  ]}},
  { name: 'Flowmeter', code: 'flowmeter', description: 'Debimetre', compatibleEquipmentTypes: ['water-pump', 'heat-exchanger'], specificationSchema: { fields: [
    { name: 'range', label: 'Aralık', type: 'text' },
    { name: 'type', label: 'Tip', type: 'select', options: [{ value: 'electromagnetic', label: 'Elektromanyetik' }, { value: 'ultrasonic', label: 'Ultrasonik' }, { value: 'mechanical', label: 'Mekanik' }] },
  ]}},

  // Blower sub-equipment
  { name: 'Air Filter', code: 'air-filter', description: 'Hava filtresi', compatibleEquipmentTypes: ['blower'], specificationSchema: { fields: [
    { name: 'filterClass', label: 'Filtre Sınıfı', type: 'text' },
  ]}},
  { name: 'Silencer', code: 'silencer', description: 'Susturucu', compatibleEquipmentTypes: ['blower'], specificationSchema: { fields: [
    { name: 'noiseReduction', label: 'Gürültü Azaltma', type: 'number', unit: 'dB' },
  ]}},
  { name: 'Check Valve', code: 'check-valve', description: 'Çek valf', compatibleEquipmentTypes: ['blower', 'water-pump'], specificationSchema: { fields: [
    { name: 'size', label: 'Boyut', type: 'number', unit: 'mm' },
  ]}},

  // Feeder sub-equipment
  { name: 'Hopper', code: 'hopper', description: 'Yem haznesi', compatibleEquipmentTypes: ['auto-feeder'], specificationSchema: { fields: [
    { name: 'capacity', label: 'Kapasite', type: 'number', unit: 'kg' },
  ]}},
  { name: 'Spreading Disc', code: 'spreading-disc', description: 'Yayıcı disk', compatibleEquipmentTypes: ['auto-feeder'], specificationSchema: { fields: [
    { name: 'diameter', label: 'Çap', type: 'number', unit: 'cm' },
  ]}},

  // UV sub-equipment
  { name: 'UV Lamp', code: 'uv-lamp', description: 'UV lambası', compatibleEquipmentTypes: ['uv-sterilizer'], specificationSchema: { fields: [
    { name: 'power', label: 'Güç', type: 'number', unit: 'W' },
    { name: 'lifeHours', label: 'Ömür', type: 'number', unit: 'saat' },
  ]}},
  { name: 'Quartz Sleeve', code: 'quartz-sleeve', description: 'Kuvars kılıf', compatibleEquipmentTypes: ['uv-sterilizer'], specificationSchema: { fields: [
    { name: 'length', label: 'Uzunluk', type: 'number', unit: 'mm' },
    { name: 'diameter', label: 'Çap', type: 'number', unit: 'mm' },
  ]}},

  // Heat exchanger sub-equipment
  { name: 'Temperature Sensor', code: 'temperature-sensor', description: 'Sıcaklık sensörü', compatibleEquipmentTypes: ['heat-exchanger', 'chiller'], specificationSchema: { fields: [
    { name: 'type', label: 'Tip', type: 'select', options: [{ value: 'pt100', label: 'PT100' }, { value: 'thermocouple', label: 'Termokupl' }] },
    { name: 'range', label: 'Aralık', type: 'text' },
  ]}},
];
