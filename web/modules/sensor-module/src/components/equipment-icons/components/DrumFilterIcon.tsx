import React from 'react';
import { IconProps } from '../types';

/**
 * Drum Filter Icon Component
 * You can customize this SVG or replace it with your own design
 */
export const DrumFilterIcon: React.FC<IconProps> = ({
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
    <ellipse cx="32" cy="32" rx="24" ry="12" stroke={color} strokeWidth="2" fill="none"/>
    <path d="M8 32c0 6.6 10.7 12 24 12s24-5.4 24-12" stroke={color} strokeWidth="2" fill="none"/>
    <path d="M8 32c0-6.6 10.7-12 24-12s24 5.4 24 12" stroke={color} strokeWidth="2" fill="none"/>
    <line x1="32" y1="20" x2="32" y2="44" stroke={color} strokeWidth="2"/>
    <line x1="20" y1="22" x2="20" y2="42" stroke={color} strokeWidth="2"/>
    <line x1="44" y1="22" x2="44" y2="42" stroke={color} strokeWidth="2"/>
    <path d="M6 32H2" stroke={color} strokeWidth="2"/>
    <path d="M62 32h-4" stroke={color} strokeWidth="2"/>
  </svg>
);

export default DrumFilterIcon;
