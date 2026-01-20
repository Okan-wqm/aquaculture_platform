import React from 'react';
import { IconProps } from '../types';

/**
 * Fan Icon Component
 * You can customize this SVG or replace it with your own design
 */
export const FanIcon: React.FC<IconProps> = ({
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
    <circle cx="32" cy="32" r="20" stroke={color} strokeWidth="2" fill="none"/>
    <circle cx="32" cy="32" r="6" fill={color}/>
    <path d="M32 12c4 6 4 10 0 14" stroke={color} strokeWidth="2" fill="none"/>
    <path d="M52 32c-6 4-10 4-14 0" stroke={color} strokeWidth="2" fill="none"/>
    <path d="M32 52c-4-6-4-10 0-14" stroke={color} strokeWidth="2" fill="none"/>
    <path d="M12 32c6-4 10-4 14 0" stroke={color} strokeWidth="2" fill="none"/>
  </svg>
);

export default FanIcon;
