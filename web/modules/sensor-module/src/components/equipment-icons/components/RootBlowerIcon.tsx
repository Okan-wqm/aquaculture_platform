import React from 'react';
import { IconProps } from '../types';

/**
 * Root Blower Icon Component
 * You can customize this SVG or replace it with your own design
 */
export const RootBlowerIcon: React.FC<IconProps> = ({
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
    <ellipse cx="32" cy="32" rx="22" ry="16" stroke={color} strokeWidth="2" fill="none"/>
    <circle cx="22" cy="32" r="8" stroke={color} strokeWidth="2" fill="none"/>
    <circle cx="42" cy="32" r="8" stroke={color} strokeWidth="2" fill="none"/>
    <path d="M22 24v-8" stroke={color} strokeWidth="2"/>
    <path d="M42 24v-8" stroke={color} strokeWidth="2"/>
    <path d="M10 32H6" stroke={color} strokeWidth="2"/>
    <path d="M58 32h-4" stroke={color} strokeWidth="2"/>
  </svg>
);

export default RootBlowerIcon;
