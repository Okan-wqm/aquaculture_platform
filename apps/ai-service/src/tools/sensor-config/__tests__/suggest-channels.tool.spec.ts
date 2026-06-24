import 'reflect-metadata';
import { SuggestChannelsTool } from '../suggest-channels.tool';
import { ToolExecutionContext } from '../../core/tool.interface';

describe('SuggestChannelsTool', () => {
  let tool: SuggestChannelsTool;
  const ctx: ToolExecutionContext = {
    tenantId: 'tenant_test',
    schemaName: 'tenant_test',
    userId: 'user_1',
    userRoles: ['operator'],
    correlationId: 'corr-123',
    persona: 'aqua-expert',
  };

  beforeEach(() => {
    tool = new SuggestChannelsTool();
  });

  describe('metadata', () => {
    it('should have correct tool metadata', () => {
      const meta = tool.getMetadata();
      expect(meta.name).toBe('suggest_sensor_channels');
      expect(meta.category).toBe('sensor_query');
      expect(meta.runtime).toBe('cloud');
      expect(meta.requiresConfirmation).toBe(false);
      expect(meta.requiredPermissions).toEqual([
        'operator',
        'manager',
        'expert',
        'supervisor',
      ]);
    });
  });

  describe('validation', () => {
    it('should reject missing sensorId', async () => {
      const result = await tool.validate({
        sensorId: '',
        detectedFields: [{ key: 'temp', dataType: 'number', sampleCount: 5 }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('sensorId is required and must be a string');
    });

    it('should reject empty detectedFields', async () => {
      const result = await tool.validate({
        sensorId: 'sensor-1',
        detectedFields: [],
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('detectedFields must contain at least one field');
    });

    it('should reject missing detectedFields', async () => {
      // validate() is a trust-boundary check: tool input originates from the
      // Claude model and may arrive structurally malformed at runtime. Here
      // detectedFields is null, exercising the non-array guard. validate()
      // accepts `unknown` precisely so this needs no cast.
      const result = await tool.validate({
        sensorId: 'sensor-1',
        detectedFields: null,
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('detectedFields must be a non-empty array');
    });

    it('should accept valid input', async () => {
      const result = await tool.validate({
        sensorId: 'sensor-1',
        detectedFields: [
          { key: 'temperature', dataType: 'number', sampleCount: 10 },
        ],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('execute', () => {
    it('should generate channel proposals from analysis output', async () => {
      const result = await tool.execute(
        {
          sensorId: 'sensor-1',
          detectedFields: [
            {
              key: 'temperature',
              dataType: 'number',
              sampleCount: 10,
              min: 20,
              max: 30,
              mean: 25,
              suggestedUnit: '\u00b0C',
              suggestedLabel: 'Temperature',
              suggestedWidgetType: 'gauge',
            },
            {
              key: 'pump_active',
              dataType: 'boolean',
              sampleCount: 10,
              suggestedUnit: '',
              suggestedLabel: 'Pump Active',
              suggestedWidgetType: 'indicator',
            },
          ],
        },
        ctx,
      );

      expect(result.success).toBe(true);
      expect(result.data!.proposals).toHaveLength(2);
      expect(result.data!.sensorId).toBe('sensor-1');
      expect(result.data!.tenantId).toBe('tenant_test');

      const tempProposal = result.data!.proposals.find(
        (p) => p.channelKey === 'temperature',
      );
      expect(tempProposal).toBeDefined();
      expect(tempProposal!.displayLabel).toBe('Temperature');
      expect(tempProposal!.unit).toBe('\u00b0C');
      expect(tempProposal!.dataType).toBe('number');
      expect(tempProposal!.operationalMin).toBe(20);
      expect(tempProposal!.operationalMax).toBe(30);
      expect(tempProposal!.alertThresholds).toBeDefined();

      const pumpProposal = result.data!.proposals.find(
        (p) => p.channelKey === 'pump_active',
      );
      expect(pumpProposal).toBeDefined();
      expect(pumpProposal!.dataType).toBe('boolean');
      expect(pumpProposal!.widgetType).toBe('indicator');
      expect(pumpProposal!.alertThresholds).toBeUndefined();
    });

    it('should compute alert thresholds outside the normal range', async () => {
      const result = await tool.execute(
        {
          sensorId: 'sensor-1',
          detectedFields: [
            {
              key: 'ph',
              dataType: 'number',
              sampleCount: 10,
              min: 6,
              max: 8,
              mean: 7,
              suggestedUnit: 'pH',
              suggestedLabel: 'pH',
              suggestedWidgetType: 'gauge',
            },
          ],
        },
        ctx,
      );

      expect(result.success).toBe(true);
      const proposal = result.data!.proposals[0]!;
      const thresholds = proposal.alertThresholds!;

      // Warning thresholds should be OUTSIDE the normal range
      expect(thresholds.warningLow).toBeLessThan(6);
      expect(thresholds.warningHigh).toBeGreaterThan(8);
      // Critical thresholds should be further outside than warning
      expect(thresholds.criticalLow!).toBeLessThan(thresholds.warningLow!);
      expect(thresholds.criticalHigh!).toBeGreaterThan(thresholds.warningHigh!);

      // Verify exact values: range=2, warningMargin=0.2, criticalMargin=0.4
      expect(thresholds.warningLow).toBe(5.8);
      expect(thresholds.warningHigh).toBe(8.2);
      expect(thresholds.criticalLow).toBe(5.6);
      expect(thresholds.criticalHigh).toBe(8.4);
    });

    it('should handle min===max edge case for alert thresholds', async () => {
      const result = await tool.execute(
        {
          sensorId: 'sensor-1',
          detectedFields: [
            {
              key: 'constant_value',
              dataType: 'number',
              sampleCount: 5,
              min: 10,
              max: 10,
              mean: 10,
              suggestedUnit: '',
              suggestedLabel: 'Constant Value',
              suggestedWidgetType: 'gauge',
            },
          ],
        },
        ctx,
      );

      expect(result.success).toBe(true);
      const thresholds = result.data!.proposals[0]!.alertThresholds!;

      // Should use margin based on abs(min) * 0.1 = 1
      expect(thresholds.warningLow).toBe(9);
      expect(thresholds.warningHigh).toBe(11);
      expect(thresholds.criticalLow).toBe(8);
      expect(thresholds.criticalHigh).toBe(12);
    });

    it('should handle min===max===0 edge case', async () => {
      const result = await tool.execute(
        {
          sensorId: 'sensor-1',
          detectedFields: [
            {
              key: 'zero_val',
              dataType: 'number',
              sampleCount: 5,
              min: 0,
              max: 0,
              mean: 0,
              suggestedUnit: '',
              suggestedLabel: 'Zero',
              suggestedWidgetType: 'gauge',
            },
          ],
        },
        ctx,
      );

      expect(result.success).toBe(true);
      const thresholds = result.data!.proposals[0]!.alertThresholds!;

      // abs(0)*0.1 = 0, so margin falls back to 1
      expect(thresholds.warningLow).toBe(-1);
      expect(thresholds.warningHigh).toBe(1);
      expect(thresholds.criticalLow).toBe(-2);
      expect(thresholds.criticalHigh).toBe(2);
    });

    it('should return high confidence for sampleCount >= 10', async () => {
      const result = await tool.execute(
        {
          sensorId: 'sensor-1',
          detectedFields: [
            { key: 'temp', dataType: 'number', sampleCount: 10, suggestedUnit: '', suggestedLabel: '', suggestedWidgetType: '' },
          ],
        },
        ctx,
      );
      expect(result.data!.proposals[0]!.confidence).toBe('high');
    });

    it('should return medium confidence for sampleCount 3-9', async () => {
      const result = await tool.execute(
        {
          sensorId: 'sensor-1',
          detectedFields: [
            { key: 'temp', dataType: 'number', sampleCount: 3, suggestedUnit: '', suggestedLabel: '', suggestedWidgetType: '' },
          ],
        },
        ctx,
      );
      expect(result.data!.proposals[0]!.confidence).toBe('medium');
    });

    it('should return low confidence for sampleCount < 3', async () => {
      const result = await tool.execute(
        {
          sensorId: 'sensor-1',
          detectedFields: [
            { key: 'temp', dataType: 'number', sampleCount: 1, suggestedUnit: '', suggestedLabel: '', suggestedWidgetType: '' },
          ],
        },
        ctx,
      );
      expect(result.data!.proposals[0]!.confidence).toBe('low');
    });

    it('should normalize camelCase keys to snake_case channel keys', async () => {
      const result = await tool.execute(
        {
          sensorId: 'sensor-1',
          detectedFields: [
            { key: 'waterTemperature', dataType: 'number', sampleCount: 5, suggestedUnit: '', suggestedLabel: '', suggestedWidgetType: '' },
            { key: 'dissolved-oxygen', dataType: 'number', sampleCount: 5, suggestedUnit: '', suggestedLabel: '', suggestedWidgetType: '' },
            { key: 'pH Level', dataType: 'number', sampleCount: 5, suggestedUnit: '', suggestedLabel: '', suggestedWidgetType: '' },
          ],
        },
        ctx,
      );

      expect(result.success).toBe(true);
      const keys = result.data!.proposals.map((p) => p.channelKey);
      expect(keys).toContain('water_temperature');
      expect(keys).toContain('dissolved_oxygen');
      expect(keys).toContain('ph_level');
    });

    it('should use formatLabel for display when suggestedLabel is empty', async () => {
      const result = await tool.execute(
        {
          sensorId: 'sensor-1',
          detectedFields: [
            { key: 'water_temp', dataType: 'number', sampleCount: 5, suggestedUnit: '', suggestedLabel: '', suggestedWidgetType: '' },
          ],
        },
        ctx,
      );

      expect(result.data!.proposals[0]!.displayLabel).toBe('Water Temp');
    });

    it('should default industryContext to general when not provided', async () => {
      const result = await tool.execute(
        {
          sensorId: 'sensor-1',
          detectedFields: [
            { key: 'temp', dataType: 'number', sampleCount: 5, suggestedUnit: '', suggestedLabel: '', suggestedWidgetType: '' },
          ],
        },
        ctx,
      );

      expect(result.data!.industryContext).toBe('general');
    });

    it('should pass through provided industryContext', async () => {
      const result = await tool.execute(
        {
          sensorId: 'sensor-1',
          detectedFields: [
            { key: 'temp', dataType: 'number', sampleCount: 5, suggestedUnit: '', suggestedLabel: '', suggestedWidgetType: '' },
          ],
          industryContext: 'aquaculture',
        },
        ctx,
      );

      expect(result.data!.industryContext).toBe('aquaculture');
    });

    it('should not set alertThresholds for non-numeric fields', async () => {
      const result = await tool.execute(
        {
          sensorId: 'sensor-1',
          detectedFields: [
            { key: 'status', dataType: 'string', sampleCount: 5, suggestedUnit: '', suggestedLabel: 'Status', suggestedWidgetType: 'text' },
          ],
        },
        ctx,
      );

      expect(result.data!.proposals[0]!.alertThresholds).toBeUndefined();
    });

    it('should not set alertThresholds when min/max are undefined', async () => {
      const result = await tool.execute(
        {
          sensorId: 'sensor-1',
          detectedFields: [
            { key: 'temp', dataType: 'number', sampleCount: 5, suggestedUnit: '', suggestedLabel: '', suggestedWidgetType: '' },
          ],
        },
        ctx,
      );

      expect(result.data!.proposals[0]!.alertThresholds).toBeUndefined();
    });
  });
});
