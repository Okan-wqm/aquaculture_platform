import { Injectable } from '@nestjs/common';
import { Tool } from '../core/tool.decorator';
import { BaseTool } from '../core/base-tool';
import { ToolExecutionContext } from '../core/tool.interface';
import { formatLabel } from './utils';

interface SensorSample {
  timestamp: string;
  values: Record<string, unknown>;
}

interface AnalyzeSensorDataInput {
  samples: SensorSample[];
  sensorName?: string;
  mqttTopic?: string;
}

interface DetectedField {
  key: string;
  dataType: 'number' | 'boolean' | 'string';
  sampleCount: number;
  min?: number;
  max?: number;
  mean?: number;
  suggestedUnit: string;
  suggestedLabel: string;
  suggestedWidgetType: string;
}

interface AnalyzeSensorDataOutput {
  detectedFields: DetectedField[];
  sampleCount: number;
  confidence: 'high' | 'medium' | 'low';
  context: {
    sensorName?: string;
    mqttTopic?: string;
    analysisTimestamp: string;
  };
}

/** Heuristic map: if a field name matches the pattern, suggest the given unit */
const UNIT_HEURISTICS: Array<{ patterns: string[]; unit: string }> = [
  { patterns: ['temp'], unit: '\u00b0C' },
  { patterns: ['hum', 'moisture'], unit: '%RH' },
  { patterns: ['ph'], unit: 'pH' },
  { patterns: ['pressure'], unit: 'hPa' },
  { patterns: ['wind_speed', 'windspeed'], unit: 'm/s' },
  { patterns: ['wind_dir', 'winddir'], unit: '\u00b0' },
  { patterns: ['light', 'lux'], unit: 'lux' },
  { patterns: ['voltage', 'volt'], unit: 'V' },
  { patterns: ['current', 'amp'], unit: 'A' },
  { patterns: ['power', 'watt'], unit: 'W' },
  { patterns: ['vibr'], unit: 'mm/s' },
  { patterns: ['dissolved_o', 'diss_oxy', 'do_level', 'do_mg', 'oxygen'], unit: 'mg/L' },
  { patterns: ['salinity', 'tds'], unit: 'ppt' },
];

function guessUnit(fieldName: string): string {
  const lower = fieldName.toLowerCase();
  // Special compound checks: wind+speed, wind+dir
  if (lower.includes('wind') && lower.includes('speed')) return 'm/s';
  if (lower.includes('wind') && lower.includes('dir')) return '\u00b0';

  for (const { patterns, unit } of UNIT_HEURISTICS) {
    for (const pattern of patterns) {
      if (lower.includes(pattern)) return unit;
    }
  }
  return '';
}

function suggestWidgetType(dataType: string, unit: string): string {
  if (dataType === 'boolean') return 'indicator';
  if (dataType === 'string') return 'text';
  if (unit === '\u00b0') return 'compass';
  return 'gauge';
}

@Injectable()
@Tool({
  name: 'analyze_sensor_data',
  description:
    'Analyze raw sensor data samples to detect field types, value ranges, and suggest what each field represents. Useful when onboarding a new sensor to automatically determine channel configuration.',
  category: 'sensor_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  inputSchema: {
    type: 'object',
    properties: {
      samples: {
        type: 'array',
        description: 'Array of sensor data samples with timestamp and values',
        items: {
          type: 'object',
          properties: {
            timestamp: { type: 'string', description: 'ISO 8601 timestamp' },
            values: {
              type: 'object',
              description: 'Key-value pairs of sensor readings',
              additionalProperties: true,
            },
          },
          required: ['timestamp', 'values'],
        },
        minItems: 1,
        maxItems: 1000,
      },
      sensorName: {
        type: 'string',
        description: 'Optional sensor name for context',
      },
      mqttTopic: {
        type: 'string',
        description: 'Optional MQTT topic for context',
      },
    },
    required: ['samples'],
  },
  requiresModule: null,
  requiresConfirmation: false,
})
export class AnalyzeSensorDataTool extends BaseTool<
  AnalyzeSensorDataInput,
  AnalyzeSensorDataOutput
> {
  protected async run(
    input: AnalyzeSensorDataInput,
    _ctx: ToolExecutionContext,
  ): Promise<AnalyzeSensorDataOutput> {
    const { samples, sensorName, mqttTopic } = input;

    // Collect per-field statistics
    const fieldStats = new Map<
      string,
      { values: unknown[]; types: Set<string> }
    >();

    for (const sample of samples) {
      for (const [key, value] of Object.entries(sample.values)) {
        let stats = fieldStats.get(key);
        if (!stats) {
          stats = { values: [], types: new Set() };
          fieldStats.set(key, stats);
        }
        stats.values.push(value);
        stats.types.add(typeof value);
      }
    }

    // Analyze each field
    const detectedFields: DetectedField[] = [];

    for (const [key, stats] of fieldStats) {
      const dataType = this.inferDataType(stats.types);
      const field: DetectedField = {
        key,
        dataType,
        sampleCount: stats.values.length,
        suggestedUnit: guessUnit(key),
        suggestedLabel: formatLabel(key),
        suggestedWidgetType: suggestWidgetType(dataType, guessUnit(key)),
      };

      if (dataType === 'number') {
        const numericValues = stats.values
          .filter((v): v is number => typeof v === 'number' && !isNaN(v));
        if (numericValues.length > 0) {
          const minVal = numericValues.reduce((a, b) => Math.min(a, b), Infinity);
          const maxVal = numericValues.reduce((a, b) => Math.max(a, b), -Infinity);
          field.min = Math.round(minVal * 10000) / 10000;
          field.max = Math.round(maxVal * 10000) / 10000;
          const sum = numericValues.reduce((a, b) => a + b, 0);
          field.mean = Math.round((sum / numericValues.length) * 10000) / 10000;
        }
      }

      detectedFields.push(field);
    }

    // Determine confidence based on sample count
    const confidence: 'high' | 'medium' | 'low' =
      samples.length >= 10 ? 'high' : samples.length >= 3 ? 'medium' : 'low';

    return {
      detectedFields,
      sampleCount: samples.length,
      confidence,
      context: {
        sensorName,
        mqttTopic,
        analysisTimestamp: new Date().toISOString(),
      },
    };
  }

  private inferDataType(types: Set<string>): 'number' | 'boolean' | 'string' {
    if (types.size === 1) {
      const type = types.values().next().value;
      if (type === 'number') return 'number';
      if (type === 'boolean') return 'boolean';
      return 'string';
    }
    // Mixed types: if number is present, treat as number; otherwise string
    if (types.has('number')) return 'number';
    if (types.has('boolean')) return 'boolean';
    return 'string';
  }

  async validate(
    input: AnalyzeSensorDataInput,
  ): Promise<{ valid: boolean; errors?: string[] }> {
    const errors: string[] = [];
    if (!input.samples || !Array.isArray(input.samples)) {
      errors.push('samples must be a non-empty array');
    } else if (input.samples.length === 0) {
      errors.push('samples must contain at least one sample');
    } else {
      for (const [i, s] of input.samples.entries()) {
        if (!s.timestamp) errors.push(`samples[${i}].timestamp is required`);
        if (!s.values || typeof s.values !== 'object')
          errors.push(`samples[${i}].values must be an object`);
      }
    }
    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  protected isCacheable(): boolean {
    return false;
  }

  protected getCacheTtl(): number {
    return 60;
  }
}
