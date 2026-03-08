import React from 'react';
import type { EquipmentSymbolProps } from './types';
import type { EquipmentSubType } from '../../../types/scada-widget.types';

// Lazy-load all symbol components
const symbolMap: Record<EquipmentSubType, React.LazyExoticComponent<React.ComponentType<EquipmentSymbolProps>>> = {
  // Pumps
  centrifugalPump: React.lazy(() => import('./pumps/CentrifugalPumpSymbol')),
  gearPump: React.lazy(() => import('./pumps/GearPumpSymbol')),
  diaphragmPump: React.lazy(() => import('./pumps/DiaphragmPumpSymbol')),
  pistonPump: React.lazy(() => import('./pumps/PistonPumpSymbol')),
  submersiblePump: React.lazy(() => import('./pumps/SubmersiblePumpSymbol')),
  vacuumPump: React.lazy(() => import('./pumps/VacuumPumpSymbol')),
  // Valves
  gateValve: React.lazy(() => import('./valves/GateValveSymbol')),
  ballValve: React.lazy(() => import('./valves/BallValveSymbol')),
  butterflyValve: React.lazy(() => import('./valves/ButterflyValveSymbol')),
  globeValve: React.lazy(() => import('./valves/GlobeValveSymbol')),
  checkValve: React.lazy(() => import('./valves/CheckValveSymbol')),
  reliefValve: React.lazy(() => import('./valves/ReliefValveSymbol')),
  controlValve: React.lazy(() => import('./valves/ControlValveSymbol')),
  needleValve: React.lazy(() => import('./valves/NeedleValveSymbol')),
  solenoidValve: React.lazy(() => import('./valves/SolenoidValveSymbol')),
  // Tanks
  verticalTank: React.lazy(() => import('./tanks/VerticalTankSymbol')),
  horizontalTank: React.lazy(() => import('./tanks/HorizontalTankSymbol')),
  conicalBottomTank: React.lazy(() => import('./tanks/ConicalBottomTankSymbol')),
  pressureVessel: React.lazy(() => import('./tanks/PressureVesselSymbol')),
  silo: React.lazy(() => import('./tanks/SiloSymbol')),
  mixingTank: React.lazy(() => import('./tanks/MixingTankSymbol')),
  // Heat Exchangers
  shellAndTube: React.lazy(() => import('./heat-exchangers/ShellAndTubeSymbol')),
  plateHeatExchanger: React.lazy(() => import('./heat-exchangers/PlateHeatExchangerSymbol')),
  airCooler: React.lazy(() => import('./heat-exchangers/AirCoolerSymbol')),
  condenser: React.lazy(() => import('./heat-exchangers/CondenserSymbol')),
  evaporator: React.lazy(() => import('./heat-exchangers/EvaporatorSymbol')),
};

export { symbolMap };
export { EQUIPMENT_STATE_COLORS, CONNECTION_POINT_COLORS, CONNECTION_POINTS } from './types';
export type { EquipmentSymbolProps } from './types';
