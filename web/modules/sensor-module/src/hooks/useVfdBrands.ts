import { useState, useCallback, useMemo } from 'react';
import {
  VfdBrand,
  VfdProtocol,
  VfdBrandInfo,
  VfdModelSeries,
  VfdProtocolSchema,
  VfdProtocolConfiguration,
  VFD_BRAND_NAMES,
  VFD_BRAND_DESCRIPTIONS,
  VFD_PROTOCOL_NAMES,
  VFD_PROTOCOL_DESCRIPTIONS,
  VFD_MODEL_SERIES,
  VFD_DEFAULT_MODBUS_RTU_CONFIG,
  VFD_DEFAULT_MODBUS_TCP_CONFIG,
  VFD_DEFAULT_PROFINET_CONFIG,
  VFD_DEFAULT_ETHERNET_IP_CONFIG,
  VFD_DEFAULT_CANOPEN_CONFIG,
  VFD_DEFAULT_BACNET_IP_CONFIG,
  ModbusRtuConfig,
} from '../types/vfd.types';

// API base URL
const API_URL = 'http://localhost:3000/graphql';

// GraphQL fetch helper
async function graphqlFetch<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const token = localStorage.getItem('access_token');

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors) {
    throw new Error(result.errors[0]?.message || 'GraphQL Error');
  }

  return result.data;
}

// GraphQL Queries
const GET_VFD_BRANDS_QUERY = `
  query GetVfdBrands {
    vfdBrands {
      code
      name
      supportedProtocols
      modelSeries
      defaultSerialConfig
    }
  }
`;

const GET_VFD_PROTOCOLS_QUERY = `
  query GetVfdProtocols {
    vfdProtocols {
      protocol
      displayName
      description
      connectionType
    }
  }
`;

const GET_VFD_PROTOCOL_SCHEMA_QUERY = `
  query GetVfdProtocolSchema($protocol: VfdProtocol!) {
    vfdProtocolSchema(protocol: $protocol) {
      protocol
      displayName
      description
      connectionType
      configurationSchema
      defaultConfiguration
    }
  }
`;

const GET_VFD_REGISTER_MAPPINGS_QUERY = `
  query GetVfdRegisterMappings($brand: VfdBrand!, $modelSeries: String!) {
    vfdRegisterMappings(brand: $brand, modelSeries: $modelSeries) {
      id
      parameterName
      displayName
      category
      registerAddress
      registerCount
      dataType
      scalingFactor
      unit
      isReadable
      isWritable
    }
  }
`;

// Brand to supported protocols mapping
const BRAND_PROTOCOLS: Record<VfdBrand, VfdProtocol[]> = {
  [VfdBrand.DANFOSS]: [
    VfdProtocol.MODBUS_RTU,
    VfdProtocol.MODBUS_TCP,
    VfdProtocol.PROFIBUS_DP,
    VfdProtocol.PROFINET,
    VfdProtocol.ETHERNET_IP,
    VfdProtocol.CANOPEN,
    VfdProtocol.BACNET_IP,
  ],
  [VfdBrand.ABB]: [
    VfdProtocol.MODBUS_RTU,
    VfdProtocol.MODBUS_TCP,
    VfdProtocol.PROFIBUS_DP,
    VfdProtocol.PROFINET,
    VfdProtocol.ETHERNET_IP,
    VfdProtocol.CANOPEN,
  ],
  [VfdBrand.SIEMENS]: [
    VfdProtocol.MODBUS_RTU,
    VfdProtocol.MODBUS_TCP,
    VfdProtocol.PROFIBUS_DP,
    VfdProtocol.PROFINET,
  ],
  [VfdBrand.SCHNEIDER]: [
    VfdProtocol.MODBUS_RTU,
    VfdProtocol.MODBUS_TCP,
    VfdProtocol.PROFIBUS_DP,
    VfdProtocol.ETHERNET_IP,
    VfdProtocol.CANOPEN,
  ],
  [VfdBrand.YASKAWA]: [
    VfdProtocol.MODBUS_RTU,
    VfdProtocol.MODBUS_TCP,
    VfdProtocol.PROFIBUS_DP,
    VfdProtocol.PROFINET,
    VfdProtocol.ETHERNET_IP,
  ],
  [VfdBrand.DELTA]: [
    VfdProtocol.MODBUS_RTU,
    VfdProtocol.MODBUS_TCP,
    VfdProtocol.CANOPEN,
    VfdProtocol.ETHERNET_IP,
  ],
  [VfdBrand.MITSUBISHI]: [
    VfdProtocol.MODBUS_RTU,
    VfdProtocol.MODBUS_TCP,
    VfdProtocol.PROFIBUS_DP,
    VfdProtocol.ETHERNET_IP,
    VfdProtocol.CANOPEN,
  ],
  [VfdBrand.ROCKWELL]: [
    VfdProtocol.MODBUS_RTU,
    VfdProtocol.MODBUS_TCP,
    VfdProtocol.ETHERNET_IP,
    VfdProtocol.PROFINET,
  ],
};

// Brand default serial configurations
const BRAND_DEFAULT_SERIAL_CONFIG: Record<VfdBrand, ModbusRtuConfig> = {
  [VfdBrand.DANFOSS]: { ...VFD_DEFAULT_MODBUS_RTU_CONFIG, baudRate: 9600, parity: 'none' },
  [VfdBrand.ABB]: { ...VFD_DEFAULT_MODBUS_RTU_CONFIG, baudRate: 19200, parity: 'even' },
  [VfdBrand.SIEMENS]: { ...VFD_DEFAULT_MODBUS_RTU_CONFIG, baudRate: 9600, parity: 'even' },
  [VfdBrand.SCHNEIDER]: { ...VFD_DEFAULT_MODBUS_RTU_CONFIG, baudRate: 19200, parity: 'even' },
  [VfdBrand.YASKAWA]: { ...VFD_DEFAULT_MODBUS_RTU_CONFIG, baudRate: 9600, parity: 'none' },
  [VfdBrand.DELTA]: { ...VFD_DEFAULT_MODBUS_RTU_CONFIG, baudRate: 9600, parity: 'none' },
  [VfdBrand.MITSUBISHI]: { ...VFD_DEFAULT_MODBUS_RTU_CONFIG, baudRate: 19200, parity: 'even' },
  [VfdBrand.ROCKWELL]: { ...VFD_DEFAULT_MODBUS_RTU_CONFIG, baudRate: 19200, parity: 'none' },
};

/**
 * Hook to get VFD brand information
 */
export function useVfdBrands() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Build brand info from static data
  const brands = useMemo((): VfdBrandInfo[] => {
    return Object.values(VfdBrand).map((brand) => ({
      code: brand,
      name: VFD_BRAND_NAMES[brand],
      description: VFD_BRAND_DESCRIPTIONS[brand],
      supportedProtocols: BRAND_PROTOCOLS[brand],
      modelSeries: VFD_MODEL_SERIES[brand],
      defaultSerialConfig: BRAND_DEFAULT_SERIAL_CONFIG[brand],
    }));
  }, []);

  // Fetch brands from server (optional, fallback to static data)
  const fetchBrands = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      await graphqlFetch<{ vfdBrands: VfdBrandInfo[] }>(GET_VFD_BRANDS_QUERY);
      // Server data could extend/override static data if needed
    } catch (err) {
      // Use static data as fallback
      console.warn('Using static VFD brand data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const getBrandByCode = useCallback(
    (code: VfdBrand): VfdBrandInfo | undefined => {
      return brands.find((b) => b.code === code);
    },
    [brands]
  );

  const getProtocolsForBrand = useCallback(
    (brand: VfdBrand): VfdProtocol[] => {
      return BRAND_PROTOCOLS[brand] || [];
    },
    []
  );

  const getModelSeriesForBrand = useCallback(
    (brand: VfdBrand): VfdModelSeries[] => {
      return VFD_MODEL_SERIES[brand] || [];
    },
    []
  );

  const getDefaultSerialConfig = useCallback(
    (brand: VfdBrand): ModbusRtuConfig => {
      return BRAND_DEFAULT_SERIAL_CONFIG[brand] || VFD_DEFAULT_MODBUS_RTU_CONFIG;
    },
    []
  );

  return {
    brands,
    loading,
    error,
    fetchBrands,
    getBrandByCode,
    getProtocolsForBrand,
    getModelSeriesForBrand,
    getDefaultSerialConfig,
  };
}

/**
 * Hook to get VFD protocol information
 */
export function useVfdProtocols() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // Build protocol info from static data
  const protocols = useMemo(() => {
    return Object.values(VfdProtocol).map((protocol) => ({
      protocol,
      displayName: VFD_PROTOCOL_NAMES[protocol],
      description: VFD_PROTOCOL_DESCRIPTIONS[protocol],
      connectionType: getConnectionType(protocol),
    }));
  }, []);

  const fetchProtocols = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      await graphqlFetch<{ vfdProtocols: unknown[] }>(GET_VFD_PROTOCOLS_QUERY);
    } catch (err) {
      console.warn('Using static VFD protocol data:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const getProtocolSchema = useCallback(
    async (protocol: VfdProtocol): Promise<VfdProtocolSchema | null> => {
      setLoading(true);
      setError(null);

      try {
        const data = await graphqlFetch<{ vfdProtocolSchema: VfdProtocolSchema }>(
          GET_VFD_PROTOCOL_SCHEMA_QUERY,
          { protocol }
        );
        return data.vfdProtocolSchema;
      } catch (err) {
        // Return default schema
        return getDefaultProtocolSchema(protocol);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const getDefaultConfiguration = useCallback(
    (protocol: VfdProtocol): VfdProtocolConfiguration => {
      switch (protocol) {
        case VfdProtocol.MODBUS_RTU:
          return { ...VFD_DEFAULT_MODBUS_RTU_CONFIG };
        case VfdProtocol.MODBUS_TCP:
          return { ...VFD_DEFAULT_MODBUS_TCP_CONFIG };
        case VfdProtocol.PROFINET:
          return { ...VFD_DEFAULT_PROFINET_CONFIG };
        case VfdProtocol.ETHERNET_IP:
          return { ...VFD_DEFAULT_ETHERNET_IP_CONFIG };
        case VfdProtocol.CANOPEN:
          return { ...VFD_DEFAULT_CANOPEN_CONFIG };
        case VfdProtocol.BACNET_IP:
          return { ...VFD_DEFAULT_BACNET_IP_CONFIG };
        default:
          return { ...VFD_DEFAULT_MODBUS_RTU_CONFIG };
      }
    },
    []
  );

  return {
    protocols,
    loading,
    error,
    fetchProtocols,
    getProtocolSchema,
    getDefaultConfiguration,
  };
}

/**
 * Hook for VFD register mappings
 */
export function useVfdRegisterMappings() {
  const [mappings, setMappings] = useState<unknown[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const fetchMappings = useCallback(async (brand: VfdBrand, modelSeries: string) => {
    setLoading(true);
    setError(null);

    try {
      const data = await graphqlFetch<{ vfdRegisterMappings: unknown[] }>(
        GET_VFD_REGISTER_MAPPINGS_QUERY,
        { brand, modelSeries }
      );
      setMappings(data.vfdRegisterMappings);
    } catch (err) {
      setError(err as Error);
    } finally {
      setLoading(false);
    }
  }, []);

  return {
    mappings,
    loading,
    error,
    fetchMappings,
  };
}

// Helper functions
function getConnectionType(protocol: VfdProtocol): 'serial' | 'ethernet' | 'fieldbus' {
  switch (protocol) {
    case VfdProtocol.MODBUS_RTU:
    case VfdProtocol.BACNET_MSTP:
      return 'serial';
    case VfdProtocol.MODBUS_TCP:
    case VfdProtocol.PROFINET:
    case VfdProtocol.ETHERNET_IP:
    case VfdProtocol.BACNET_IP:
      return 'ethernet';
    case VfdProtocol.PROFIBUS_DP:
    case VfdProtocol.CANOPEN:
      return 'fieldbus';
    default:
      return 'serial';
  }
}

function getDefaultProtocolSchema(protocol: VfdProtocol): VfdProtocolSchema {
  const connectionType = getConnectionType(protocol);

  return {
    protocol,
    displayName: VFD_PROTOCOL_NAMES[protocol],
    description: VFD_PROTOCOL_DESCRIPTIONS[protocol],
    connectionType,
    configurationSchema: getConfigurationSchema(protocol),
    defaultConfiguration: getDefaultConfig(protocol),
  };
}

function getDefaultConfig(protocol: VfdProtocol): VfdProtocolConfiguration {
  switch (protocol) {
    case VfdProtocol.MODBUS_RTU:
      return VFD_DEFAULT_MODBUS_RTU_CONFIG;
    case VfdProtocol.MODBUS_TCP:
      return VFD_DEFAULT_MODBUS_TCP_CONFIG;
    case VfdProtocol.PROFINET:
      return VFD_DEFAULT_PROFINET_CONFIG;
    case VfdProtocol.ETHERNET_IP:
      return VFD_DEFAULT_ETHERNET_IP_CONFIG;
    case VfdProtocol.CANOPEN:
      return VFD_DEFAULT_CANOPEN_CONFIG;
    case VfdProtocol.BACNET_IP:
      return VFD_DEFAULT_BACNET_IP_CONFIG;
    default:
      return VFD_DEFAULT_MODBUS_RTU_CONFIG;
  }
}

function getConfigurationSchema(protocol: VfdProtocol): VfdProtocolSchema['configurationSchema'] {
  switch (protocol) {
    case VfdProtocol.MODBUS_RTU:
      return {
        type: 'object',
        required: ['serialPort', 'slaveId', 'baudRate'],
        properties: {
          serialPort: {
            type: 'string',
            title: 'Serial Port',
            description: 'COM port (e.g., COM1, /dev/ttyUSB0)',
            'ui:placeholder': 'COM1',
            'ui:order': 1,
            'ui:group': 'connection',
          },
          slaveId: {
            type: 'integer',
            title: 'Slave ID',
            description: 'Modbus slave address (1-247)',
            minimum: 1,
            maximum: 247,
            default: 1,
            'ui:order': 2,
            'ui:group': 'connection',
          },
          baudRate: {
            type: 'integer',
            title: 'Baud Rate',
            enum: [4800, 9600, 19200, 38400, 57600, 115200],
            default: 9600,
            'ui:order': 3,
            'ui:group': 'serial',
          },
          dataBits: {
            type: 'integer',
            title: 'Data Bits',
            enum: [7, 8],
            default: 8,
            'ui:order': 4,
            'ui:group': 'serial',
          },
          parity: {
            type: 'string',
            title: 'Parity',
            enum: ['none', 'even', 'odd'],
            enumNames: ['None', 'Even', 'Odd'],
            default: 'none',
            'ui:order': 5,
            'ui:group': 'serial',
          },
          stopBits: {
            type: 'integer',
            title: 'Stop Bits',
            enum: [1, 2],
            default: 1,
            'ui:order': 6,
            'ui:group': 'serial',
          },
          timeout: {
            type: 'integer',
            title: 'Timeout (ms)',
            description: 'Response timeout in milliseconds',
            minimum: 100,
            maximum: 10000,
            default: 1000,
            'ui:order': 7,
            'ui:group': 'timing',
          },
          retryCount: {
            type: 'integer',
            title: 'Retry Count',
            minimum: 0,
            maximum: 10,
            default: 3,
            'ui:order': 8,
            'ui:group': 'timing',
          },
        },
        'ui:groups': [
          { name: 'connection', title: 'Connection', fields: ['serialPort', 'slaveId'] },
          { name: 'serial', title: 'Serial Settings', fields: ['baudRate', 'dataBits', 'parity', 'stopBits'] },
          { name: 'timing', title: 'Timing', fields: ['timeout', 'retryCount'] },
        ],
      };

    case VfdProtocol.MODBUS_TCP:
      return {
        type: 'object',
        required: ['host', 'port', 'unitId'],
        properties: {
          host: {
            type: 'string',
            title: 'IP Address',
            description: 'VFD IP address',
            format: 'ipv4',
            'ui:placeholder': '192.168.1.100',
            'ui:order': 1,
            'ui:group': 'connection',
          },
          port: {
            type: 'integer',
            title: 'Port',
            minimum: 1,
            maximum: 65535,
            default: 502,
            'ui:order': 2,
            'ui:group': 'connection',
          },
          unitId: {
            type: 'integer',
            title: 'Unit ID',
            minimum: 1,
            maximum: 247,
            default: 1,
            'ui:order': 3,
            'ui:group': 'connection',
          },
          connectionTimeout: {
            type: 'integer',
            title: 'Connection Timeout (ms)',
            minimum: 1000,
            maximum: 30000,
            default: 5000,
            'ui:order': 4,
            'ui:group': 'timing',
          },
          responseTimeout: {
            type: 'integer',
            title: 'Response Timeout (ms)',
            minimum: 500,
            maximum: 10000,
            default: 3000,
            'ui:order': 5,
            'ui:group': 'timing',
          },
          keepAlive: {
            type: 'boolean',
            title: 'Keep Connection Alive',
            default: true,
            'ui:order': 6,
            'ui:group': 'advanced',
          },
        },
        'ui:groups': [
          { name: 'connection', title: 'Connection', fields: ['host', 'port', 'unitId'] },
          { name: 'timing', title: 'Timing', fields: ['connectionTimeout', 'responseTimeout'] },
          { name: 'advanced', title: 'Advanced', fields: ['keepAlive'], collapsed: true },
        ],
      };

    case VfdProtocol.PROFINET:
      return {
        type: 'object',
        required: ['deviceName', 'ipAddress'],
        properties: {
          deviceName: {
            type: 'string',
            title: 'Device Name',
            description: 'PROFINET device name',
            'ui:placeholder': 'vfd-device-01',
            'ui:order': 1,
          },
          ipAddress: {
            type: 'string',
            title: 'IP Address',
            format: 'ipv4',
            'ui:placeholder': '192.168.1.100',
            'ui:order': 2,
          },
          subnetMask: {
            type: 'string',
            title: 'Subnet Mask',
            default: '255.255.255.0',
            'ui:order': 3,
          },
          gateway: {
            type: 'string',
            title: 'Gateway',
            format: 'ipv4',
            'ui:order': 4,
          },
          updateRate: {
            type: 'integer',
            title: 'Update Rate (ms)',
            minimum: 1,
            maximum: 512,
            default: 32,
            'ui:order': 5,
          },
        },
      };

    case VfdProtocol.ETHERNET_IP:
      return {
        type: 'object',
        required: ['host', 'port'],
        properties: {
          host: {
            type: 'string',
            title: 'IP Address',
            format: 'ipv4',
            'ui:placeholder': '192.168.1.100',
            'ui:order': 1,
          },
          port: {
            type: 'integer',
            title: 'Port',
            default: 44818,
            'ui:order': 2,
          },
          rpi: {
            type: 'integer',
            title: 'RPI (ms)',
            description: 'Requested Packet Interval',
            minimum: 2,
            maximum: 3200,
            default: 10,
            'ui:order': 3,
          },
          connectionType: {
            type: 'string',
            title: 'Connection Type',
            enum: ['exclusive', 'inputOnly', 'listenOnly'],
            enumNames: ['Exclusive Owner', 'Input Only', 'Listen Only'],
            default: 'exclusive',
            'ui:order': 4,
          },
        },
      };

    case VfdProtocol.CANOPEN:
      return {
        type: 'object',
        required: ['nodeId', 'baudRate', 'interface'],
        properties: {
          nodeId: {
            type: 'integer',
            title: 'Node ID',
            minimum: 1,
            maximum: 127,
            default: 1,
            'ui:order': 1,
          },
          baudRate: {
            type: 'integer',
            title: 'Baud Rate',
            enum: [10000, 20000, 50000, 125000, 250000, 500000, 800000, 1000000],
            enumNames: ['10 kbit/s', '20 kbit/s', '50 kbit/s', '125 kbit/s', '250 kbit/s', '500 kbit/s', '800 kbit/s', '1 Mbit/s'],
            default: 250000,
            'ui:order': 2,
          },
          interface: {
            type: 'string',
            title: 'CAN Interface',
            description: 'CAN interface name (e.g., can0)',
            'ui:placeholder': 'can0',
            'ui:order': 3,
          },
          heartbeatProducerTime: {
            type: 'integer',
            title: 'Heartbeat Time (ms)',
            minimum: 0,
            maximum: 65535,
            default: 1000,
            'ui:order': 4,
          },
        },
      };

    case VfdProtocol.BACNET_IP:
      return {
        type: 'object',
        required: ['ipAddress', 'port', 'deviceInstance'],
        properties: {
          ipAddress: {
            type: 'string',
            title: 'IP Address',
            format: 'ipv4',
            'ui:placeholder': '192.168.1.100',
            'ui:order': 1,
          },
          port: {
            type: 'integer',
            title: 'Port',
            default: 47808,
            'ui:order': 2,
          },
          deviceInstance: {
            type: 'integer',
            title: 'Device Instance',
            minimum: 0,
            maximum: 4194303,
            'ui:order': 3,
          },
          maxApduLength: {
            type: 'integer',
            title: 'Max APDU Length',
            default: 1476,
            'ui:order': 4,
          },
        },
      };

    default:
      return {
        type: 'object',
        required: [],
        properties: {},
      };
  }
}
