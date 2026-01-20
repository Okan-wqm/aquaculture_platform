import React from 'react';

interface IconProps {
  size?: number;
  className?: string;
  color?: string;
}

// Fish Tank - circular/rectangular tank
export const FishTankIcon: React.FC<IconProps> = ({ size = 24, className = '', color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} stroke={color} strokeWidth="1.5">
    <rect x="3" y="4" width="18" height="14" rx="2" />
    <path d="M3 8h18" />
    <path d="M7 12c1 1 2 1 3 0s2-1 3 0 2 1 3 0" />
    <circle cx="8" cy="14" r="1" fill={color} />
    <circle cx="16" cy="13" r="1" fill={color} />
  </svg>
);

// Raceway - long flow-through tank
export const RacewayIcon: React.FC<IconProps> = ({ size = 24, className = '', color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} stroke={color} strokeWidth="1.5">
    <rect x="2" y="8" width="20" height="8" rx="1" />
    <path d="M5 8v-2h3v2" />
    <path d="M16 16v2h3v-2" />
    <path d="M6 12h12" strokeDasharray="2 2" />
    <path d="M4 12l2-1v2l-2-1z" fill={color} />
  </svg>
);

// Water Pump
export const WaterPumpIcon: React.FC<IconProps> = ({ size = 24, className = '', color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} stroke={color} strokeWidth="1.5">
    <circle cx="12" cy="12" r="6" />
    <path d="M12 6v-3" />
    <path d="M12 21v-3" />
    <path d="M6 12H3" />
    <path d="M21 12h-3" />
    <path d="M12 9l2 3-2 3-2-3 2-3z" fill={color} />
  </svg>
);

// Drum Filter
export const DrumFilterIcon: React.FC<IconProps> = ({ size = 24, className = '', color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} stroke={color} strokeWidth="1.5">
    <ellipse cx="12" cy="12" rx="8" ry="4" />
    <path d="M4 12v0c0 2.2 3.6 4 8 4s8-1.8 8-4" />
    <path d="M4 12c0-2.2 3.6-4 8-4s8 1.8 8 4" />
    <line x1="12" y1="8" x2="12" y2="16" />
    <line x1="8" y1="9" x2="8" y2="15" />
    <line x1="16" y1="9" x2="16" y2="15" />
  </svg>
);

// Blower
export const BlowerIcon: React.FC<IconProps> = ({ size = 24, className = '', color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} stroke={color} strokeWidth="1.5">
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="2" fill={color} />
    <path d="M12 5c2 2 2 3 0 5" />
    <path d="M19 12c-2 2-3 2-5 0" />
    <path d="M12 19c-2-2-2-3 0-5" />
    <path d="M5 12c2-2 3-2 5 0" />
  </svg>
);

// Biofilter
export const BiofilterIcon: React.FC<IconProps> = ({ size = 24, className = '', color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} stroke={color} strokeWidth="1.5">
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <circle cx="8" cy="8" r="1.5" fill={color} />
    <circle cx="12" cy="8" r="1.5" fill={color} />
    <circle cx="16" cy="8" r="1.5" fill={color} />
    <circle cx="8" cy="12" r="1.5" fill={color} />
    <circle cx="12" cy="12" r="1.5" fill={color} />
    <circle cx="16" cy="12" r="1.5" fill={color} />
    <circle cx="8" cy="16" r="1.5" fill={color} />
    <circle cx="12" cy="16" r="1.5" fill={color} />
    <circle cx="16" cy="16" r="1.5" fill={color} />
  </svg>
);

// Auto Feeder
export const AutoFeederIcon: React.FC<IconProps> = ({ size = 24, className = '', color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} stroke={color} strokeWidth="1.5">
    <path d="M8 4h8l2 6H6l2-6z" />
    <rect x="6" y="10" width="12" height="8" rx="1" />
    <path d="M12 18v3" />
    <path d="M9 21h6" />
    <circle cx="12" cy="14" r="2" />
  </svg>
);

// Aerator
export const AeratorIcon: React.FC<IconProps> = ({ size = 24, className = '', color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} stroke={color} strokeWidth="1.5">
    <circle cx="12" cy="16" r="4" />
    <path d="M12 12v-8" />
    <path d="M9 6l3-3 3 3" />
    <circle cx="8" cy="18" r="1" fill={color} />
    <circle cx="12" cy="20" r="1" fill={color} />
    <circle cx="16" cy="18" r="1" fill={color} />
  </svg>
);

// Heat Exchanger
export const HeatExchangerIcon: React.FC<IconProps> = ({ size = 24, className = '', color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} stroke={color} strokeWidth="1.5">
    <rect x="4" y="6" width="16" height="12" rx="2" />
    <path d="M4 10h16" />
    <path d="M4 14h16" />
    <path d="M8 6v-2" />
    <path d="M16 6v-2" />
    <path d="M8 18v2" />
    <path d="M16 18v2" />
  </svg>
);

// Chiller
export const ChillerIcon: React.FC<IconProps> = ({ size = 24, className = '', color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} stroke={color} strokeWidth="1.5">
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <path d="M12 4v4" />
    <path d="M12 16v4" />
    <path d="M4 12h4" />
    <path d="M16 12h4" />
    <path d="M8 8l2 2" />
    <path d="M14 14l2 2" />
    <path d="M14 8l2 2" />
    <path d="M8 14l2 2" />
    <circle cx="12" cy="12" r="2" />
  </svg>
);

// UV Sterilizer
export const UVSterilizerIcon: React.FC<IconProps> = ({ size = 24, className = '', color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} stroke={color} strokeWidth="1.5">
    <rect x="8" y="3" width="8" height="18" rx="2" />
    <line x1="12" y1="6" x2="12" y2="18" stroke="#9333ea" strokeWidth="2" />
    <path d="M5 8l2 1" stroke="#9333ea" />
    <path d="M5 12l2 0" stroke="#9333ea" />
    <path d="M5 16l2-1" stroke="#9333ea" />
    <path d="M19 8l-2 1" stroke="#9333ea" />
    <path d="M19 12l-2 0" stroke="#9333ea" />
    <path d="M19 16l-2-1" stroke="#9333ea" />
  </svg>
);

// Ozone Generator
export const OzoneGeneratorIcon: React.FC<IconProps> = ({ size = 24, className = '', color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} stroke={color} strokeWidth="1.5">
    <rect x="5" y="4" width="14" height="16" rx="2" />
    <circle cx="12" cy="10" r="3" />
    <text x="12" y="12" textAnchor="middle" fontSize="6" fill={color}>O3</text>
    <path d="M8 16h8" />
    <path d="M10 18h4" />
  </svg>
);

// Multiparameter Probe (Sensor)
export const MultiparameterProbeIcon: React.FC<IconProps> = ({ size = 24, className = '', color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} stroke={color} strokeWidth="1.5">
    <rect x="8" y="2" width="8" height="6" rx="1" />
    <path d="M10 8v10" />
    <path d="M14 8v10" />
    <circle cx="10" cy="20" r="2" fill={color} />
    <circle cx="14" cy="20" r="2" fill={color} />
    <path d="M6 5h2" />
    <path d="M16 5h2" />
  </svg>
);

// Default/Generic Equipment
export const DefaultEquipmentIcon: React.FC<IconProps> = ({ size = 24, className = '', color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" className={className} stroke={color} strokeWidth="1.5">
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <circle cx="12" cy="12" r="4" />
    <path d="M12 8v-2" />
    <path d="M12 18v-2" />
    <path d="M8 12H6" />
    <path d="M18 12h-2" />
  </svg>
);

// Equipment icon mapping by equipment type code
export const EquipmentIcons: Record<string, React.FC<IconProps>> = {
  'fish-tank': FishTankIcon,
  'tank': FishTankIcon,
  'raceway': RacewayIcon,
  'water-pump': WaterPumpIcon,
  'pump': WaterPumpIcon,
  'drum-filter': DrumFilterIcon,
  'filter': DrumFilterIcon,
  'blower': BlowerIcon,
  'biofilter': BiofilterIcon,
  'auto-feeder': AutoFeederIcon,
  'feeder': AutoFeederIcon,
  'aerator': AeratorIcon,
  'heat-exchanger': HeatExchangerIcon,
  'heater': HeatExchangerIcon,
  'chiller': ChillerIcon,
  'uv-sterilizer': UVSterilizerIcon,
  'uv': UVSterilizerIcon,
  'ozone-generator': OzoneGeneratorIcon,
  'ozone': OzoneGeneratorIcon,
  'multiparameter-probe': MultiparameterProbeIcon,
  'probe': MultiparameterProbeIcon,
  'sensor': MultiparameterProbeIcon,
};

// Get icon component by equipment type code
export const getEquipmentIcon = (code: string): React.FC<IconProps> => {
  const normalizedCode = code.toLowerCase().replace(/_/g, '-');
  return EquipmentIcons[normalizedCode] || DefaultEquipmentIcon;
};

// Get all available equipment icons for palette
export const getAllEquipmentIcons = () => {
  return [
    { code: 'fish-tank', name: 'Fish Tank', icon: FishTankIcon, category: 'tank' },
    { code: 'raceway', name: 'Raceway', icon: RacewayIcon, category: 'tank' },
    { code: 'water-pump', name: 'Water Pump', icon: WaterPumpIcon, category: 'pump' },
    { code: 'drum-filter', name: 'Drum Filter', icon: DrumFilterIcon, category: 'filtration' },
    { code: 'biofilter', name: 'Biofilter', icon: BiofilterIcon, category: 'filtration' },
    { code: 'blower', name: 'Blower', icon: BlowerIcon, category: 'aeration' },
    { code: 'aerator', name: 'Aerator', icon: AeratorIcon, category: 'aeration' },
    { code: 'auto-feeder', name: 'Auto Feeder', icon: AutoFeederIcon, category: 'feeding' },
    { code: 'heat-exchanger', name: 'Heat Exchanger', icon: HeatExchangerIcon, category: 'heating_cooling' },
    { code: 'chiller', name: 'Chiller', icon: ChillerIcon, category: 'heating_cooling' },
    { code: 'uv-sterilizer', name: 'UV Sterilizer', icon: UVSterilizerIcon, category: 'water_treatment' },
    { code: 'ozone-generator', name: 'Ozone Generator', icon: OzoneGeneratorIcon, category: 'water_treatment' },
    { code: 'multiparameter-probe', name: 'Multiparameter Probe', icon: MultiparameterProbeIcon, category: 'monitoring' },
  ];
};
