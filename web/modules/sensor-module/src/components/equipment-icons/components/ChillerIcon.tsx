import React from 'react';
import { IconProps } from '../types';

/**
 * Chiller Icon Component
 * You can customize this SVG or replace it with your own design
 */
export const ChillerIcon: React.FC<IconProps> = ({
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
    <path d="M32 10v12" stroke={color} strokeWidth="2"/>
    <path d="M32 42v12" stroke={color} strokeWidth="2"/>
    <path d="M10 32h12" stroke={color} strokeWidth="2"/>
    <path d="M42 32h12" stroke={color} strokeWidth="2"/>
    <path d="M18 18l8 8" stroke={color} strokeWidth="2"/>
    <path d="M38 38l8 8" stroke={color} strokeWidth="2"/>
    <path d="M38 18l8 8" stroke={color} strokeWidth="2"/>
    <path d="M18 38l8 8" stroke={color} strokeWidth="2"/>
    <circle cx="32" cy="32" r="6" stroke={color} strokeWidth="2" fill="none"/>
    <text x="32" y="36" textAnchor="middle" fontSize="10" fill={color}>*</text>
  </svg>
);

export default ChillerIcon;
