import { Injectable, Logger } from '@nestjs/common';
import { ChannelDataType, DiscoverySource } from '../../database/entities/sensor-data-channel.entity';

/**
 * Discovered channel information from test reading
 */
export interface DiscoveredChannel {
  channelKey: string;
  suggestedLabel: string;
  inferredDataType: ChannelDataType;
  inferredUnit?: string;
  sampleValue?: unknown;
  dataPath?: string;
  suggestedMin?: number;
  suggestedMax?: number;
}

/**
 * Discovery result
 */
export interface DiscoveryResult {
  success: boolean;
  channels: DiscoveredChannel[];
  sampleData?: Record<string, unknown>;
  error?: string;
  rawPayload?: unknown;
}

/**
 * Known aquaculture parameters with their metadata
 */
const KNOWN_PARAMETERS: Record<string, {
  label: string;
  unit: string;
  min: number;
  max: number;
  dataType: ChannelDataType;
}> = {
  // Temperature variants
  temperature: { label: 'Temperature', unit: '°C', min: 0, max: 40, dataType: ChannelDataType.NUMBER },
  temp: { label: 'Temperature', unit: '°C', min: 0, max: 40, dataType: ChannelDataType.NUMBER },
  water_temperature: { label: 'Water Temperature', unit: '°C', min: 0, max: 40, dataType: ChannelDataType.NUMBER },
  water_temp: { label: 'Water Temperature', unit: '°C', min: 0, max: 40, dataType: ChannelDataType.NUMBER },

  // pH variants
  ph: { label: 'pH', unit: 'pH', min: 0, max: 14, dataType: ChannelDataType.NUMBER },
  ph_level: { label: 'pH Level', unit: 'pH', min: 0, max: 14, dataType: ChannelDataType.NUMBER },

  // Dissolved Oxygen variants
  dissolved_oxygen: { label: 'Dissolved Oxygen', unit: 'mg/L', min: 0, max: 20, dataType: ChannelDataType.NUMBER },
  do: { label: 'Dissolved Oxygen', unit: 'mg/L', min: 0, max: 20, dataType: ChannelDataType.NUMBER },
  do_level: { label: 'Dissolved Oxygen', unit: 'mg/L', min: 0, max: 20, dataType: ChannelDataType.NUMBER },
  oxygen: { label: 'Dissolved Oxygen', unit: 'mg/L', min: 0, max: 20, dataType: ChannelDataType.NUMBER },
  o2: { label: 'Dissolved Oxygen', unit: 'mg/L', min: 0, max: 20, dataType: ChannelDataType.NUMBER },

  // Salinity variants
  salinity: { label: 'Salinity', unit: 'ppt', min: 0, max: 50, dataType: ChannelDataType.NUMBER },
  salt: { label: 'Salinity', unit: 'ppt', min: 0, max: 50, dataType: ChannelDataType.NUMBER },

  // Ammonia variants
  ammonia: { label: 'Ammonia', unit: 'mg/L', min: 0, max: 10, dataType: ChannelDataType.NUMBER },
  nh3: { label: 'Ammonia', unit: 'mg/L', min: 0, max: 10, dataType: ChannelDataType.NUMBER },
  nh4: { label: 'Ammonium', unit: 'mg/L', min: 0, max: 10, dataType: ChannelDataType.NUMBER },
  total_ammonia: { label: 'Total Ammonia Nitrogen', unit: 'mg/L', min: 0, max: 10, dataType: ChannelDataType.NUMBER },
  tan: { label: 'Total Ammonia Nitrogen', unit: 'mg/L', min: 0, max: 10, dataType: ChannelDataType.NUMBER },

  // Nitrite variants
  nitrite: { label: 'Nitrite', unit: 'mg/L', min: 0, max: 5, dataType: ChannelDataType.NUMBER },
  no2: { label: 'Nitrite', unit: 'mg/L', min: 0, max: 5, dataType: ChannelDataType.NUMBER },

  // Nitrate variants
  nitrate: { label: 'Nitrate', unit: 'mg/L', min: 0, max: 100, dataType: ChannelDataType.NUMBER },
  no3: { label: 'Nitrate', unit: 'mg/L', min: 0, max: 100, dataType: ChannelDataType.NUMBER },

  // Turbidity variants
  turbidity: { label: 'Turbidity', unit: 'NTU', min: 0, max: 1000, dataType: ChannelDataType.NUMBER },
  ntu: { label: 'Turbidity', unit: 'NTU', min: 0, max: 1000, dataType: ChannelDataType.NUMBER },

  // Water Level variants
  water_level: { label: 'Water Level', unit: 'cm', min: 0, max: 500, dataType: ChannelDataType.NUMBER },
  level: { label: 'Water Level', unit: 'cm', min: 0, max: 500, dataType: ChannelDataType.NUMBER },

  // Flow Rate variants
  flow_rate: { label: 'Flow Rate', unit: 'L/min', min: 0, max: 1000, dataType: ChannelDataType.NUMBER },
  flow: { label: 'Flow Rate', unit: 'L/min', min: 0, max: 1000, dataType: ChannelDataType.NUMBER },

  // Pressure variants
  pressure: { label: 'Pressure', unit: 'bar', min: 0, max: 10, dataType: ChannelDataType.NUMBER },

  // Conductivity variants
  conductivity: { label: 'Conductivity', unit: 'µS/cm', min: 0, max: 50000, dataType: ChannelDataType.NUMBER },
  ec: { label: 'Electrical Conductivity', unit: 'µS/cm', min: 0, max: 50000, dataType: ChannelDataType.NUMBER },

  // ORP variants
  orp: { label: 'ORP', unit: 'mV', min: -500, max: 500, dataType: ChannelDataType.NUMBER },
  redox: { label: 'ORP', unit: 'mV', min: -500, max: 500, dataType: ChannelDataType.NUMBER },

  // CO2 variants
  co2: { label: 'CO2', unit: 'mg/L', min: 0, max: 100, dataType: ChannelDataType.NUMBER },
  carbon_dioxide: { label: 'Carbon Dioxide', unit: 'mg/L', min: 0, max: 100, dataType: ChannelDataType.NUMBER },

  // Alkalinity variants
  alkalinity: { label: 'Alkalinity', unit: 'mg/L CaCO3', min: 0, max: 500, dataType: ChannelDataType.NUMBER },

  // TDS variants
  tds: { label: 'Total Dissolved Solids', unit: 'ppm', min: 0, max: 50000, dataType: ChannelDataType.NUMBER },

  // Chlorine variants
  chlorine: { label: 'Chlorine', unit: 'mg/L', min: 0, max: 10, dataType: ChannelDataType.NUMBER },
  cl: { label: 'Chlorine', unit: 'mg/L', min: 0, max: 10, dataType: ChannelDataType.NUMBER },

  // Humidity (for ambient sensors)
  humidity: { label: 'Humidity', unit: '%', min: 0, max: 100, dataType: ChannelDataType.NUMBER },

  // Battery/Status
  battery: { label: 'Battery Level', unit: '%', min: 0, max: 100, dataType: ChannelDataType.NUMBER },
  battery_level: { label: 'Battery Level', unit: '%', min: 0, max: 100, dataType: ChannelDataType.NUMBER },
  rssi: { label: 'Signal Strength', unit: 'dBm', min: -120, max: 0, dataType: ChannelDataType.NUMBER },
  signal: { label: 'Signal Strength', unit: 'dBm', min: -120, max: 0, dataType: ChannelDataType.NUMBER },
};

/**
 * Service for discovering data channels from sensor test readings
 */
@Injectable()
export class ChannelDiscoveryService {
  private readonly logger = new Logger(ChannelDiscoveryService.name);

  /**
   * Discover channels from sample data
   */
  async discoverChannels(
    sampleData: unknown,
    payloadFormat: 'json' | 'csv' | 'text' | 'binary' = 'json',
  ): Promise<DiscoveryResult> {
    try {
      let channels: DiscoveredChannel[] = [];

      if (!sampleData) {
        return {
          success: false,
          channels: [],
          error: 'No sample data provided',
        };
      }

      switch (payloadFormat) {
        case 'json':
          channels = this.discoverFromJson(sampleData as Record<string, unknown>);
          break;
        case 'csv':
          channels = this.discoverFromCsv(sampleData as string);
          break;
        case 'text':
          channels = this.discoverFromText(sampleData as string);
          break;
        default:
          return {
            success: false,
            channels: [],
            error: `Unsupported payload format: ${payloadFormat}`,
          };
      }

      return {
        success: true,
        channels,
        sampleData: typeof sampleData === 'object' ? sampleData as Record<string, unknown> : { raw: sampleData },
        rawPayload: sampleData,
      };
    } catch (error) {
      this.logger.error('Channel discovery failed', error);
      return {
        success: false,
        channels: [],
        error: (error as Error).message,
      };
    }
  }

  /**
   * Discover channels from JSON payload
   */
  discoverFromJson(payload: Record<string, unknown>, prefix = ''): DiscoveredChannel[] {
    const channels: DiscoveredChannel[] = [];

    if (!payload || typeof payload !== 'object') {
      return channels;
    }

    for (const [key, value] of Object.entries(payload)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      const normalizedKey = this.normalizeKey(key);

      // Skip metadata fields
      if (this.isMetadataField(key)) {
        continue;
      }

      // Recursively handle nested objects
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const nestedChannels = this.discoverFromJson(value as Record<string, unknown>, fullKey);
        channels.push(...nestedChannels);
        continue;
      }

      // Handle arrays (might be array of readings)
      if (Array.isArray(value)) {
        // If it's an array of numbers, treat as a channel with the first value
        if (value.length > 0 && typeof value[0] === 'number') {
          channels.push(this.createDiscoveredChannel(normalizedKey, value[0], fullKey));
        }
        continue;
      }

      // Create channel for primitive values
      if (value !== null && value !== undefined) {
        channels.push(this.createDiscoveredChannel(normalizedKey, value, fullKey));
      }
    }

    return channels;
  }

  /**
   * Discover channels from CSV payload
   */
  discoverFromCsv(payload: string): DiscoveredChannel[] {
    const channels: DiscoveredChannel[] = [];

    if (!payload || typeof payload !== 'string') {
      return channels;
    }

    const lines = payload.trim().split('\n');

    // Check if first line is headers
    const firstLine = lines[0]!.split(',').map(s => s.trim());
    const hasHeaders = firstLine.some(v => isNaN(parseFloat(v)));

    if (hasHeaders && lines.length > 1) {
      // Use headers as channel keys
      const values = lines[1]!.split(',').map(s => s.trim());
      firstLine.forEach((header, index) => {
        if (values[index] !== undefined) {
          const normalizedKey = this.normalizeKey(header);
          const numValue = parseFloat(values[index]);
          const value = isNaN(numValue) ? values[index] : numValue;
          channels.push(this.createDiscoveredChannel(normalizedKey, value));
        }
      });
    } else {
      // No headers, use indexed keys
      const values = firstLine;
      values.forEach((val, index) => {
        const numValue = parseFloat(val);
        const value = isNaN(numValue) ? val : numValue;
        channels.push(this.createDiscoveredChannel(`value_${index}`, value));
      });
    }

    return channels;
  }

  /**
   * Discover channels from text payload (key=value format)
   */
  discoverFromText(payload: string): DiscoveredChannel[] {
    const channels: DiscoveredChannel[] = [];

    if (!payload || typeof payload !== 'string') {
      return channels;
    }

    // Try to parse as key=value pairs
    const pairs = payload.split(/[;&\n]/);
    for (const pair of pairs) {
      const [key, value] = pair.split('=').map(s => s.trim());
      if (key && value !== undefined) {
        const normalizedKey = this.normalizeKey(key);
        const numValue = parseFloat(value);
        const val = isNaN(numValue) ? value : numValue;
        channels.push(this.createDiscoveredChannel(normalizedKey, val));
      }
    }

    // If no key=value pairs found, treat as single value
    if (channels.length === 0) {
      const numValue = parseFloat(payload.trim());
      if (!isNaN(numValue)) {
        channels.push(this.createDiscoveredChannel('value', numValue));
      }
    }

    return channels;
  }

  /**
   * Create a discovered channel with inferred metadata
   */
  private createDiscoveredChannel(
    key: string,
    value: unknown,
    dataPath?: string,
  ): DiscoveredChannel {
    const known = KNOWN_PARAMETERS[key.toLowerCase()];
    const dataType = this.inferDataType(value);

    return {
      channelKey: key,
      suggestedLabel: known?.label || this.suggestDisplayLabel(key),
      inferredDataType: known?.dataType || dataType,
      inferredUnit: known?.unit || this.inferUnitFromKey(key),
      sampleValue: value,
      dataPath: dataPath || key,
      suggestedMin: known?.min,
      suggestedMax: known?.max,
    };
  }

  /**
   * Normalize a key to standard format
   */
  normalizeKey(key: string): string {
    return key
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }

  /**
   * Convert a key to display label
   */
  suggestDisplayLabel(key: string): string {
    // Check known parameters first
    const known = KNOWN_PARAMETERS[key.toLowerCase()];
    if (known) {
      return known.label;
    }

    // Convert snake_case or camelCase to Title Case
    return key
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  /**
   * Infer unit from key name
   */
  inferUnitFromKey(key: string): string | undefined {
    const normalizedKey = key.toLowerCase();

    // Check known parameters
    const known = KNOWN_PARAMETERS[normalizedKey];
    if (known) {
      return known.unit;
    }

    // Common suffixes
    if (normalizedKey.includes('percent') || normalizedKey.endsWith('_pct')) {
      return '%';
    }
    if (normalizedKey.includes('celsius') || normalizedKey.endsWith('_c')) {
      return '°C';
    }
    if (normalizedKey.includes('fahrenheit') || normalizedKey.endsWith('_f')) {
      return '°F';
    }
    if (normalizedKey.includes('voltage') || normalizedKey.endsWith('_v')) {
      return 'V';
    }
    if (normalizedKey.includes('current') || normalizedKey.endsWith('_a')) {
      return 'A';
    }
    if (normalizedKey.includes('millivolt') || normalizedKey.endsWith('_mv')) {
      return 'mV';
    }

    return undefined;
  }

  /**
   * Infer data type from value
   */
  private inferDataType(value: unknown): ChannelDataType {
    if (typeof value === 'boolean') {
      return ChannelDataType.BOOLEAN;
    }
    if (typeof value === 'number') {
      return ChannelDataType.NUMBER;
    }
    if (typeof value === 'string') {
      // Check if it's a number string
      const num = parseFloat(value);
      if (!isNaN(num)) {
        return ChannelDataType.NUMBER;
      }
      // Check if it's a boolean string
      if (['true', 'false', 'yes', 'no', 'on', 'off'].includes(value.toLowerCase())) {
        return ChannelDataType.BOOLEAN;
      }
      return ChannelDataType.STRING;
    }
    return ChannelDataType.STRING;
  }

  /**
   * Check if a field is metadata (should be excluded from channels)
   */
  private isMetadataField(key: string): boolean {
    const metadataFields = [
      'timestamp', 'time', 'datetime', 'date',
      'device_id', 'deviceid', 'sensor_id', 'sensorid',
      'id', 'uuid', 'guid',
      'topic', 'message_id', 'messageid',
      'tenant', 'tenantid', 'tenant_id',
      'created', 'updated', 'modified',
      'version', 'v', 'seq', 'sequence',
    ];

    return metadataFields.includes(key.toLowerCase());
  }

  /**
   * Infer range from key name
   */
  inferRangeFromKey(key: string): { min?: number; max?: number } {
    const normalizedKey = key.toLowerCase();
    const known = KNOWN_PARAMETERS[normalizedKey];

    if (known) {
      return { min: known.min, max: known.max };
    }

    // Common percentage-based values
    if (normalizedKey.includes('percent') || normalizedKey.endsWith('_pct') || normalizedKey === 'humidity') {
      return { min: 0, max: 100 };
    }

    return {};
  }
}
