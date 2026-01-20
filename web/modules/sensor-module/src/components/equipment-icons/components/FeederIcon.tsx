import React from 'react';
import { IconProps } from '../types';

/**
 * Feeder Icon Component
 * You can customize this SVG or replace it with your own design
 */
export const FeederIcon: React.FC<IconProps> = ({
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
    <path d="M20 10h24l6 18H14l6-18z" stroke={color} strokeWidth="2" fill="none"/>
    <rect x="14" y="28" width="36" height="22" rx="2" stroke={color} strokeWidth="2" fill="none"/>
    <path d="M32 50v8" stroke={color} strokeWidth="2"/>
    <path d="M24 58h16" stroke={color} strokeWidth="2"/>
    <circle cx="32" cy="39" r="6" stroke={color} strokeWidth="2" fill="none"/>
  </svg>
);

export default FeederIcon;
