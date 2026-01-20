import React from 'react';
import { IconProps } from '../types';

/**
 * Tank Icon Component
 * You can customize this SVG or replace it with your own design
 */
export const TankIcon: React.FC<IconProps> = ({
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
    <rect x="8" y="12" width="48" height="40" rx="4" stroke={color} strokeWidth="2" fill="none"/>
    <path d="M8 20h48" stroke={color} strokeWidth="2"/>
    <path d="M20 32c2 2 4 2 6 0s4-2 6 0 4 2 6 0 4-2 6 0" stroke={color} strokeWidth="1.5" fill="none"/>
    <circle cx="20" cy="40" r="3" fill={color}/>
    <circle cx="44" cy="38" r="3" fill={color}/>
  </svg>
);

export default TankIcon;
