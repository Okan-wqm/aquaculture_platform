/**
 * SCADA Nodes Panel Component
 * Left sidebar for dragging equipment type templates onto the process editor canvas
 * These are generic node templates, not actual equipment from database
 *
 * SCADA templates and farm-service equipment types are merged into unified
 * category groups so each category (Tanks, Pumps, Filtration, etc.) appears once.
 */

import React, { useState, useMemo } from 'react';
import { Search, ChevronDown, ChevronRight, GripVertical, Activity, BarChart2 } from 'lucide-react';
import { useEquipmentTypes, EquipmentType, CATEGORY_LABELS } from '../../../hooks/useEquipment';
import { getEquipmentIcon } from '../../equipment-icons';

// ---------------------------------------------------------------------------
// Template definitions
// ---------------------------------------------------------------------------

interface ScadaTemplate {
  id: string;
  name: string;
  code: string;
  /** Must match a farm-service category key (tank, pump, filtration, etc.) */
  category: string;
  nodeType?: string;
  description: string;
  color?: string;
  badge: string;       // 2-letter abbreviation for the icon badge
  badgeColor: string;  // tailwind color key (e.g. 'blue', 'amber')
}

// Generic Sensor node template
const SENSOR_NODE_TEMPLATE = {
  id: 'sensor-node-template',
  name: 'Sensor',
  code: 'SENSOR',
  category: 'monitoring',
  description: 'Generic sensor node - link to real sensors via Properties panel',
};

// Connection Point node template
const CONNECTION_POINT_TEMPLATE = {
  id: 'connection-point-template',
  name: 'Connection Point',
  code: 'CONNECTION_POINT',
  category: 'utility',
  nodeType: 'connectionPoint',
  description: '4-way pipe junction for connecting equipment',
};

// Algae Bag node templates
const ALGAE_BAG_TEMPLATES = [
  { id: 'algae-bag-red', name: 'Rhodomonas Bag', code: 'ALGAE_BAG_RED', category: 'algae', nodeType: 'algaeBagRed', color: '#FFB6C1', description: 'Pink algae cultivation bag (Rhodomonas)' },
  { id: 'algae-bag-green', name: 'Chlorella Bag', code: 'ALGAE_BAG_GREEN', category: 'algae', nodeType: 'algaeBagGreen', color: '#90EE90', description: 'Green algae cultivation bag (Chlorella)' },
  { id: 'algae-bag-yellow', name: 'Dunaliella Bag', code: 'ALGAE_BAG_YELLOW', category: 'algae', nodeType: 'algaeBagYellow', color: '#FFD700', description: 'Yellow algae cultivation bag (Dunaliella)' },
];

// Chart Widget template
const CHART_WIDGET_TEMPLATE = {
  id: 'widget-chart',
  name: 'Chart Widget',
  code: 'CHART_WIDGET',
  category: 'widgets',
  nodeType: 'chartWidget',
  description: 'Add chart to visualize sensor data',
  defaultWidth: 320,
  defaultHeight: 200,
};

// ---------------------------------------------------------------------------
// SCADA node templates – category keys match farm-service categories
// ---------------------------------------------------------------------------

const SCADA_TEMPLATES: ScadaTemplate[] = [
  // Tanks → category "tank"
  { id: 'dual-drain-tank-template', name: 'Dual Drain Tank', code: 'DUAL_DRAIN_TANK', category: 'tank', nodeType: 'dualDrainTank', description: 'Polypropylene tank with dual bottom drains', badge: 'DD', badgeColor: 'amber' },
  { id: 'clean-water-tank-template', name: 'Clean Water Tank', code: 'CLEAN_WATER_TANK', category: 'tank', nodeType: 'cleanWaterTank', description: 'Storage tank for clean/treated water', badge: 'CW', badgeColor: 'cyan' },
  { id: 'dirty-water-tank-template', name: 'Dirty Water Tank', code: 'DIRTY_WATER_TANK', category: 'tank', nodeType: 'dirtyWaterTank', description: 'Storage tank for dirty/waste water', badge: 'DW', badgeColor: 'stone' },

  // Filtration → category "filtration"
  { id: 'ultrafiltration-template', name: 'Ultrafiltration', code: 'ULTRAFILTRATION', category: 'filtration', nodeType: 'ultrafiltration', description: 'Membrane filtration unit with 9 connections', badge: 'UF', badgeColor: 'blue' },
  { id: 'radial-filter-template', name: 'Radial Filter', code: 'RADIAL_FILTER', category: 'filtration', nodeType: 'radialSettler', description: 'Conical settling tank with sludge drain', badge: 'RF', badgeColor: 'teal' },
  { id: 'mbbr-template', name: 'MBBR', code: 'MBBR', category: 'filtration', nodeType: 'mbbr', description: 'Moving Bed Biofilm Reactor', badge: 'MB', badgeColor: 'emerald' },
  { id: 'hepa-filter-template', name: 'HEPA Filter', code: 'HEPA_FILTER', category: 'filtration', nodeType: 'hepaFilter', description: 'High Efficiency Particulate Air filter', badge: 'HF', badgeColor: 'indigo' },

  // Pumps → category "pump"
  { id: 'dosing-pump-template', name: 'Dosing Pump', code: 'DOSING_PUMP', category: 'pump', nodeType: 'dosingPump', description: 'Peristaltic pump for chemical dosing', badge: 'DP', badgeColor: 'purple' },

  // Heating / Cooling → category "heating_cooling"
  { id: 'heater-template', name: 'Heater', code: 'HEATER', category: 'heating_cooling', nodeType: 'heater', description: 'Water heater with heating elements', badge: 'HT', badgeColor: 'red' },
  { id: 'shell-and-tube-hx-template', name: 'Shell & Tube HX', code: 'SHELL_TUBE_HX', category: 'heating_cooling', nodeType: 'shellAndTubeHeatExchanger', description: 'Industrial shell and tube heat exchanger', badge: 'ST', badgeColor: 'orange' },
  { id: 'plate-hx-template', name: 'Plate Heat Exchanger', code: 'PLATE_HX', category: 'heating_cooling', nodeType: 'plateHeatExchanger', description: 'Compact plate heat exchanger', badge: 'PH', badgeColor: 'amber' },
  { id: 'chiller-template', name: 'Chiller', code: 'CHILLER', category: 'heating_cooling', nodeType: 'chiller', description: 'Water chiller with cooling fan', badge: 'CH', badgeColor: 'sky' },

  // Electrical / Power → category "electrical"
  { id: 'gas-generator-template', name: 'Gas Generator', code: 'GAS_GENERATOR', category: 'electrical', nodeType: 'gasGenerator', description: 'Gas-powered generator with ATS panel', badge: 'GG', badgeColor: 'yellow' },
  { id: 'diesel-generator-template', name: 'Diesel Generator', code: 'DIESEL_GENERATOR', category: 'electrical', nodeType: 'dieselGenerator', description: 'Diesel-powered generator with ATS panel', badge: 'DG', badgeColor: 'gray' },

  // Plumbing / Water I/O → category "plumbing"
  { id: 'water-supply-template', name: 'Water Supply', code: 'WATER_SUPPLY', category: 'plumbing', nodeType: 'waterSupply', description: 'Water source inlet connection', badge: 'WS', badgeColor: 'sky' },
  { id: 'water-discharge-template', name: 'Water Discharge', code: 'WATER_DISCHARGE', category: 'plumbing', nodeType: 'waterDischarge', description: 'Water discharge outlet connection', badge: 'WD', badgeColor: 'slate' },
];

// Group SCADA templates by category for quick lookup
function groupScadaByCategory(): Record<string, ScadaTemplate[]> {
  return SCADA_TEMPLATES.reduce((acc, tpl) => {
    if (!acc[tpl.category]) acc[tpl.category] = [];
    acc[tpl.category].push(tpl);
    return acc;
  }, {} as Record<string, ScadaTemplate[]>);
}

const SCADA_BY_CATEGORY = groupScadaByCategory();

// Badge color mapping
const BADGE_COLORS: Record<string, { bg: string; hover: string; border: string; badgeBg: string }> = {
  blue:    { bg: 'bg-blue-50',    hover: 'hover:bg-blue-100',    border: 'hover:border-blue-200',    badgeBg: 'bg-blue-500' },
  amber:   { bg: 'bg-amber-50',   hover: 'hover:bg-amber-100',   border: 'hover:border-amber-200',   badgeBg: 'bg-amber-500' },
  teal:    { bg: 'bg-teal-50',    hover: 'hover:bg-teal-100',    border: 'hover:border-teal-200',    badgeBg: 'bg-teal-500' },
  cyan:    { bg: 'bg-cyan-50',    hover: 'hover:bg-cyan-100',    border: 'hover:border-cyan-200',    badgeBg: 'bg-cyan-500' },
  stone:   { bg: 'bg-stone-50',   hover: 'hover:bg-stone-100',   border: 'hover:border-stone-300',   badgeBg: 'bg-stone-500' },
  sky:     { bg: 'bg-sky-50',     hover: 'hover:bg-sky-100',     border: 'hover:border-sky-200',     badgeBg: 'bg-sky-500' },
  slate:   { bg: 'bg-slate-50',   hover: 'hover:bg-slate-100',   border: 'hover:border-slate-300',   badgeBg: 'bg-slate-500' },
  emerald: { bg: 'bg-emerald-50', hover: 'hover:bg-emerald-100', border: 'hover:border-emerald-200', badgeBg: 'bg-emerald-500' },
  indigo:  { bg: 'bg-indigo-50',  hover: 'hover:bg-indigo-100',  border: 'hover:border-indigo-200',  badgeBg: 'bg-indigo-500' },
  purple:  { bg: 'bg-purple-50',  hover: 'hover:bg-purple-100',  border: 'hover:border-purple-200',  badgeBg: 'bg-purple-500' },
  red:     { bg: 'bg-red-50',     hover: 'hover:bg-red-100',     border: 'hover:border-red-200',     badgeBg: 'bg-red-500' },
  orange:  { bg: 'bg-orange-50',  hover: 'hover:bg-orange-100',  border: 'hover:border-orange-200',  badgeBg: 'bg-orange-500' },
  yellow:  { bg: 'bg-yellow-50',  hover: 'hover:bg-yellow-100',  border: 'hover:border-yellow-200',  badgeBg: 'bg-yellow-500' },
  gray:    { bg: 'bg-gray-100',   hover: 'hover:bg-gray-200',    border: 'hover:border-gray-300',    badgeBg: 'bg-gray-600' },
};

// Farm-service codes to hide (covered by SCADA templates or duplicates of other entries)
const HIDDEN_FARM_CODES = new Set([
  'heater',             // SCADA Heater template covers this
  'chiller',            // SCADA Chiller template covers this
  'heat-exchanger',     // Shell & Tube HX + Plate HX SCADA templates cover this
  'aerator',            // same canvas node as Blower
  'filter-uv',          // same as UV Sterilizer (in water_treatment)
  'filter-mechanical',  // same as Drum Filter
  'filter-biological',  // same as MBBR
]);

// Preferred display order for categories
const CATEGORY_ORDER = [
  'tank', 'pump', 'filtration', 'aeration', 'heating_cooling',
  'feeding', 'water_treatment', 'plumbing', 'electrical',
  'harvesting', 'transport', 'safety', 'other',
];

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startScadaDrag(
  e: React.DragEvent,
  tpl: ScadaTemplate,
  onDragStart: EquipmentPanelProps['onDragStart'],
) {
  const template: NodeTemplate = {
    id: tpl.id,
    name: tpl.name,
    code: tpl.code,
    category: tpl.category,
    equipmentType: {
      id: tpl.id,
      name: tpl.name,
      code: tpl.code,
      category: tpl.category,
      nodeType: tpl.nodeType,
      isActive: true,
      sortOrder: 0,
    } as EquipmentType,
  };
  e.dataTransfer.setData('application/equipment', JSON.stringify(template));
  e.dataTransfer.effectAllowed = 'move';
  onDragStart(e, template);
}

function ScadaNodeItem({ tpl, onDragStart }: { tpl: ScadaTemplate; onDragStart: EquipmentPanelProps['onDragStart'] }) {
  const c = BADGE_COLORS[tpl.badgeColor] || BADGE_COLORS.gray;
  return (
    <div
      draggable
      onDragStart={(e) => startScadaDrag(e, tpl, onDragStart)}
      className={`flex items-center gap-2 px-3 py-2 ${c.bg} ${c.hover} rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent ${c.border}`}
    >
      <GripVertical className="w-4 h-4 text-gray-500 group-hover:text-gray-500" />
      <div className={`w-5 h-5 ${c.badgeBg} rounded text-white text-xs flex items-center justify-center font-bold`}>
        {tpl.badge}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900 truncate">{tpl.name}</div>
        <div className="text-xs text-gray-500 truncate">{tpl.description}</div>
      </div>
    </div>
  );
}

function FarmEquipmentItem({ type, onDragStart }: { type: EquipmentType; onDragStart: (e: React.DragEvent, t: EquipmentType) => void }) {
  const Icon = getEquipmentIcon(type.code);
  return (
    <div
      draggable
      onDragStart={(e) => onDragStart(e, type)}
      className="flex items-center gap-2 px-3 py-2 bg-gray-50 hover:bg-blue-50 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-blue-200"
    >
      <GripVertical className="w-4 h-4 text-gray-500 group-hover:text-gray-500" />
      <div className="text-gray-600 group-hover:text-blue-600">
        <Icon size={20} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-900 truncate">{type.name}</div>
        <div className="text-xs text-gray-500 truncate">{type.code}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const EquipmentPanel: React.FC<EquipmentPanelProps> = ({ onDragStart }) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set([
      'monitoring', 'utility', 'algae', 'widgets',
      ...CATEGORY_ORDER,
    ])
  );

  const { data: equipmentTypes, isLoading, error } = useEquipmentTypes({ isActive: true });

  // Build unified category list: SCADA templates + farm-service equipment merged
  const unifiedCategories = useMemo(() => {
    const excludedCategories = ['monitoring', 'sensor', 'sensors'];
    const term = searchTerm.toLowerCase();

    // Filter farm-service equipment types
    const farmTypes = (equipmentTypes || []).filter((type) => {
      const cat = type.category?.toLowerCase() || '';
      const code = type.code?.toLowerCase() || '';
      if (excludedCategories.includes(cat) || cat.includes('monitor') || cat.includes('sensor')) return false;
      if (code.startsWith('sensor-') || code.startsWith('sensor_')) return false;
      if (HIDDEN_FARM_CODES.has(code)) return false;
      if (term) {
        return type.name.toLowerCase().includes(term) || code.includes(term);
      }
      return true;
    });

    // Group farm types by category
    const farmByCategory: Record<string, EquipmentType[]> = {};
    farmTypes.forEach((type) => {
      const cat = type.category?.toLowerCase() || 'other';
      if (!farmByCategory[cat]) farmByCategory[cat] = [];
      farmByCategory[cat].push(type);
    });

    // Filter SCADA templates by search
    const filteredScada: Record<string, ScadaTemplate[]> = {};
    for (const [cat, templates] of Object.entries(SCADA_BY_CATEGORY)) {
      const matched = term
        ? templates.filter((t) => t.name.toLowerCase().includes(term) || t.code.toLowerCase().includes(term) || t.description.toLowerCase().includes(term))
        : templates;
      if (matched.length > 0) filteredScada[cat] = matched;
    }

    // Merge all category keys
    const allCategoryKeys = new Set([...Object.keys(farmByCategory), ...Object.keys(filteredScada)]);

    // Build sorted result
    const result: { key: string; label: string; scada: ScadaTemplate[]; farm: EquipmentType[] }[] = [];
    const orderedKeys = CATEGORY_ORDER.filter((k) => allCategoryKeys.has(k));
    // Add any remaining keys not in CATEGORY_ORDER
    allCategoryKeys.forEach((k) => { if (!orderedKeys.includes(k)) orderedKeys.push(k); });

    for (const key of orderedKeys) {
      result.push({
        key,
        label: CATEGORY_LABELS[key] || key.charAt(0).toUpperCase() + key.slice(1).replace(/_/g, ' '),
        scada: filteredScada[key] || [],
        farm: farmByCategory[key] || [],
      });
    }

    return result;
  }, [equipmentTypes, searchTerm]);

  const toggleCategory = (category: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  const handleFarmDragStart = (event: React.DragEvent, type: EquipmentType) => {
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

  const CategoryHeader = ({ categoryKey, label, count }: { categoryKey: string; label: string; count: number }) => (
    <button
      onClick={() => toggleCategory(categoryKey)}
      className="w-full flex items-center gap-2 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 rounded-lg transition-colors"
    >
      {expandedCategories.has(categoryKey) ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      <span>{label}</span>
      <span className="ml-auto text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded-full">{count}</span>
    </button>
  );

  return (
    <div className="equipment-panel w-72 bg-white border-r border-gray-200 flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-gray-200">
        <h3 className="text-lg font-semibold text-gray-900 mb-3">SCADA Nodes</h3>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500" />
          <input
            type="text"
            placeholder="Search node types..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-hidden focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* Node List */}
      <div className="flex-1 overflow-y-auto p-2">
        {isLoading && (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full" />
          </div>
        )}

        {error && (
          <div className="p-4 text-center text-red-600 text-sm">Failed to load node types.</div>
        )}

        {/* Monitoring - Sensor */}
        {(!searchTerm || 'sensor'.includes(searchTerm.toLowerCase())) && (
          <div className="mb-2">
            <CategoryHeader categoryKey="monitoring" label="Monitoring" count={1} />
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
                      equipmentType: { id: SENSOR_NODE_TEMPLATE.id, name: SENSOR_NODE_TEMPLATE.name, code: SENSOR_NODE_TEMPLATE.code, category: SENSOR_NODE_TEMPLATE.category } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-green-50 hover:bg-green-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-green-200"
                >
                  <GripVertical className="w-4 h-4 text-gray-500 group-hover:text-gray-500" />
                  <div className="text-green-600 group-hover:text-green-700"><Activity size={20} /></div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{SENSOR_NODE_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">Link real sensors via Properties</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Utility - Connection Point */}
        {(!searchTerm || 'connection point utility'.includes(searchTerm.toLowerCase())) && (
          <div className="mb-2">
            <CategoryHeader categoryKey="utility" label="Utility" count={1} />
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
                      equipmentType: { id: CONNECTION_POINT_TEMPLATE.id, name: CONNECTION_POINT_TEMPLATE.name, code: CONNECTION_POINT_TEMPLATE.code, category: CONNECTION_POINT_TEMPLATE.category, nodeType: CONNECTION_POINT_TEMPLATE.nodeType, isActive: true, sortOrder: 0 } as EquipmentType,
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-yellow-50 hover:bg-yellow-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-yellow-200"
                >
                  <GripVertical className="w-4 h-4 text-gray-500 group-hover:text-gray-500" />
                  <div className="w-5 h-5 rounded-full bg-yellow-400 border-2 border-yellow-600" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{CONNECTION_POINT_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{CONNECTION_POINT_TEMPLATE.description}</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Algae Cultivation */}
        {(!searchTerm || 'algae'.includes(searchTerm.toLowerCase()) ||
          ALGAE_BAG_TEMPLATES.some(t => t.name.toLowerCase().includes(searchTerm.toLowerCase()))) && (
          <div className="mb-2">
            <CategoryHeader categoryKey="algae" label="Algae Cultivation" count={ALGAE_BAG_TEMPLATES.length} />
            {expandedCategories.has('algae') && (
              <div className="ml-2 space-y-1">
                {ALGAE_BAG_TEMPLATES.map((bag) => (
                  <div
                    key={bag.id}
                    draggable
                    onDragStart={(e) => {
                      const template: NodeTemplate = {
                        id: bag.id, name: bag.name, code: bag.code, category: bag.category,
                        equipmentType: { id: bag.id, name: bag.name, code: bag.code, category: bag.category, nodeType: bag.nodeType, isActive: true, sortOrder: 0 } as EquipmentType,
                      };
                      e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                      e.dataTransfer.effectAllowed = 'move';
                      onDragStart(e, template);
                    }}
                    className="flex items-center gap-2 px-3 py-2 bg-gray-50 hover:bg-emerald-50 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-emerald-200"
                  >
                    <GripVertical className="w-4 h-4 text-gray-500 group-hover:text-gray-500" />
                    <div className="w-5 h-5 rounded-full border-2 border-white shadow-sm" style={{ backgroundColor: bag.color }} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-gray-900 truncate">{bag.name}</div>
                      <div className="text-xs text-gray-500 truncate">{bag.description}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Widgets */}
        {(!searchTerm || 'widget chart graph gauge'.includes(searchTerm.toLowerCase()) ||
          CHART_WIDGET_TEMPLATE.name.toLowerCase().includes(searchTerm.toLowerCase())) && (
          <div className="mb-2">
            <CategoryHeader categoryKey="widgets" label="Widgets" count={1} />
            {expandedCategories.has('widgets') && (
              <div className="ml-2 space-y-1">
                <div
                  draggable
                  onDragStart={(e) => {
                    const template: NodeTemplate = {
                      id: CHART_WIDGET_TEMPLATE.id, name: CHART_WIDGET_TEMPLATE.name, code: CHART_WIDGET_TEMPLATE.code, category: CHART_WIDGET_TEMPLATE.category,
                      equipmentType: { id: CHART_WIDGET_TEMPLATE.id, name: CHART_WIDGET_TEMPLATE.name, code: CHART_WIDGET_TEMPLATE.code, category: CHART_WIDGET_TEMPLATE.category, nodeType: CHART_WIDGET_TEMPLATE.nodeType, isActive: true, sortOrder: 0, defaultWidth: CHART_WIDGET_TEMPLATE.defaultWidth, defaultHeight: CHART_WIDGET_TEMPLATE.defaultHeight } as EquipmentType & { defaultWidth: number; defaultHeight: number },
                    };
                    e.dataTransfer.setData('application/equipment', JSON.stringify(template));
                    e.dataTransfer.effectAllowed = 'move';
                    onDragStart(e, template);
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-cyan-50 hover:bg-cyan-100 rounded-lg cursor-grab active:cursor-grabbing transition-colors group border border-transparent hover:border-cyan-200"
                >
                  <GripVertical className="w-4 h-4 text-gray-500 group-hover:text-gray-500" />
                  <div className="text-cyan-600 group-hover:text-cyan-700"><BarChart2 size={20} /></div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 truncate">{CHART_WIDGET_TEMPLATE.name}</div>
                    <div className="text-xs text-gray-500 truncate">{CHART_WIDGET_TEMPLATE.description}</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* Unified equipment categories (SCADA + farm-service merged)       */}
        {/* ---------------------------------------------------------------- */}
        {unifiedCategories.map(({ key, label, scada, farm }) => (
          <div key={key} className="mb-2">
            <CategoryHeader categoryKey={key} label={label} count={scada.length + farm.length} />
            {expandedCategories.has(key) && (
              <div className="ml-2 space-y-1">
                {/* SCADA templates first */}
                {scada.map((tpl) => (
                  <ScadaNodeItem key={tpl.id} tpl={tpl} onDragStart={onDragStart} />
                ))}
                {/* Farm-service equipment types */}
                {farm.map((type) => (
                  <FarmEquipmentItem key={type.id} type={type} onDragStart={handleFarmDragStart} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-gray-200 bg-gray-50">
        <p className="text-xs text-gray-500 text-center">Drag nodes to canvas, then link real equipment</p>
      </div>
    </div>
  );
};

export default EquipmentPanel;
