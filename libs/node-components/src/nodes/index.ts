/**
 * Node Components Index
 *
 * This file exports all node components and handles auto-registration.
 * When you add a new node, simply import it here and it will be
 * automatically registered with the NodeRegistry.
 */

// Import all nodes (importing triggers auto-registration)
import AlgaeBagNode from './AlgaeBagNode';
import AutomaticFeederNode from './AutomaticFeederNode';
import BaseNode from './BaseNode';
import BlowerNode from './BlowerNode';
import ChillerNode from './ChillerNode';
import CleanWaterTankNode from './CleanWaterTankNode';
import ConnectionPointNode from './ConnectionPointNode';
import DemandFeederNode from './DemandFeederNode';
import DieselGeneratorNode from './DieselGeneratorNode';
import DirtyWaterTankNode from './DirtyWaterTankNode';
import DosingPumpNode from './DosingPumpNode';
import DrumFilterNode from './DrumFilterNode';
import DualDrainTankNode from './DualDrainTankNode';
import EquipmentNode from './EquipmentNode';
import FishTankNode from './FishTankNode';
import GasGeneratorNode from './GasGeneratorNode';
import HeaterNode from './HeaterNode';
import HEPAFilterNode from './HEPAFilterNode';
import MBBRNode from './MBBRNode';
import OxygenGeneratorNode from './OxygenGeneratorNode';
import OzoneGeneratorNode from './OzoneGeneratorNode';
import PlateHeatExchangerNode from './PlateHeatExchangerNode';
import PumpNode from './PumpNode';
import RadialSettlerNode from './RadialSettlerNode';
import SensorNode from './SensorNode';
import ShellTubeHeatExchangerNode from './ShellTubeHeatExchangerNode';
import TankInletNode from './TankInletNode';
import UltrafiltrationNode from './UltrafiltrationNode';
import UVUnitNode from './UVUnitNode';
import ValveNode from './ValveNode';
import WaterDischargeNode from './WaterDischargeNode';
import WaterSupplyNode from './WaterSupplyNode';

// Re-export individual nodes for direct imports
export {
  AlgaeBagNode,
  AutomaticFeederNode,
  BaseNode,
  BlowerNode,
  ChillerNode,
  CleanWaterTankNode,
  ConnectionPointNode,
  DemandFeederNode,
  DieselGeneratorNode,
  DirtyWaterTankNode,
  DosingPumpNode,
  DrumFilterNode,
  DualDrainTankNode,
  EquipmentNode,
  FishTankNode,
  GasGeneratorNode,
  HeaterNode,
  HEPAFilterNode,
  MBBRNode,
  OxygenGeneratorNode,
  OzoneGeneratorNode,
  PlateHeatExchangerNode,
  PumpNode,
  RadialSettlerNode,
  SensorNode,
  ShellTubeHeatExchangerNode,
  TankInletNode,
  UltrafiltrationNode,
  UVUnitNode,
  ValveNode,
  WaterDischargeNode,
  WaterSupplyNode,
};

// Export types
export * from './types';

// Export NodeRegistry for consumers
export { NodeRegistry } from '../registry/NodeRegistry';
export type { NodeTypeConfig, NodeCategory, PaletteItem, PaletteGroup } from '../registry/NodeRegistry';

// Convenience: Get all registered node types for ReactFlow
import { NodeRegistry } from '../registry/NodeRegistry';
export const nodeTypes = NodeRegistry.getNodeTypes();

// Convenience: Get palette items for UI
export const getPaletteItems = () => NodeRegistry.getPaletteItems();
export const getPaletteGroups = () => NodeRegistry.getPaletteGroups();
