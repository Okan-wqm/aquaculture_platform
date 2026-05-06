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
  turbinePump: React.lazy(() => import('./pumps/TurbinePumpSymbol')),
  screwPump: React.lazy(() => import('./pumps/ScrewPumpSymbol')),
  peristalticPump: React.lazy(() => import('./pumps/PeristalticPumpSymbol')),
  blowerPump: React.lazy(() => import('./pumps/BlowerPumpSymbol')),
  jetPump: React.lazy(() => import('./pumps/JetPumpSymbol')),
  vanePump: React.lazy(() => import('./pumps/VanePumpSymbol')),
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
  threeWayValve: React.lazy(() => import('./valves/ThreeWayValveSymbol')),
  pinchValve: React.lazy(() => import('./valves/PinchValveSymbol')),
  diaphragmValve: React.lazy(() => import('./valves/DiaphragmValveSymbol')),
  plugValve: React.lazy(() => import('./valves/PlugValveSymbol')),
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
  // Compressors
  pistonCompressor: React.lazy(() => import('./compressors/PistonCompressorSymbol')),
  screwCompressor: React.lazy(() => import('./compressors/ScrewCompressorSymbol')),
  centrifugalCompressor: React.lazy(() => import('./compressors/CentrifugalCompressorSymbol')),
  diaphragmCompressor: React.lazy(() => import('./compressors/DiaphragmCompressorSymbol')),
  // Motors
  acMotor: React.lazy(() => import('./motors/AcMotorSymbol')),
  vfdMotor: React.lazy(() => import('./motors/VfdMotorSymbol')),
  servoMotor: React.lazy(() => import('./motors/ServoMotorSymbol')),
  // Filters
  bagFilter: React.lazy(() => import('./filters/BagFilterSymbol')),
  drumFilter: React.lazy(() => import('./filters/DrumFilterSymbol')),
  membraneFilter: React.lazy(() => import('./filters/MembraneFilterSymbol')),
  // Instruments
  pressureTransmitter: React.lazy(() => import('./instruments/PressureTransmitterSymbol')),
  flowTransmitter: React.lazy(() => import('./instruments/FlowTransmitterSymbol')),
  levelTransmitter: React.lazy(() => import('./instruments/LevelTransmitterSymbol')),
  temperatureTransmitter: React.lazy(() => import('./instruments/TemperatureTransmitterSymbol')),
  // Animated
  animatedGear: React.lazy(() => import('./animated/AnimatedGearSymbol')),
  animatedConveyor: React.lazy(() => import('./animated/AnimatedConveyorSymbol')),
};

export { symbolMap };
export { EQUIPMENT_STATE_COLORS, CONNECTION_POINT_COLORS, CONNECTION_POINTS } from './types';
export type { EquipmentSymbolProps } from './types';
