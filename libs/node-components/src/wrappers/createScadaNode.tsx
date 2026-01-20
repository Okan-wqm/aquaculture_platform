import React, { ComponentType, createContext, useContext } from 'react';
import { NodeProps } from 'reactflow';

/**
 * Sensor reading interface
 */
export interface SensorReading {
  id: string;
  name: string;
  value: number;
  unit: string;
  status: 'normal' | 'warning' | 'critical';
}

/**
 * Sensor data store interface
 */
export interface SensorDataStore {
  [equipmentId: string]: SensorReading[];
}

/**
 * SCADA Context for providing sensor data to wrapped nodes
 */
interface ScadaContextValue {
  sensorData: SensorDataStore;
}

const ScadaContext = createContext<ScadaContextValue>({ sensorData: {} });

/**
 * Provider component for SCADA sensor data
 */
export const ScadaProvider: React.FC<{
  sensorData: SensorDataStore;
  children: React.ReactNode;
}> = ({ sensorData, children }) => {
  return (
    <ScadaContext.Provider value={{ sensorData }}>
      {children}
    </ScadaContext.Provider>
  );
};

/**
 * Hook to access SCADA sensor data
 */
export const useScadaData = () => useContext(ScadaContext);

/**
 * Get status color class
 */
const getSensorStatusColor = (status: SensorReading['status']): string => {
  switch (status) {
    case 'critical':
      return 'critical';
    case 'warning':
      return 'warning';
    default:
      return 'normal';
  }
};

/**
 * Get status background color
 */
const getStatusBgColor = (status: SensorReading['status']): string => {
  switch (status) {
    case 'critical':
      return '#ef4444';
    case 'warning':
      return '#eab308';
    default:
      return '#22c55e';
  }
};

/**
 * Create a SCADA-enabled wrapper for a node component
 *
 * This wrapper adds:
 * - Sensor data overlay (top-right)
 * - Alert indicator (top-left when warning/critical)
 * - Read-only mode flag in data
 *
 * @param BaseNodeComponent - The base node component to wrap
 * @returns Wrapped component with SCADA overlay
 *
 * @example
 * ```typescript
 * const ScadaBlowerNode = createScadaNode(BlowerNode);
 * ```
 */
export function createScadaNode<P extends NodeProps>(
  BaseNodeComponent: ComponentType<P>
): ComponentType<P> {
  const ScadaWrapper: React.FC<P> = (props) => {
    const { data } = props;
    const { sensorData } = useScadaData();

    const equipmentId = data?.equipmentId as string | undefined;
    const sensors = equipmentId ? (sensorData[equipmentId] || []) : [];
    const hasAlerts = sensors.some(
      (s) => s.status === 'warning' || s.status === 'critical'
    );
    const hasCritical = sensors.some((s) => s.status === 'critical');

    return (
      <div className="scada-node-wrapper" style={{ position: 'relative' }}>
        {/* Base node render */}
        <BaseNodeComponent {...props} />

        {/* Sensor overlay (top-right corner) */}
        {sensors.length > 0 && (
          <div
            style={{
              position: 'absolute',
              top: -8,
              right: -8,
              zIndex: 20,
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              alignItems: 'flex-end',
            }}
          >
            {sensors.slice(0, 3).map((sensor, idx) => (
              <span
                key={idx}
                className={`sensor-badge ${getSensorStatusColor(sensor.status)}`}
                style={{
                  padding: '2px 6px',
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 'bold',
                  backgroundColor:
                    sensor.status === 'critical'
                      ? '#fee2e2'
                      : sensor.status === 'warning'
                      ? '#fef9c3'
                      : '#dcfce7',
                  color:
                    sensor.status === 'critical'
                      ? '#dc2626'
                      : sensor.status === 'warning'
                      ? '#ca8a04'
                      : '#16a34a',
                  border: `1px solid ${getStatusBgColor(sensor.status)}`,
                }}
              >
                {sensor.value.toFixed(1)} {sensor.unit}
              </span>
            ))}
          </div>
        )}

        {/* Alert indicator (top-left corner) */}
        {hasAlerts && (
          <div
            style={{
              position: 'absolute',
              top: -4,
              left: -4,
              width: 12,
              height: 12,
              borderRadius: '50%',
              backgroundColor: hasCritical ? '#ef4444' : '#eab308',
              animation: 'pulse 1.5s infinite',
              zIndex: 20,
            }}
          />
        )}
      </div>
    );
  };

  // Preserve display name for debugging
  ScadaWrapper.displayName = `Scada(${
    BaseNodeComponent.displayName || BaseNodeComponent.name || 'Component'
  })`;

  return ScadaWrapper as ComponentType<P>;
}

/**
 * Create SCADA node types from a nodeTypes object
 *
 * @param nodeTypes - Object mapping node type ids to components
 * @returns New object with all components wrapped in createScadaNode
 *
 * @example
 * ```typescript
 * const scadaNodeTypes = createScadaNodeTypes(nodeTypes);
 * ```
 */
export function createScadaNodeTypes<T extends Record<string, ComponentType<NodeProps>>>(
  nodeTypes: T
): T {
  const result: Record<string, ComponentType<NodeProps>> = {};

  Object.entries(nodeTypes).forEach(([key, component]) => {
    result[key] = createScadaNode(component);
  });

  return result as T;
}
