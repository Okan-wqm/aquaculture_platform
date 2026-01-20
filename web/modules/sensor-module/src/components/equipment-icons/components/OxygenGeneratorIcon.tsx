import React from 'react';
import { IconProps } from '../types';

/**
 * Oxygen Generator Icon Component
 * You can customize this SVG or replace it with your own design
 */
export const OxygenGeneratorIcon: React.FC<IconProps> = ({
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
    <rect x="14" y="10" width="36" height="44" rx="4" stroke={color} strokeWidth="2" fill="none"/>
    <circle cx="32" cy="28" r="10" stroke={color} strokeWidth="2" fill="none"/>
    <text x="32" y="32" textAnchor="middle" fontSize="10" fontWeight="bold" fill={color}>O2</text>
    <path d="M22 44h20" stroke={color} strokeWidth="2"/>
    <path d="M26 48h12" stroke={color} strokeWidth="2"/>
    {/* Bubbles */}
    <circle cx="20" cy="18" r="2" stroke={color} strokeWidth="1" fill="none"/>
    <circle cx="44" cy="16" r="2" stroke={color} strokeWidth="1" fill="none"/>
    <circle cx="24" cy="12" r="1.5" stroke={color} strokeWidth="1" fill="none"/>
  </svg>
);

export default OxygenGeneratorIcon;
