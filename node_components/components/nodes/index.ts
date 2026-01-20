/**
 * Node Types Registry
 * Exports all available node types for ReactFlow
 */

import BaseNode from './BaseNode';
import BlowerNode from './Blower';
import ConnectionPointNode from './Cp';
import DrumFilterNode from './DrumFilter';
import FishTankNode from './flowtank';
import RadialSettlerNode from './RadialSettler';
import TankInletNode from './TankInlet';
import UVUnitNode from './UVUnit';
import EquipmentNode from './EquipmentNode';
import UltrafiltrationNode from './Ultrafiltration';

export {
  BaseNode,
  BlowerNode,
  ConnectionPointNode,
  DrumFilterNode,
  EquipmentNode,
  FishTankNode,
  RadialSettlerNode,
  TankInletNode,
  UltrafiltrationNode,
  UVUnitNode,
};

/**
 * Node types object for ReactFlow
 * Usage: <ReactFlow nodeTypes={nodeTypes} />
 */
export const nodeTypes = {
  baseNode: BaseNode,
  blower: BlowerNode,
  connectionPoint: ConnectionPointNode,
  drumFilter: DrumFilterNode,
  equipment: EquipmentNode,
  fishTank: FishTankNode,
  radialSettler: RadialSettlerNode,
  tankInlet: TankInletNode,
  ultrafiltration: UltrafiltrationNode,
  uvUnit: UVUnitNode,
};

/**
 * Node type identifiers
 */
export type NodeTypeId = keyof typeof nodeTypes;

/**
 * Node type configuration for UI/Toolbox
 */
export interface NodeTypeConfig {
  id: NodeTypeId;
  label: string;
  labelTr: string;
  category: string;
  description: string;
}

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
    id: 'ultrafiltration',
    label: 'Ultrafiltration',
    labelTr: 'Ultrafiltrasyon',
    category: 'filtration',
    description: 'Membrane ultrafiltration unit with 3 cylinders, PLC and power connections',
  },
  {
    id: 'uvUnit',
    label: 'UV Unit',
    labelTr: 'UV Unitesi',
    category: 'disinfection',
    description: 'UV disinfection chamber',
  },
];

export default nodeTypes;
