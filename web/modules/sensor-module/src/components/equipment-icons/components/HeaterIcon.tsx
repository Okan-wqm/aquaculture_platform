import React from 'react';
import { IconProps } from '../types';

/**
 * Heater Icon Component
 * You can customize this SVG or replace it with your own design
 */
export const HeaterIcon: React.FC<IconProps> = ({
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
    <rect x="12" y="16" width="40" height="32" rx="4" stroke={color} strokeWidth="2" fill="none"/>
    <path d="M12 26h40" stroke={color} strokeWidth="2"/>
    <path d="M12 38h40" stroke={color} strokeWidth="2"/>
    <path d="M20 16v-6" stroke={color} strokeWidth="2"/>
    <path d="M44 16v-6" stroke={color} strokeWidth="2"/>
    <path d="M20 48v6" stroke={color} strokeWidth="2"/>
    <path d="M44 48v6" stroke={color} strokeWidth="2"/>
    <path d="M24 32c2-4 4-4 6 0s4 4 6 0" stroke="#ef4444" strokeWidth="2" fill="none"/>
  </svg>
);

export default HeaterIcon;
