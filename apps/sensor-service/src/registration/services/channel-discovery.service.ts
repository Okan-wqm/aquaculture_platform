import { Injectable, Logger } from '@nestjs/common';

import { ChannelDataType } from '../../database/entities/sensor-data-channel.entity';
import {
  flattenJsonEntries,
  parseCsvEntries,
  parseTextEntries,
  normalizeChannelKey,
  isMetadataFieldKey,
} from '../../common/payload/sensor-payload-parser';
// SENSOR-MEDIUM-065: the aquaculture parameter dictionary lives in ONE place now.
import { lookupParameter } from '../../common/sensor-parameter-catalog';

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
    payloadFormat: 'json' | 'csv' | 'text' = 'json',
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
        sampleData:
          typeof sampleData === 'object'
            ? (sampleData as Record<string, unknown>)
            : { raw: sampleData },
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
    // Traversal is delegated to the shared sensor-payload engine so discovery and
    // runtime reads walk JSON identically (SENSOR-HIGH-082); discovery layers its
    // channel metadata on top of the extracted leaves.
    return flattenJsonEntries(payload, prefix, isMetadataFieldKey).map((entry) =>
      this.createDiscoveredChannel(normalizeChannelKey(entry.key), entry.value, entry.dataPath),
    );
  }

  /**
   * Discover channels from CSV payload
   */
  discoverFromCsv(payload: string): DiscoveredChannel[] {
    // Row parsing is delegated to the shared engine; discovery coerces numeric
    // cells to numbers (parseFloat) and infers channel metadata.
    return parseCsvEntries(payload).map((entry) => {
      const numValue = parseFloat(String(entry.value));
      const value = isNaN(numValue) ? entry.value : numValue;
      return this.createDiscoveredChannel(normalizeChannelKey(entry.key), value);
    });
  }

  /**
   * Discover channels from text payload (key=value format)
   */
  discoverFromText(payload: string): DiscoveredChannel[] {
    // key=value / single-value parsing is delegated to the shared engine; discovery
    // coerces numeric values (parseFloat) and infers channel metadata.
    return parseTextEntries(payload).map((entry) => {
      const numValue = parseFloat(String(entry.value));
      const value = isNaN(numValue) ? entry.value : numValue;
      return this.createDiscoveredChannel(normalizeChannelKey(entry.key), value);
    });
  }

  /**
   * Create a discovered channel with inferred metadata
   */
  private createDiscoveredChannel(
    key: string,
    value: unknown,
    dataPath?: string,
  ): DiscoveredChannel {
    const known = lookupParameter(key);
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
   * Convert a key to display label
   */
  suggestDisplayLabel(key: string): string {
    // Check known parameters first
    const known = lookupParameter(key);
    if (known) {
      return known.label;
    }

    // Convert snake_case or camelCase to Title Case
    return key
      .replace(/_/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /**
   * Infer unit from key name
   */
  inferUnitFromKey(key: string): string | undefined {
    const normalizedKey = key.toLowerCase();

    // Check known parameters
    const known = lookupParameter(normalizedKey);
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
   * Infer range from key name
   */
  inferRangeFromKey(key: string): { min?: number; max?: number } {
    const normalizedKey = key.toLowerCase();
    const known = lookupParameter(normalizedKey);

    if (known) {
      return { min: known.min, max: known.max };
    }

    // Common percentage-based values
    if (
      normalizedKey.includes('percent') ||
      normalizedKey.endsWith('_pct') ||
      normalizedKey === 'humidity'
    ) {
      return { min: 0, max: 100 };
    }

    return {};
  }
}
