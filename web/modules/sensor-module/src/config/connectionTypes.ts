/**
 * P&ID (Process & Instrumentation Diagram) Connection Types
 * Based on ISA-5.1 Standard for professional process diagrams
 */

export type ConnectionType =
  | 'process-pipe'    // Main process lines
  | 'electrical'      // Electrical signals
  | 'pneumatic'       // Pneumatic/air signals
  | 'hydraulic'       // Hydraulic lines
  | 'instrument'      // Instrument signals
  | 'data-link'       // Data/communication
  | 'capillary'       // Capillary tubes
  | 'steam'           // Steam lines
  | 'drain-vent';     // Drain/vent lines

export interface ConnectionTypeConfig {
  id: ConnectionType;
  label: string;
  color: string;
  strokeWidth: number;
  strokeDasharray: string;
  description: string;
}

export const CONNECTION_TYPES: ConnectionTypeConfig[] = [
  {
    id: 'process-pipe',
    label: 'Process Piping',
    color: '#1f2937',         // Gray-800 (Black)
    strokeWidth: 3,
    strokeDasharray: '',      // Solid
    description: 'Main process flow lines'
  },
  {
    id: 'electrical',
    label: 'Electrical Signal',
    color: '#dc2626',         // Red-600
    strokeWidth: 2,
    strokeDasharray: '8,4',   // Dashed
    description: '4-20mA, voltage signals'
  },
  {
    id: 'pneumatic',
    label: 'Pneumatic Signal',
    color: '#2563eb',         // Blue-600
    strokeWidth: 2,
    strokeDasharray: '12,3,3,3', // Double marks
    description: 'Air/gas signal connections'
  },
  {
    id: 'hydraulic',
    label: 'Hydraulic Line',
    color: '#16a34a',         // Green-600
    strokeWidth: 2,
    strokeDasharray: '12,4,4,4', // Long-short dash
    description: 'Hydraulic fluid connections'
  },
  {
    id: 'instrument',
    label: 'Instrument Signal',
    color: '#ea580c',         // Orange-600
    strokeWidth: 2,
    strokeDasharray: '8,3,2,3', // Dash-dot
    description: 'Sensor and control signals'
  },
  {
    id: 'data-link',
    label: 'Data/Communication',
    color: '#7c3aed',         // Violet-600
    strokeWidth: 2,
    strokeDasharray: '2,4',   // Dotted
    description: 'Digital data transmission'
  },
  {
    id: 'capillary',
    label: 'Capillary Tube',
    color: '#6b7280',         // Gray-500
    strokeWidth: 1,
    strokeDasharray: '',      // Solid thin
    description: 'Capillary connections'
  },
  {
    id: 'steam',
    label: 'Steam Line',
    color: '#f97316',         // Orange-500
    strokeWidth: 3,
    strokeDasharray: '6,2',   // Short dash
    description: 'Steam process lines'
  },
  {
    id: 'drain-vent',
    label: 'Drain/Vent',
    color: '#0891b2',         // Cyan-600
    strokeWidth: 2,
    strokeDasharray: '4,4,1,4', // Dash-dot-dot
    description: 'Drainage and ventilation'
  }
];

export const DEFAULT_CONNECTION_TYPE: ConnectionType = 'process-pipe';

/**
 * Get configuration for a specific connection type
 */
export const getConnectionTypeConfig = (type: ConnectionType | string): ConnectionTypeConfig => {
  // Normalize legacy connection types
  const normalizedType = normalizeConnectionType(type);
  return CONNECTION_TYPES.find(t => t.id === normalizedType) ?? CONNECTION_TYPES[0];
};

/**
 * Normalize legacy connection types to new P&ID standard types
 * Provides backwards compatibility for existing saved processes
 */
export const normalizeConnectionType = (type: string): ConnectionType => {
  switch (type) {
    case 'pipe':
    case 'default':
      return 'process-pipe';
    case 'cable':
      return 'electrical';
    case 'signal':
      return 'instrument';
    default:
      // Check if it's already a valid ConnectionType
      if (CONNECTION_TYPES.some(t => t.id === type)) {
        return type as ConnectionType;
      }
      return 'process-pipe';
  }
};

/**
 * Get edge style object for ReactFlow
 */
export const getEdgeStyle = (connectionType: ConnectionType | string) => {
  const config = getConnectionTypeConfig(connectionType);
  return {
    stroke: config.color,
    strokeWidth: config.strokeWidth,
    strokeDasharray: config.strokeDasharray || undefined,
  };
};
