/**
 * SCADA Nodes Panel Component
 * Left sidebar for dragging equipment type templates onto the process editor canvas
 * These are generic node templates, not actual equipment from database
 */

import React, { useState, useMemo } from 'react';
import { Search, ChevronDown, ChevronRight, GripVertical, Activity, LineChart, BarChart2, Gauge, Hash } from 'lucide-react';
import { useEquipmentTypes, EquipmentType, CATEGORY_LABELS } from '../../../hooks/useEquipment';
import { getEquipmentIcon } from '../../equipment-icons';

// Generic Sensor node template (not from farm-service)
const SENSOR_NODE_TEMPLATE = {
  id: 'sensor-node-template',
  name: 'Sensor',
  code: 'SENSOR',
  category: 'monitoring',
  description: 'Generic sensor node - link to real sensors via Properties panel',
};

// Connection Point node template (not from farm-service)
const CONNECTION_POINT_TEMPLATE = {
  id: 'connection-point-template',
  name: 'Connection Point',
  code: 'CONNECTION_POINT',
  category: 'utility',
  nodeType: 'connectionPoint',
  description: '4-way pipe junction for connecting equipment',
};

// Algae Bag node templates (not from farm-service)
const ALGAE_BAG_TEMPLATES = [
  {
    id: 'algae-bag-red',
    name: 'Rhodomonas Bag',
    code: 'ALGAE_BAG_RED',
    category: 'algae',
    nodeType: 'algaeBagRed',
    color: '#FFB6C1',
    description: 'Pink algae cultivation bag (Rhodomonas)',
  },
  {
    id: 'algae-bag-green',
    name: 'Chlorella Bag',
    code: 'ALGAE_BAG_GREEN',
    category: 'algae',
    nodeType: 'algaeBagGreen',
    color: '#90EE90',
    description: 'Green algae cultivation bag (Chlorella)',
  },
  {
    id: 'algae-bag-yellow',
    name: 'Dunaliella Bag',
    code: 'ALGAE_BAG_YELLOW',
    category: 'algae',
    nodeType: 'algaeBagYellow',
    color: '#FFD700',
    description: 'Yellow algae cultivation bag (Dunaliella)',
  },
];

// Chart Widget template - single widget, type selected in config modal
const CHART_WIDGET_TEMPLATE = {
  id: 'widget-chart',
  name: 'Chart Widget',
  code: 'CHART_WIDGET',
  category: 'widgets',
  nodeType: 'chartWidget',
  icon: 'BarChart2',
  description: 'Add chart to visualize sensor data',
  defaultWidth: 320,
  defaultHeight: 200,
};

// Ultrafiltration node template (membrane filtration unit)
const ULTRAFILTRATION_TEMPLATE = {
  id: 'ultrafiltration-template',
  name: 'Ultrafiltration',
  code: 'ULTRAFILTRATION',
  category: 'filtration',
  nodeType: 'ultrafiltration',
  description: 'Membrane filtration unit with 9 connection points',
};

// Dual Drain Tank node template (polypropylene tank)
const DUAL_DRAIN_TANK_TEMPLATE = {
  id: 'dual-drain-tank-template',
  name: 'Dual Drain Tank',
  code: 'DUAL_DRAIN_TANK',
  category: 'tank',
  nodeType: 'dualDrainTank',
  description: 'Polypropylene tank with side box and dual bottom drains',
};

// Radial Filter node template (conical settling tank)
const RADIAL_FILTER_TEMPLATE = {
  id: 'radial-filter-template',
  name: 'Radial Filter',
  code: 'RADIAL_FILTER',
  category: 'filtration',
  nodeType: 'radialSettler',
  description: 'Conical settling tank with stilling well and sludge drain',
};

// Clean Water Tank node template
const CLEAN_WATER_TANK_TEMPLATE = {
  id: 'clean-water-tank-template',
  name: 'Clean Water Tank',
  code: 'CLEAN_WATER_TANK',
  category: 'tank',
  nodeType: 'cleanWaterTank',
  description: 'Storage tank for clean/treated water',
};

// Dirty Water Tank node template
const DIRTY_WATER_TANK_TEMPLATE = {
  id: 'dirty-water-tank-template',
  name: 'Dirty Water Tank',
  code: 'DIRTY_WATER_TANK',
  category: 'tank',
  nodeType: 'dirtyWaterTank',
  description: 'Storage tank for dirty/waste water with sediment',
};

// Water Supply node template (water source inlet)
const WATER_SUPPLY_TEMPLATE = {
  id: 'water-supply-template',
  name: 'Water Supply',
  code: 'WATER_SUPPLY',
  category: 'utility',
  nodeType: 'waterSupply',
  description: 'Water source inlet with single outlet connection',
};

// Water Discharge node template (water outlet/drain)
const WATER_DISCHARGE_TEMPLATE = {
  id: 'water-discharge-template',
  name: 'Water Discharge',
  code: 'WATER_DISCHARGE',
  category: 'utility',
  nodeType: 'waterDischarge',
  description: 'Water discharge outlet with single inlet connection',
};

// MBBR node template (Moving Bed Biofilm Reactor)
const MBBR_TEMPLATE = {
  id: 'mbbr-template',
  name: 'MBBR',
  code: 'MBBR',
  category: 'filtration',
  nodeType: 'mbbr',
  description: 'Moving Bed Biofilm Reactor with carrier media and aeration',
};

// HEPA Filter node template (High Efficiency Particulate Air filter)
const HEPA_FILTER_TEMPLATE = {
  id: 'hepa-filter-template',
  name: 'HEPA Filter',
  code: 'HEPA_FILTER',
  category: 'filtration',
  nodeType: 'hepaFilter',
  description: 'High Efficiency Particulate Air filter with pleated media',
};

// Dosing Pump node template (peristaltic chemical dosing pump)
const DOSING_PUMP_TEMPLATE = {
  id: 'dosing-pump-template',
  name: 'Dosing Pump',
  code: 'DOSING_PUMP',
  category: 'pump',
  nodeType: 'dosingPump',
  description: 'Peristaltic pump for precise chemical dosing with flow control',
};

// Heater node template (water heater with heating elements)
const HEATER_TEMPLATE = {
  id: 'heater-template',
  name: 'Heater',
  code: 'HEATER',
  category: 'heating',
  nodeType: 'heater',
  description: 'Water heater with heating elements and control panel',
};

// Shell and Tube Heat Exchanger node template
const SHELL_AND_TUBE_HX_TEMPLATE = {
  id: 'shell-and-tube-hx-template',
  name: 'Shell & Tube HX',
  code: 'SHELL_TUBE_HX',
  category: 'heating',
  nodeType: 'shellAndTubeHeatExchanger',
  description: 'Industrial shell and tube heat exchanger with 4 ports',
};

// Plate Heat Exchanger node template
const PLATE_HX_TEMPLATE = {
  id: 'plate-hx-template',
  name: 'Plate Heat Exchanger',
  code: 'PLATE_HX',
  category: 'heating',
  nodeType: 'plateHeatExchanger',
  description: 'Compact plate heat exchanger with hot/cold channels',
};

// Chiller node template (water chiller with cooling)
const CHILLER_TEMPLATE = {
  id: 'chiller-template',
  name: 'Chiller',
  code: 'CHILLER',
  category: 'cooling',
  nodeType: 'chiller',
  description: 'Water chiller with cooling fan and compressor',
};

// Gas Generator node template (with ATS panel)
const GAS_GENERATOR_TEMPLATE = {
  id: 'gas-generator-template',
  name: 'Gas Generator',
  code: 'GAS_GENERATOR',
  category: 'power',
  nodeType: 'gasGenerator',
  description: 'Gas-powered generator with ATS panel and 7 connection points',
};

// Diesel Generator node template (with ATS panel)
const DIESEL_GENERATOR_TEMPLATE = {
  id: 'diesel-generator-template',
  name: 'Diesel Generator',
  code: 'DIESEL_GENERATOR',
  category: 'power',
  nodeType: 'dieselGenerator',
  description: 'Diesel-powered generator with ATS panel and fuel tank',
};

// Node template data structure for drag-and-drop
export interface NodeTemplate {
  id: string;
  name: string;
  code: string;
  category: string;
  icon?: string;
  equipmentType: EquipmentType;
}

interface EquipmentPanelProps {
  onDragStart: (event: React.DragEvent, template: NodeTemplate) => void;
}

// Group equipment types by category
function groupTypesByCategory(types: EquipmentType[]): Record<string, EquipmentType[]> {
  return types.reduce((acc, type) => {
    const category = type.category?.toLowerCase() || 'other';
    if (!acc[category]) {
      acc[category] = [];
    }
    acc[category].push(type);
    return acc;
  }, {} as Record<string, EquipmentType[]>);
}

export const EquipmentPanel: React.FC<EquipmentPanelProps> = ({ onDragStart }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(['monitoring', 'utility', 'algae', 'widgets', 'scada-nodes', 'tank', 'pump', 'filtration', 'aeration'])
  );

  // Fetch equipment TYPES (templates) from farm-service
  const { data: equipmentTypes, isLoading, error } = useEquipmentTypes({ isActive: true });

  // Filter and group equipment types
  // Note: Filter out monitoring/sensor categories as we use a single generic Sensor node instead
  const groupedTypes = useMemo(() => {
    if (!equipmentTypes) return {};

    // Categories to exclude (we use generic Sensor node for these)
    const excludedCategories = ['monitoring', 'sensor', 'sensors'];

    const filtered = equipmentTypes.filter((type) => {
      const category = type.category?.toLowerCase() || '';
      const code = type.code?.toLowerCase() || '';

      // Exclude monitoring category, sensor category, and sensor-* codes
      const isExcludedCategory = excludedCategories.includes(category) ||
        category.includes('monitor') ||
        category.includes('sensor');
      const isSensorCode = code.startsWith('sensor-') || code.startsWith('sensor_');

      if (isExcludedCategory || isSensorCode) {
        return false;
      }

      // Apply search filter if present
      if (searchTerm) {
        return type.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
               type.code.toLowerCase().includes(searchTerm.toLowerCase());
      }

      return true;
    });

    return groupTypesByCategory(filtered);
  }, [equipmentTypes, searchTerm]);

  const toggleCategory = (category: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) {
        next.delete(category);
      } else {
        next.add(category);
      }
      return next;
    });
  };

  const handleDragStart = (event: React.DragEvent, type: EquipmentType) => {
    // Create a node template from the equipment type
    const template: NodeTemplate = {
      id: `template-${type.id}`,
      name: type.name,
      code: type.code,
      category: type.category,
      icon: type.icon,
      equipmentType: type,
    };

    event.dataTransfer.setData('application/equipment', JSON.stringify(template));
    event.dataTransfer.effectAllowed = 'move';
    onDragStart(event, template);
  };

  return (
    <div className="equipment-panel w-72 bg-white border-r border-gray-200 flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-gray-200">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">SCADA Nodes</h3>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search node types..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* Equipment Types List */}
      <div className="flex-1 overflow-y-auto p-2">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full" />
          </div>
        )}

        {error && (
          <div className="p-4 text-center text-red-600 text-sm">
            Failed to load node types. Please try again.
          </div>
        )}

        {!isLoading && !error && Object.keys(groupedTypes).length === 0 && !searchTerm && (
          <div className="p-4 text-center text-gray-500 text-sm">
            No equipment types available.
          </div>
        )}

        {/* Monitoring Section - Single generic Sensor node */}
        {(!searchTerm || 'sensor'.includes(searchTerm.toLowerCase())) && (
          <div className="mb-2">
            {/* Category Header */}
            <button
              onClick={() => toggleCategory('monitoring')}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              {expandedCategories.has('monitoring') ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              <span>Monitoring</span>
              <span className="ml-auto text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                1
              </span>
            </button>

            {/* Sensor Node Template */}
            {expandedCategories.has('monitoring') && (
              <div className="ml-2 space-y-1">
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: SENSOR_NODE_TEMPLATE.id,
                      name: SENSOR_NODE_TEMPLATE.name,
                      code: SENSOR_NODE_TEMPLATE.code,
                      category: SENSOR_NODE_TEMPLATE.category,
                      equipmentType: {
                        id: SENSOR_NODE_TEMPLATE.id,
                        name: SENSOR_NODE_TEMPLATE.name,
                        code: SENSOR_NODE_TEMPLATE.code,
                        category: SENSOR_NODE_TEMPLATE.category,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-green-50 hover:bg-green-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-green-200"
                >
                  {/* Drag Handle */}
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />

                  {/* Icon */}
                  <div className="text-green-600 group-hover:text-green-700">
                    <Activity size={20} />
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">
                      {SENSOR_NODE_TEMPLATE.name}
                    </div>
                    <div className="text-xs text-gray-500 truncate">
                      Link real sensors via Properties
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Utility Section - Connection Point */}
        {(!searchTerm || 'connection point utility'.includes(searchTerm.toLowerCase())) && (
          <div className="mb-2">
            {/* Category Header */}
            <button
              onClick={() => toggleCategory('utility')}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              {expandedCategories.has('utility') ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              <span>Utility</span>
              <span className="ml-auto text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                1
              </span>
            </button>

            {/* Connection Point Template */}
            {expandedCategories.has('utility') && (
              <div className="ml-2 space-y-1">
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: CONNECTION_POINT_TEMPLATE.id,
                      name: CONNECTION_POINT_TEMPLATE.name,
                      code: CONNECTION_POINT_TEMPLATE.code,
                      category: CONNECTION_POINT_TEMPLATE.category,
                      equipmentType: {
                        id: CONNECTION_POINT_TEMPLATE.id,
                        name: CONNECTION_POINT_TEMPLATE.name,
                        code: CONNECTION_POINT_TEMPLATE.code,
                        category: CONNECTION_POINT_TEMPLATE.category,
                        nodeType: CONNECTION_POINT_TEMPLATE.nodeType,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-yellow-50 hover:bg-yellow-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-yellow-200"
                >
                  {/* Drag Handle */}
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />

                  {/* Icon - Circle representing connection point */}
                  <div className="w-5 h-5 rounded-full bg-yellow-400 border-2 border-yellow-600" />

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">
                      {CONNECTION_POINT_TEMPLATE.name}
                    </div>
                    <div className="text-xs text-gray-500 truncate">
                      {CONNECTION_POINT_TEMPLATE.description}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Algae Cultivation Section */}
        {(!searchTerm || 'algae'.includes(searchTerm.toLowerCase()) ||
          ALGAE_BAG_TEMPLATES.some(t => t.name.toLowerCase().includes(searchTerm.toLowerCase()))) && (
          <div className="mb-2">
            {/* Category Header */}
            <button
              onClick={() => toggleCategory('algae')}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              {expandedCategories.has('algae') ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              <span>Algae Cultivation</span>
              <span className="ml-auto text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                {ALGAE_BAG_TEMPLATES.length}
              </span>
            </button>

            {/* Algae Bag Templates */}
            {expandedCategories.has('algae') && (
              <div className="ml-2 space-y-1">
                {ALGAE_BAG_TEMPLATES.map((bag) => (
                  <div
                    key={bag.id}
                    draggable
                    onDragStart={(e) => {
                      const template: NodeTemplate = {
                        id: bag.id,
                        name: bag.name,
                        code: bag.code,
                        category: bag.category,
                        equipmentType: {
                          id: bag.id,
                          name: bag.name,
                          code: bag.code,
                          category: bag.category,
                          nodeType: bag.nodeType,
                        } as EquipmentType,
                      };
                      e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                      e.dataTransfer.effectAllowed = 'move';
                      onDragStart(e, template);
                    }}
                    className="flex items-center gap-2 px-3 py-2 bg-gray-50 hover:bg-emerald-50 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-emerald-200"
                  >
                    {/* Drag Handle */}
                    <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />

                    {/* Color indicator */}
                    <div
                      className="w-5 h-5 rounded-full border-2 border-white shadow-sm"
                      style={{ backgroundColor: bag.color }}
                    />

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">
                        {bag.name}
                      </div>
                      <div className="text-xs text-gray-500 truncate">
                        {bag.description}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Widgets Section - Single Chart Widget */}
        {(!searchTerm || 'widget chart graph gauge line area stat'.includes(searchTerm.toLowerCase()) ||
          CHART_WIDGET_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase())) && (
          <div className="mb-2">
            {/* Category Header */}
            <button
              onClick={() => toggleCategory('widgets')}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              {expandedCategories.has('widgets') ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              <span>Widgets</span>
              <span className="ml-auto text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                1
              </span>
            </button>

            {/* Single Widget Template */}
            {expandedCategories.has('widgets') && (
              <div className="ml-2 space-y-1">
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: CHART_WIDGET_TEMPLATE.id,
                      name: CHART_WIDGET_TEMPLATE.name,
                      code: CHART_WIDGET_TEMPLATE.code,
                      category: CHART_WIDGET_TEMPLATE.category,
                      equipmentType: {
                        id: CHART_WIDGET_TEMPLATE.id,
                        name: CHART_WIDGET_TEMPLATE.name,
                        code: CHART_WIDGET_TEMPLATE.code,
                        category: CHART_WIDGET_TEMPLATE.category,
                        nodeType: CHART_WIDGET_TEMPLATE.nodeType,
                        isActive: true,
                        sortOrder: 0,
                        defaultWidth: CHART_WIDGET_TEMPLATE.defaultWidth,
                        defaultHeight: CHART_WIDGET_TEMPLATE.defaultHeight,
                      } as EquipmentType & { defaultWidth: number; defaultHeight: number },
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-cyan-50 hover:bg-cyan-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-cyan-200"
                >
                  {/* Drag Handle */}
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />

                  {/* Icon */}
                  <div className="text-cyan-600 group-hover:text-cyan-700">
                    <BarChart2 size={20} />
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">
                      {CHART_WIDGET_TEMPLATE.name}
                    </div>
                    <div className="text-xs text-gray-500 truncate">
                      {CHART_WIDGET_TEMPLATE.description}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* SCADA Specialized Nodes Section */}
        {(!searchTerm || 'ultrafiltration dual drain tank filtration scada radial filter settler clean dirty water heater heat exchanger chiller cooling generator gas diesel power ats'.includes(searchTerm.toLowerCase()) ||
          ULTRAFILTRATION_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          DUAL_DRAIN_TANK_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          RADIAL_FILTER_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          CLEAN_WATER_TANK_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          DIRTY_WATER_TANK_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          WATER_SUPPLY_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          WATER_DISCHARGE_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          MBBR_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          HEPA_FILTER_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          DOSING_PUMP_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          HEATER_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          SHELL_AND_TUBE_HX_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          PLATE_HX_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          CHILLER_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          GAS_GENERATOR_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
          DIESEL_GENERATOR_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase())) && (
          <div className="mb-2">
            {/* Category Header */}
            <button
              onClick={() => toggleCategory('scada-nodes')}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              {expandedCategories.has('scada-nodes') ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              <span>SCADA Nodes</span>
              <span className="ml-auto text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                16
              </span>
            </button>

            {/* SCADA Node Templates */}
            {expandedCategories.has('scada-nodes') && (
              <div className="ml-2 space-y-1">
                {/* Ultrafiltration */}
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: ULTRAFILTRATION_TEMPLATE.id,
                      name: ULTRAFILTRATION_TEMPLATE.name,
                      code: ULTRAFILTRATION_TEMPLATE.code,
                      category: ULTRAFILTRATION_TEMPLATE.category,
                      equipmentType: {
                        id: ULTRAFILTRATION_TEMPLATE.id,
                        name: ULTRAFILTRATION_TEMPLATE.name,
                        code: ULTRAFILTRATION_TEMPLATE.code,
                        category: ULTRAFILTRATION_TEMPLATE.category,
                        nodeType: ULTRAFILTRATION_TEMPLATE.nodeType,
                        isActive: true,
                        sortOrder: 0,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-blue-50 hover:bg-blue-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-blue-200"
                >
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />
                  <div className="w-5 h-5 bg-blue-500 rounded text-white text-xs flex items-center justify-center font-bold">UF</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{ULTRAFILTRATION_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{ULTRAFILTRATION_TEMPLATE.description}</div>
                  </div>
                </div>

                {/* Dual Drain Tank */}
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: DUAL_DRAIN_TANK_TEMPLATE.id,
                      name: DUAL_DRAIN_TANK_TEMPLATE.name,
                      code: DUAL_DRAIN_TANK_TEMPLATE.code,
                      category: DUAL_DRAIN_TANK_TEMPLATE.category,
                      equipmentType: {
                        id: DUAL_DRAIN_TANK_TEMPLATE.id,
                        name: DUAL_DRAIN_TANK_TEMPLATE.name,
                        code: DUAL_DRAIN_TANK_TEMPLATE.code,
                        category: DUAL_DRAIN_TANK_TEMPLATE.category,
                        nodeType: DUAL_DRAIN_TANK_TEMPLATE.nodeType,
                        isActive: true,
                        sortOrder: 0,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-amber-50 hover:bg-amber-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-amber-200"
                >
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />
                  <div className="w-5 h-5 bg-amber-500 rounded text-white text-xs flex items-center justify-center font-bold">DD</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{DUAL_DRAIN_TANK_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{DUAL_DRAIN_TANK_TEMPLATE.description}</div>
                  </div>
                </div>

                {/* Radial Filter */}
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: RADIAL_FILTER_TEMPLATE.id,
                      name: RADIAL_FILTER_TEMPLATE.name,
                      code: RADIAL_FILTER_TEMPLATE.code,
                      category: RADIAL_FILTER_TEMPLATE.category,
                      equipmentType: {
                        id: RADIAL_FILTER_TEMPLATE.id,
                        name: RADIAL_FILTER_TEMPLATE.name,
                        code: RADIAL_FILTER_TEMPLATE.code,
                        category: RADIAL_FILTER_TEMPLATE.category,
                        nodeType: RADIAL_FILTER_TEMPLATE.nodeType,
                        isActive: true,
                        sortOrder: 0,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-teal-50 hover:bg-teal-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-teal-200"
                >
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />
                  <div className="w-5 h-5 bg-teal-500 rounded text-white text-xs flex items-center justify-center font-bold">RF</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{RADIAL_FILTER_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{RADIAL_FILTER_TEMPLATE.description}</div>
                  </div>
                </div>

                {/* Clean Water Tank */}
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: CLEAN_WATER_TANK_TEMPLATE.id,
                      name: CLEAN_WATER_TANK_TEMPLATE.name,
                      code: CLEAN_WATER_TANK_TEMPLATE.code,
                      category: CLEAN_WATER_TANK_TEMPLATE.category,
                      equipmentType: {
                        id: CLEAN_WATER_TANK_TEMPLATE.id,
                        name: CLEAN_WATER_TANK_TEMPLATE.name,
                        code: CLEAN_WATER_TANK_TEMPLATE.code,
                        category: CLEAN_WATER_TANK_TEMPLATE.category,
                        nodeType: CLEAN_WATER_TANK_TEMPLATE.nodeType,
                        isActive: true,
                        sortOrder: 0,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-cyan-50 hover:bg-cyan-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-cyan-200"
                >
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />
                  <div className="w-5 h-5 bg-cyan-500 rounded text-white text-xs flex items-center justify-center font-bold">CW</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{CLEAN_WATER_TANK_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{CLEAN_WATER_TANK_TEMPLATE.description}</div>
                  </div>
                </div>

                {/* Dirty Water Tank */}
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: DIRTY_WATER_TANK_TEMPLATE.id,
                      name: DIRTY_WATER_TANK_TEMPLATE.name,
                      code: DIRTY_WATER_TANK_TEMPLATE.code,
                      category: DIRTY_WATER_TANK_TEMPLATE.category,
                      equipmentType: {
                        id: DIRTY_WATER_TANK_TEMPLATE.id,
                        name: DIRTY_WATER_TANK_TEMPLATE.name,
                        code: DIRTY_WATER_TANK_TEMPLATE.code,
                        category: DIRTY_WATER_TANK_TEMPLATE.category,
                        nodeType: DIRTY_WATER_TANK_TEMPLATE.nodeType,
                        isActive: true,
                        sortOrder: 0,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-stone-50 hover:bg-stone-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-stone-300"
                >
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />
                  <div className="w-5 h-5 bg-stone-500 rounded text-white text-xs flex items-center justify-center font-bold">DW</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{DIRTY_WATER_TANK_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{DIRTY_WATER_TANK_TEMPLATE.description}</div>
                  </div>
                </div>

                {/* Water Supply */}
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: WATER_SUPPLY_TEMPLATE.id,
                      name: WATER_SUPPLY_TEMPLATE.name,
                      code: WATER_SUPPLY_TEMPLATE.code,
                      category: WATER_SUPPLY_TEMPLATE.category,
                      equipmentType: {
                        id: WATER_SUPPLY_TEMPLATE.id,
                        name: WATER_SUPPLY_TEMPLATE.name,
                        code: WATER_SUPPLY_TEMPLATE.code,
                        category: WATER_SUPPLY_TEMPLATE.category,
                        nodeType: WATER_SUPPLY_TEMPLATE.nodeType,
                        isActive: true,
                        sortOrder: 0,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-sky-50 hover:bg-sky-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-sky-200"
                >
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />
                  <div className="w-5 h-5 bg-sky-500 rounded text-white text-xs flex items-center justify-center font-bold">WS</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{WATER_SUPPLY_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{WATER_SUPPLY_TEMPLATE.description}</div>
                  </div>
                </div>

                {/* Water Discharge */}
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: WATER_DISCHARGE_TEMPLATE.id,
                      name: WATER_DISCHARGE_TEMPLATE.name,
                      code: WATER_DISCHARGE_TEMPLATE.code,
                      category: WATER_DISCHARGE_TEMPLATE.category,
                      equipmentType: {
                        id: WATER_DISCHARGE_TEMPLATE.id,
                        name: WATER_DISCHARGE_TEMPLATE.name,
                        code: WATER_DISCHARGE_TEMPLATE.code,
                        category: WATER_DISCHARGE_TEMPLATE.category,
                        nodeType: WATER_DISCHARGE_TEMPLATE.nodeType,
                        isActive: true,
                        sortOrder: 0,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-slate-50 hover:bg-slate-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-slate-300"
                >
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />
                  <div className="w-5 h-5 bg-slate-500 rounded text-white text-xs flex items-center justify-center font-bold">WD</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{WATER_DISCHARGE_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{WATER_DISCHARGE_TEMPLATE.description}</div>
                  </div>
                </div>

                {/* MBBR */}
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: MBBR_TEMPLATE.id,
                      name: MBBR_TEMPLATE.name,
                      code: MBBR_TEMPLATE.code,
                      category: MBBR_TEMPLATE.category,
                      equipmentType: {
                        id: MBBR_TEMPLATE.id,
                        name: MBBR_TEMPLATE.name,
                        code: MBBR_TEMPLATE.code,
                        category: MBBR_TEMPLATE.category,
                        nodeType: MBBR_TEMPLATE.nodeType,
                        isActive: true,
                        sortOrder: 0,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-emerald-50 hover:bg-emerald-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-emerald-200"
                >
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />
                  <div className="w-5 h-5 bg-emerald-500 rounded text-white text-xs flex items-center justify-center font-bold">MB</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{MBBR_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{MBBR_TEMPLATE.description}</div>
                  </div>
                </div>

                {/* HEPA Filter */}
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: HEPA_FILTER_TEMPLATE.id,
                      name: HEPA_FILTER_TEMPLATE.name,
                      code: HEPA_FILTER_TEMPLATE.code,
                      category: HEPA_FILTER_TEMPLATE.category,
                      equipmentType: {
                        id: HEPA_FILTER_TEMPLATE.id,
                        name: HEPA_FILTER_TEMPLATE.name,
                        code: HEPA_FILTER_TEMPLATE.code,
                        category: HEPA_FILTER_TEMPLATE.category,
                        nodeType: HEPA_FILTER_TEMPLATE.nodeType,
                        isActive: true,
                        sortOrder: 0,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-indigo-50 hover:bg-indigo-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-indigo-200"
                >
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />
                  <div className="w-5 h-5 bg-indigo-500 rounded text-white text-xs flex items-center justify-center font-bold">HF</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{HEPA_FILTER_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{HEPA_FILTER_TEMPLATE.description}</div>
                  </div>
                </div>

                {/* Dosing Pump */}
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: DOSING_PUMP_TEMPLATE.id,
                      name: DOSING_PUMP_TEMPLATE.name,
                      code: DOSING_PUMP_TEMPLATE.code,
                      category: DOSING_PUMP_TEMPLATE.category,
                      equipmentType: {
                        id: DOSING_PUMP_TEMPLATE.id,
                        name: DOSING_PUMP_TEMPLATE.name,
                        code: DOSING_PUMP_TEMPLATE.code,
                        category: DOSING_PUMP_TEMPLATE.category,
                        nodeType: DOSING_PUMP_TEMPLATE.nodeType,
                        isActive: true,
                        sortOrder: 0,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-purple-50 hover:bg-purple-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-purple-200"
                >
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />
                  <div className="w-5 h-5 bg-purple-500 rounded text-white text-xs flex items-center justify-center font-bold">DP</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{DOSING_PUMP_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{DOSING_PUMP_TEMPLATE.description}</div>
                  </div>
                </div>

                {/* Heater */}
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: HEATER_TEMPLATE.id,
                      name: HEATER_TEMPLATE.name,
                      code: HEATER_TEMPLATE.code,
                      category: HEATER_TEMPLATE.category,
                      equipmentType: {
                        id: HEATER_TEMPLATE.id,
                        name: HEATER_TEMPLATE.name,
                        code: HEATER_TEMPLATE.code,
                        category: HEATER_TEMPLATE.category,
                        nodeType: HEATER_TEMPLATE.nodeType,
                        isActive: true,
                        sortOrder: 0,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-red-50 hover:bg-red-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-red-200"
                >
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />
                  <div className="w-5 h-5 bg-red-500 rounded text-white text-xs flex items-center justify-center font-bold">HT</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{HEATER_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{HEATER_TEMPLATE.description}</div>
                  </div>
                </div>

                {/* Shell & Tube Heat Exchanger */}
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: SHELL_AND_TUBE_HX_TEMPLATE.id,
                      name: SHELL_AND_TUBE_HX_TEMPLATE.name,
                      code: SHELL_AND_TUBE_HX_TEMPLATE.code,
                      category: SHELL_AND_TUBE_HX_TEMPLATE.category,
                      equipmentType: {
                        id: SHELL_AND_TUBE_HX_TEMPLATE.id,
                        name: SHELL_AND_TUBE_HX_TEMPLATE.name,
                        code: SHELL_AND_TUBE_HX_TEMPLATE.code,
                        category: SHELL_AND_TUBE_HX_TEMPLATE.category,
                        nodeType: SHELL_AND_TUBE_HX_TEMPLATE.nodeType,
                        isActive: true,
                        sortOrder: 0,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-orange-50 hover:bg-orange-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-orange-200"
                >
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />
                  <div className="w-5 h-5 bg-orange-500 rounded text-white text-xs flex items-center justify-center font-bold">ST</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{SHELL_AND_TUBE_HX_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{SHELL_AND_TUBE_HX_TEMPLATE.description}</div>
                  </div>
                </div>

                {/* Plate Heat Exchanger */}
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: PLATE_HX_TEMPLATE.id,
                      name: PLATE_HX_TEMPLATE.name,
                      code: PLATE_HX_TEMPLATE.code,
                      category: PLATE_HX_TEMPLATE.category,
                      equipmentType: {
                        id: PLATE_HX_TEMPLATE.id,
                        name: PLATE_HX_TEMPLATE.name,
                        code: PLATE_HX_TEMPLATE.code,
                        category: PLATE_HX_TEMPLATE.category,
                        nodeType: PLATE_HX_TEMPLATE.nodeType,
                        isActive: true,
                        sortOrder: 0,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-amber-50 hover:bg-amber-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-amber-200"
                >
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />
                  <div className="w-5 h-5 bg-amber-500 rounded text-white text-xs flex items-center justify-center font-bold">PH</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{PLATE_HX_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{PLATE_HX_TEMPLATE.description}</div>
                  </div>
                </div>

                {/* Chiller */}
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: CHILLER_TEMPLATE.id,
                      name: CHILLER_TEMPLATE.name,
                      code: CHILLER_TEMPLATE.code,
                      category: CHILLER_TEMPLATE.category,
                      equipmentType: {
                        id: CHILLER_TEMPLATE.id,
                        name: CHILLER_TEMPLATE.name,
                        code: CHILLER_TEMPLATE.code,
                        category: CHILLER_TEMPLATE.category,
                        nodeType: CHILLER_TEMPLATE.nodeType,
                        isActive: true,
                        sortOrder: 0,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-sky-50 hover:bg-sky-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-sky-200"
                >
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />
                  <div className="w-5 h-5 bg-sky-500 rounded text-white text-xs flex items-center justify-center font-bold">CH</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{CHILLER_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{CHILLER_TEMPLATE.description}</div>
                  </div>
                </div>

                {/* Gas Generator */}
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: GAS_GENERATOR_TEMPLATE.id,
                      name: GAS_GENERATOR_TEMPLATE.name,
                      code: GAS_GENERATOR_TEMPLATE.code,
                      category: GAS_GENERATOR_TEMPLATE.category,
                      equipmentType: {
                        id: GAS_GENERATOR_TEMPLATE.id,
                        name: GAS_GENERATOR_TEMPLATE.name,
                        code: GAS_GENERATOR_TEMPLATE.code,
                        category: GAS_GENERATOR_TEMPLATE.category,
                        nodeType: GAS_GENERATOR_TEMPLATE.nodeType,
                        isActive: true,
                        sortOrder: 0,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-yellow-50 hover:bg-yellow-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-yellow-200"
                >
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />
                  <div className="w-5 h-5 bg-yellow-500 rounded text-white text-xs flex items-center justify-center font-bold">GG</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{GAS_GENERATOR_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{GAS_GENERATOR_TEMPLATE.description}</div>
                  </div>
                </div>

                {/* Diesel Generator */}
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: DIESEL_GENERATOR_TEMPLATE.id,
                      name: DIESEL_GENERATOR_TEMPLATE.name,
                      code: DIESEL_GENERATOR_TEMPLATE.code,
                      category: DIESEL_GENERATOR_TEMPLATE.category,
                      equipmentType: {
                        id: DIESEL_GENERATOR_TEMPLATE.id,
                        name: DIESEL_GENERATOR_TEMPLATE.name,
                        code: DIESEL_GENERATOR_TEMPLATE.code,
                        category: DIESEL_GENERATOR_TEMPLATE.category,
                        nodeType: DIESEL_GENERATOR_TEMPLATE.nodeType,
                        isActive: true,
                        sortOrder: 0,
                      } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-gray-100 hover:bg-gray-200 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-gray-300"
                >
                  <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />
                  <div className="w-5 h-5 bg-gray-600 rounded text-white text-xs flex items-center justify-center font-bold">DG</div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{DIESEL_GENERATOR_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{DIESEL_GENERATOR_TEMPLATE.description}</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Equipment Categories */}
        {Object.entries(groupedTypes).map(([category, types]) => (
          <div key={category} className="mb-2">
            {/* Category Header */}
            <button
              onClick={() => toggleCategory(category)}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
            >
              {expandedCategories.has(category) ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
              <span>{CATEGORY_LABELS[category] || category}</span>
              <span className="ml-auto text-xs text-gray-400 bg-gray-100 px-2 py-0.5 rounded-full">
                {types.length}
              </span>
            </button>

            {/* Equipment Type Items */}
            {expandedCategories.has(category) && (
              <div className="ml-2 space-y-1">
                {types.map((type) => {
                  const Icon = getEquipmentIcon(type.code);

                  return (
                    <div
                      key={type.id}
                      draggable
                      onDragStart={(e) => handleDragStart(e, type)}
                      className="flex items-center gap-2 px-3 py-2 bg-gray-50 hover:bg-blue-50 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-blue-200"
                    >
                      {/* Drag Handle */}
                      <GripVertical className="w-4 h-4 text-gray-300 group-hover:text-gray-400" />

                      {/* Icon */}
                      <div className="text-gray-600 group-hover:text-blue-600">
                        <Icon size={20} />
                      </div>

                      {/* Info */}
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-gray-900 truncate">
                          {type.name}
                        </div>
                        <div className="text-xs text-gray-500 truncate">{type.code}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-gray-200 bg-gray-50">
        <p className="text-xs text-gray-500 text-center">
          Drag nodes to canvas, then link real equipment
        </p>
      </div>
    </div>
  );
};

export default EquipmentPanel;
