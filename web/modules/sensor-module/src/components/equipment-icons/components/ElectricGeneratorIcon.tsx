import React from 'react';
import { IconProps } from '../types';

/**
 * Electric Generator Icon Component
 * You can customize this SVG or replace it with your own design
 */
export const ElectricGeneratorIcon: React.FC<IconProps> = ({
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
    <rect x="10" y="16" width="44" height="32" rx="4" stroke={color} strokeWidth="2" fill="none"/>
    <circle cx="26" cy="32" r="10" stroke={color} strokeWidth="2" fill="none"/>
    <rect x="40" y="24" width="10" height="16" rx="2" stroke={color} strokeWidth="2" fill="none"/>
    <path d="M26 26v12" stroke={color} strokeWidth="2"/>
    <path d="M20 32h12" stroke={color} strokeWidth="2"/>
    {/* Lightning bolt */}
    <path d="M43 28l2-2v4l2-2" stroke="#eab308" strokeWidth="2" fill="none"/>
  </svg>
);

export default ElectricGeneratorIcon;
