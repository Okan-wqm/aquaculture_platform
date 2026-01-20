/**
 * ReactFlow node types registry
 *
 * Available node types:
 * - equipment: Generic equipment with 4 connection points and status
 * - baseNode: Base component for rotatable nodes
 * - blower: Lobe blower with rotation support
 * - drumFilter: Faivre 200 drum filter with 5 ports
 * - uvUnit: UV disinfection chamber
 * - tankInlet: Water distribution inlet pipe
 * - radialSettler: Conical settling tank
 * - fishTank: RAS recirculating fish tank
 * - connectionPoint: 4-way connection junction
 * - ultrafiltration: Membrane ultrafiltration unit with 9 ports
 * - sensorWidget: Live sensor data visualization
 * - algaeBagRed: Rhodomonas cultivation bag (pink)
 * - algaeBagGreen: Chlorella cultivation bag (green)
 * - algaeBagYellow: Dunaliella cultivation bag (yellow)
 */

import { EquipmentNode } from './EquipmentNode';
import BaseNode from './BaseNode';
import BlowerNode from './BlowerNode';
import DrumFilterNode from './DrumFilterNode';
import UVUnitNode from './UVUnitNode';
import TankInletNode from './TankInletNode';
import RadialSettlerNode from './RadialSettlerNode';
import FishTankNode from './FishTankNode';
import ConnectionPointNode from './ConnectionPointNode';
import SensorWidget, { SensorWidgetData } from './SensorWidget';
import { AlgaeBagRedNode, AlgaeBagGreenNode, AlgaeBagYellowNode } from './AlgaeBagNode';
import UltrafiltrationNode from './UltrafiltrationNode';

// Node types for ReactFlow
export const nodeTypes = {
  // Original equipment node
  equipment: EquipmentNode,
  // Specialized nodes
  baseNode: BaseNode,
  blower: BlowerNode,
  drumFilter: DrumFilterNode,
  uvUnit: UVUnitNode,
  tankInlet: TankInletNode,
  radialSettler: RadialSettlerNode,
  fishTank: FishTankNode,
  connectionPoint: ConnectionPointNode,
  // Algae cultivation bags
  algaeBagRed: AlgaeBagRedNode,
  algaeBagGreen: AlgaeBagGreenNode,
  algaeBagYellow: AlgaeBagYellowNode,
  // Filtration
  ultrafiltration: UltrafiltrationNode,
  // Sensor visualization
  sensorWidget: SensorWidget,
};

// Node type identifiers
export type NodeTypeId = keyof typeof nodeTypes;

// Node type configuration for UI/Toolbox
export interface NodeTypeConfig {
  id: NodeTypeId;
  label: string;
  labelTr: string;
  category: string;
  description: string;
}

// Node type options for toolbox/palette
export const NODE_TYPE_OPTIONS: NodeTypeConfig[] = [
  {
    id: 'blower',
    label: 'Lobe Blower',
    labelTr: 'Root Blower',
    category: 'aeration',
    description: 'Lobe blower with rotation support',
  },
  {
    id: 'connectionPoint',
    label: 'Connection Point',
    labelTr: 'Baglanti Noktasi',
    category: 'utility',
    description: '4-way connection junction',
  },
  {
    id: 'drumFilter',
    label: 'Drum Filter',
    labelTr: 'Drum Filtre',
    category: 'filtration',
    description: 'Faivre 200 drum filter with 5 ports',
  },
  {
    id: 'equipment',
    label: 'Equipment',
    labelTr: 'Ekipman',
    category: 'general',
    description: 'Generic equipment node (12 types)',
  },
  {
    id: 'fishTank',
    label: 'Fish Tank',
    labelTr: 'Balik Tanki',
    category: 'tank',
    description: 'RAS recirculating fish tank',
  },
  {
    id: 'radialSettler',
    label: 'Radial Settler',
    labelTr: 'Radyal Cokturucu',
    category: 'filtration',
    description: 'Conical settling tank',
  },
  {
    id: 'tankInlet',
    label: 'Tank Inlet',
    labelTr: 'Tank Girisi',
    category: 'distribution',
    description: 'Water distribution inlet pipe',
  },
  {
    id: 'uvUnit',
    label: 'UV Unit',
    labelTr: 'UV Unitesi',
    category: 'disinfection',
    description: 'UV disinfection chamber',
  },
  {
    id: 'ultrafiltration',
    label: 'Ultrafiltration',
    labelTr: 'Ultrafiltrasyon',
    category: 'filtration',
    description: 'Membrane ultrafiltration unit with 3 cylinders, PLC and power connections',
  },
  {
    id: 'sensorWidget',
    label: 'Sensor Widget',
    labelTr: 'Sensor Widget',
    category: 'monitoring',
    description: 'Live sensor data visualization',
  },
  {
    id: 'algaeBagRed',
    label: 'Algae Bag (Red)',
    labelTr: 'Alg Torbasi (Kirmizi)',
    category: 'algae',
    description: 'Rhodomonas cultivation bag',
  },
  {
    id: 'algaeBagGreen',
    label: 'Algae Bag (Green)',
    labelTr: 'Alg Torbasi (Yesil)',
    category: 'algae',
    description: 'Chlorella cultivation bag',
  },
  {
    id: 'algaeBagYellow',
    label: 'Algae Bag (Yellow)',
    labelTr: 'Alg Torbasi (Sari)',
    category: 'algae',
    description: 'Dunaliella cultivation bag',
  },
];

export {
  EquipmentNode,
  BaseNode,
  BlowerNode,
  DrumFilterNode,
  UVUnitNode,
  TankInletNode,
  RadialSettlerNode,
  FishTankNode,
  ConnectionPointNode,
  SensorWidget,
  AlgaeBagRedNode,
  AlgaeBagGreenNode,
  AlgaeBagYellowNode,
  UltrafiltrationNode,
};

export type { SensorWidgetData };
