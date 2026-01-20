import React from 'react';
import { IconProps } from '../types';

/**
 * Belt Filter Icon Component
 * You can customize this SVG or replace it with your own design
 */
export const BeltFilterIcon: React.FC<IconProps> = ({
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
    <rect x="6" y="20" width="52" height="24" rx="2" stroke={color} strokeWidth="2" fill="none"/>
    <circle cx="14" cy="32" r="6" stroke={color} strokeWidth="2" fill="none"/>
    <circle cx="50" cy="32" r="6" stroke={color} strokeWidth="2" fill="none"/>
    <path d="M20 26h24" stroke={color} strokeWidth="2"/>
    <path d="M20 38h24" stroke={color} strokeWidth="2"/>
    {/* Belt pattern */}
    <path d="M24 26v12" stroke={color} strokeWidth="1" strokeDasharray="2 2"/>
    <path d="M32 26v12" stroke={color} strokeWidth="1" strokeDasharray="2 2"/>
    <path d="M40 26v12" stroke={color} strokeWidth="1" strokeDasharray="2 2"/>
    <path d="M6 32H2" stroke={color} strokeWidth="2"/>
    <path d="M62 32h-4" stroke={color} strokeWidth="2"/>
  </svg>
);

export default BeltFilterIcon;
