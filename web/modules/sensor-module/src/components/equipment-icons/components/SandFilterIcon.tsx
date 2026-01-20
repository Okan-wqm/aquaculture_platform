import React from 'react';
import { IconProps } from '../types';

/**
 * Sand Filter Icon Component
 * You can customize this SVG or replace it with your own design
 */
export const SandFilterIcon: React.FC<IconProps> = ({
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
    <rect x="14" y="8" width="36" height="48" rx="4" stroke={color} strokeWidth="2" fill="none"/>
    <path d="M14 18h36" stroke={color} strokeWidth="2"/>
    <path d="M14 46h36" stroke={color} strokeWidth="2"/>
    {/* Sand dots */}
    <circle cx="24" cy="28" r="2" fill={color}/>
    <circle cx="32" cy="26" r="2" fill={color}/>
    <circle cx="40" cy="29" r="2" fill={color}/>
    <circle cx="28" cy="34" r="2" fill={color}/>
    <circle cx="36" cy="36" r="2" fill={color}/>
    <circle cx="24" cy="40" r="2" fill={color}/>
    <circle cx="40" cy="38" r="2" fill={color}/>
    <path d="M32 8v-4" stroke={color} strokeWidth="2"/>
    <path d="M32 60v-4" stroke={color} strokeWidth="2"/>
  </svg>
);

export default SandFilterIcon;
