/**
 * Equipment Icons Module
 * Central export point for all equipment icons and related utilities
 */

// Types
export type { IconProps } from './types';
export type {
  ConnectionPointPosition,
  ConnectionPointType,
  ConnectionPointConfig,
  EquipmentSize,
  EquipmentTypeConfig,
} from './equipmentTypes';

// Equipment type configurations
export {
  EQUIPMENT_TYPES,
  EQUIPMENT_CATEGORIES,
  SIZES,
  getEquipmentTypeConfig,
  getEquipmentSize,
  getAllEquipmentTypes,
  getEquipmentTypesByCategory,
} from './equipmentTypes';

// Icon loader (main entry point for getting icons)
export {
  getEquipmentIcon,
  hasEquipmentIcon,
  getAvailableIconCodes,
  DefaultIcon,
} from './EquipmentIconLoader';

// Individual React component icons (from components/ folder)
export {
  TankIcon,
  PumpIcon,
  ChillerIcon,
  HeaterIcon,
  RootBlowerIcon,
  FanIcon,
  FeederIcon,
  DrumFilterIcon,
  SandFilterIcon,
  ElectricGeneratorIcon,
  OxygenGeneratorIcon,
  BeltFilterIcon,
  IconComponents,
  getIconComponent,
} from './components';

// Legacy exports for backward compatibility
// These will use the new icon loader internally
export {
  FishTankIcon,
  RacewayIcon,
  WaterPumpIcon,
  DrumFilterIcon as LegacyDrumFilterIcon,
  BlowerIcon,
  BiofilterIcon,
  AutoFeederIcon,
  AeratorIcon,
  HeatExchangerIcon,
  ChillerIcon as LegacyChillerIcon,
  UVSterilizerIcon,
  OzoneGeneratorIcon,
  MultiparameterProbeIcon,
  DefaultEquipmentIcon,
  EquipmentIcons,
  getEquipmentIcon as getLegacyEquipmentIcon,
  getAllEquipmentIcons,
} from './EquipmentIcons';
