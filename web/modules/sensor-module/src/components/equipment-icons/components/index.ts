/**
 * Equipment Icon Components
 * Export all React component icons
 */

export { TankIcon } from './TankIcon';
export { PumpIcon } from './PumpIcon';
export { ChillerIcon } from './ChillerIcon';
export { HeaterIcon } from './HeaterIcon';
export { RootBlowerIcon } from './RootBlowerIcon';
export { FanIcon } from './FanIcon';
export { FeederIcon } from './FeederIcon';
export { DrumFilterIcon } from './DrumFilterIcon';
export { SandFilterIcon } from './SandFilterIcon';
export { ElectricGeneratorIcon } from './ElectricGeneratorIcon';
export { OxygenGeneratorIcon } from './OxygenGeneratorIcon';
export { BeltFilterIcon } from './BeltFilterIcon';

// Icon component mapping by equipment type code
import { TankIcon } from './TankIcon';
import { PumpIcon } from './PumpIcon';
import { ChillerIcon } from './ChillerIcon';
import { HeaterIcon } from './HeaterIcon';
import { RootBlowerIcon } from './RootBlowerIcon';
import { FanIcon } from './FanIcon';
import { FeederIcon } from './FeederIcon';
import { DrumFilterIcon } from './DrumFilterIcon';
import { SandFilterIcon } from './SandFilterIcon';
import { ElectricGeneratorIcon } from './ElectricGeneratorIcon';
import { OxygenGeneratorIcon } from './OxygenGeneratorIcon';
import { BeltFilterIcon } from './BeltFilterIcon';
import { IconProps } from '../types';
import React from 'react';

export const IconComponents: Record<string, React.FC<IconProps>> = {
  'tank': TankIcon,
  'pump': PumpIcon,
  'chiller': ChillerIcon,
  'heater': HeaterIcon,
  'root-blower': RootBlowerIcon,
  'fan': FanIcon,
  'feeder': FeederIcon,
  'drum-filter': DrumFilterIcon,
  'sand-filter': SandFilterIcon,
  'electric-generator': ElectricGeneratorIcon,
  'oxygen-generator': OxygenGeneratorIcon,
  'belt-filter': BeltFilterIcon,
};

/**
 * Get icon component by equipment type code
 */
export const getIconComponent = (code: string): React.FC<IconProps> | undefined => {
  const normalizedCode = code.toLowerCase().replace(/_/g, '-');
  return IconComponents[normalizedCode];
};
