/**
 * Equipment Icon Loader
 * Auto-detects and loads icons from either:
 * 1. components/ folder (React .tsx components) - priority
 * 2. svg/ folder (.svg files)
 * 3. Default fallback icon
 */

import React from 'react';
import { IconProps } from './types';
import { getIconComponent } from './components';

// Import all SVG files as React components using Vite's ?react suffix
import TankSvg from './svg/tank.svg?react';
import PumpSvg from './svg/pump.svg?react';
import ChillerSvg from './svg/chiller.svg?react';
import HeaterSvg from './svg/heater.svg?react';
import RootBlowerSvg from './svg/root-blower.svg?react';
import FanSvg from './svg/fan.svg?react';
import FeederSvg from './svg/feeder.svg?react';
import DrumFilterSvg from './svg/drum-filter.svg?react';
import SandFilterSvg from './svg/sand-filter.svg?react';
import ElectricGeneratorSvg from './svg/electric-generator.svg?react';
import OxygenGeneratorSvg from './svg/oxygen-generator.svg?react';
import BeltFilterSvg from './svg/belt-filter.svg?react';

// SVG component mapping
const SvgComponents: Record<string, React.FC<React.SVGProps<SVGSVGElement>>> = {
  'tank': TankSvg,
  'pump': PumpSvg,
  'chiller': ChillerSvg,
  'heater': HeaterSvg,
  'root-blower': RootBlowerSvg,
  'fan': FanSvg,
  'feeder': FeederSvg,
  'drum-filter': DrumFilterSvg,
  'sand-filter': SandFilterSvg,
  'electric-generator': ElectricGeneratorSvg,
  'oxygen-generator': OxygenGeneratorSvg,
  'belt-filter': BeltFilterSvg,
};

/**
 * Default fallback icon when no specific icon is found
 */
export const DefaultIcon: React.FC<IconProps> = ({
  size = 64,
  className = '',
  color = 'currentColor'
}) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 64 64"
    fill="none"
    className={className}
    xmlns="http://www.w3.org/2000/svg"
  >
    <rect x="10" y="10" width="44" height="44" rx="4" stroke={color} strokeWidth="2" fill="none"/>
    <circle cx="32" cy="32" r="12" stroke={color} strokeWidth="2" fill="none"/>
    <path d="M32 20v-6" stroke={color} strokeWidth="2"/>
    <path d="M32 50v-6" stroke={color} strokeWidth="2"/>
    <path d="M20 32h-6" stroke={color} strokeWidth="2"/>
    <path d="M50 32h-6" stroke={color} strokeWidth="2"/>
  </svg>
);

/**
 * SVG Wrapper Component
 * Wraps raw SVG components to match IconProps interface
 */
const createSvgWrapper = (
  SvgComponent: React.FC<React.SVGProps<SVGSVGElement>>
): React.FC<IconProps> => {
  const WrappedSvg: React.FC<IconProps> = ({ size = 64, className = '', color = 'currentColor' }) => (
    <SvgComponent
      width={size}
      height={size}
      className={className}
      style={{ color }}
    />
  );
  return WrappedSvg;
};

/**
 * Get equipment icon by type code
 * Priority: 1. React component (.tsx) -> 2. SVG file (.svg) -> 3. Default
 *
 * @param code - Equipment type code (e.g., 'tank', 'pump', 'drum-filter')
 * @returns React component that renders the icon
 */
export const getEquipmentIcon = (code: string): React.FC<IconProps> => {
  const normalizedCode = code.toLowerCase().replace(/_/g, '-');

  // 1. Check for React component in components/ folder
  const ComponentIcon = getIconComponent(normalizedCode);
  if (ComponentIcon) {
    return ComponentIcon;
  }

  // 2. Check for SVG file in svg/ folder
  const SvgIcon = SvgComponents[normalizedCode];
  if (SvgIcon) {
    return createSvgWrapper(SvgIcon);
  }

  // 3. Return default fallback icon
  return DefaultIcon;
};

/**
 * Check if an icon exists for the given equipment type
 */
export const hasEquipmentIcon = (code: string): boolean => {
  const normalizedCode = code.toLowerCase().replace(/_/g, '-');
  return !!(getIconComponent(normalizedCode) || SvgComponents[normalizedCode]);
};

/**
 * Get all available equipment icon codes
 */
export const getAvailableIconCodes = (): string[] => {
  return Object.keys(SvgComponents);
};

export default getEquipmentIcon;
