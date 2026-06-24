import { Injectable } from '@nestjs/common';
import { Tool } from '../core/tool.decorator';
import { BaseTool } from '../core/base-tool';
import { ToolExecutionContext } from '../core/tool.interface';
import { formatLabel } from './utils';

interface DetectedFieldInput {
  key: string;
  dataType: 'number' | 'boolean' | 'string';
  sampleCount: number;
  min?: number;
  max?: number;
  mean?: number;
  suggestedUnit?: string;
  suggestedLabel?: string;
  suggestedWidgetType?: string;
}

interface SuggestChannelsInput {
  sensorId: string;
  detectedFields: DetectedFieldInput[];
  industryContext?: string;
}

interface AlertThresholds {
  warningLow?: number;
  warningHigh?: number;
  criticalLow?: number;
  criticalHigh?: number;
}

interface ChannelProposal {
  channelKey: string;
  displayLabel: string;
  dataType: 'number' | 'boolean' | 'string';
  unit: string;
  operationalMin?: number;
  operationalMax?: number;
  widgetType: string;
  alertThresholds?: AlertThresholds;
  confidence: 'high' | 'medium' | 'low';
}

interface SuggestChannelsOutput {
  sensorId: string;
  tenantId: string;
  proposals: ChannelProposal[];
  industryContext: string;
}

@Injectable()
@Tool({
  name: 'suggest_sensor_channels',
  description:
    'Take sensor data analysis output and create structured channel proposals for sensor configuration. Generates channel keys, display labels, data types, units, operational ranges, widget types, and alert thresholds.',
  category: 'sensor_query',
  runtime: 'cloud',
  requiredPermissions: ['operator', 'manager', 'expert', 'supervisor'],
  inputSchema: {
    type: 'object',
    properties: {
      sensorId: {
        type: 'string',
        description: 'ID of the sensor to configure channels for',
      },
      detectedFields: {
        type: 'array',
        description:
          'Detected field analysis output from analyze_sensor_data tool',
        items: {
          type: 'object',
          properties: {
            key: { type: 'string' },
            dataType: {
              type: 'string',
              enum: ['number', 'boolean', 'string'],
            },
            sampleCount: { type: 'number' },
            min: { type: 'number' },
            max: { type: 'number' },
            mean: { type: 'number' },
            suggestedUnit: { type: 'string' },
            suggestedLabel: { type: 'string' },
            suggestedWidgetType: { type: 'string' },
          },
          required: ['key', 'dataType', 'sampleCount'],
        },
        minItems: 1,
      },
      industryContext: {
        type: 'string',
        description:
          'Optional industry context (e.g., "aquaculture", "agriculture", "industrial")',
      },
    },
    required: ['sensorId', 'detectedFields'],
  },
  requiresModule: null,
  requiresConfirmation: false,
})
export class SuggestChannelsTool extends BaseTool<
  SuggestChannelsInput,
  SuggestChannelsOutput
> {
  protected async run(
    input: SuggestChannelsInput,
    ctx: ToolExecutionContext,
  ): Promise<SuggestChannelsOutput> {
    const { sensorId, detectedFields, industryContext } = input;

    const proposals: ChannelProposal[] = detectedFields.map((field) => {
      const proposal: ChannelProposal = {
        channelKey: this.toChannelKey(field.key),
        displayLabel: field.suggestedLabel || formatLabel(field.key),
        dataType: field.dataType,
        unit: field.suggestedUnit || '',
        widgetType: field.suggestedWidgetType || this.defaultWidget(field.dataType),
        confidence: this.determineConfidence(field.sampleCount),
      };

      if (field.dataType === 'number' && field.min !== undefined && field.max !== undefined) {
        proposal.operationalMin = field.min;
        proposal.operationalMax = field.max;
        proposal.alertThresholds = this.computeAlertThresholds(field.min, field.max);
      }

      return proposal;
    });

    return {
      sensorId,
      tenantId: ctx.tenantId,
      proposals,
      industryContext: industryContext || 'general',
    };
  }

  private toChannelKey(key: string): string {
    // Insert `_` between a lowercase RUN of >= 2 letters and the next
    // uppercase letter. Single-letter lowercase prefixes (e.g. "pH",
    // "uV") are domain-specific acronyms that should NOT split — that
    // matches operator intent on the sensor-channel form, where a
    // typed "pH Level" is one logical channel keyed `ph_level`, not
    // `p_h_level`. The test for `pH Level` pinned this contract.
    return key
      .replace(/([a-z]{2,})([A-Z])/g, '$1_$2')
      .replace(/[\s-]+/g, '_')
      .toLowerCase();
  }

  private defaultWidget(dataType: string): string {
    if (dataType === 'boolean') return 'indicator';
    if (dataType === 'string') return 'text';
    return 'gauge';
  }

  private determineConfidence(sampleCount: number): 'high' | 'medium' | 'low' {
    if (sampleCount >= 10) return 'high';
    if (sampleCount >= 3) return 'medium';
    return 'low';
  }

  /**
   * Compute alert thresholds from operational range.
   * Warning = slightly outside normal range (10% of range beyond min/max).
   * Critical = further outside normal range (20% of range beyond min/max).
   */
  private computeAlertThresholds(min: number, max: number): AlertThresholds {
    const range = max - min;
    if (range === 0) {
      const margin = Math.abs(min) * 0.1 || 1;
      return {
        warningLow: Math.round((min - margin) * 10000) / 10000,
        warningHigh: Math.round((max + margin) * 10000) / 10000,
        criticalLow: Math.round((min - margin * 2) * 10000) / 10000,
        criticalHigh: Math.round((max + margin * 2) * 10000) / 10000,
      };
    }
    const warningMargin = range * 0.1;
    const criticalMargin = range * 0.2;
    return {
      warningLow: Math.round((min - warningMargin) * 10000) / 10000,
      warningHigh: Math.round((max + warningMargin) * 10000) / 10000,
      criticalLow: Math.round((min - criticalMargin) * 10000) / 10000,
      criticalHigh: Math.round((max + criticalMargin) * 10000) / 10000,
    };
  }

  // validate() is a trust boundary: tool input is supplied by the Claude
  // model and may arrive structurally malformed. Accepting `unknown` (a legal
  // widening of ITool.validate's TInput parameter) makes that explicit and
  // forces every field to be narrowed before use — no unchecked field access.
  async validate(
    input: unknown,
  ): Promise<{ valid: boolean; errors?: string[] }> {
    const errors: string[] = [];
    const candidate = (input ?? {}) as Partial<SuggestChannelsInput>;
    if (!candidate.sensorId || typeof candidate.sensorId !== 'string') {
      errors.push('sensorId is required and must be a string');
    }
    if (!candidate.detectedFields || !Array.isArray(candidate.detectedFields)) {
      errors.push('detectedFields must be a non-empty array');
    } else if (candidate.detectedFields.length === 0) {
      errors.push('detectedFields must contain at least one field');
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
