import React from 'react';
import { IconProps } from '../types';

/**
 * Pump Icon Component
 * You can customize this SVG or replace it with your own design
 */
export const PumpIcon: React.FC<IconProps> = ({
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
    <circle cx="32" cy="32" r="18" stroke={color} strokeWidth="2" fill="none"/>
    <path d="M32 14v-6" stroke={color} strokeWidth="2"/>
    <path d="M32 56v-6" stroke={color} strokeWidth="2"/>
    <path d="M14 32H8" stroke={color} strokeWidth="2"/>
    <path d="M56 32h-6" stroke={color} strokeWidth="2"/>
    <path d="M32 24l6 8-6 8-6-8 6-8z" fill={color}/>
  </svg>
);

export default PumpIcon;
