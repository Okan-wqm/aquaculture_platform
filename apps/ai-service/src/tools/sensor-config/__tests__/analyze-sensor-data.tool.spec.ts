import 'reflect-metadata';
import { AnalyzeSensorDataTool } from '../analyze-sensor-data.tool';
import { ToolExecutionContext } from '../../core/tool.interface';

describe('AnalyzeSensorDataTool', () => {
  let tool: AnalyzeSensorDataTool;
  const ctx: ToolExecutionContext = {
    tenantId: 'tenant_test',
    schemaName: 'tenant_test',
    userId: 'user_1',
    userRoles: ['operator'],
    correlationId: 'corr-123',
    persona: 'aqua-expert',
  };

  beforeEach(() => {
    tool = new AnalyzeSensorDataTool();
  });

  describe('metadata', () => {
    it('should have correct tool metadata', () => {
      const meta = tool.getMetadata();
      expect(meta.name).toBe('analyze_sensor_data');
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
    it('should reject empty samples array', async () => {
      const result = await tool.validate({ samples: [] });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain(
        'samples must contain at least one sample',
      );
    });

    it('should reject samples without timestamp', async () => {
      const result = await tool.validate({
        samples: [{ timestamp: '', values: { temp: 25 } }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('samples[0].timestamp is required');
    });

    it('should accept valid input', async () => {
      const result = await tool.validate({
        samples: [
          { timestamp: '2026-01-01T00:00:00Z', values: { temp: 25 } },
        ],
      });
      expect(result.valid).toBe(true);
    });
  });

  describe('execute', () => {
    it('should detect numeric fields with range and mean', async () => {
      const samples = Array.from({ length: 10 }, (_, i) => ({
        timestamp: `2026-01-01T00:${String(i).padStart(2, '0')}:00Z`,
        values: { temperature: 20 + i, humidity: 60 + i * 0.5 },
      }));

      const result = await tool.execute({ samples }, ctx);

      expect(result.success).toBe(true);
      expect(result.data!.sampleCount).toBe(10);
      expect(result.data!.confidence).toBe('high');
      expect(result.data!.detectedFields).toHaveLength(2);

      const tempField = result.data!.detectedFields.find(
        (f) => f.key === 'temperature',
      );
      expect(tempField).toBeDefined();
      expect(tempField!.dataType).toBe('number');
      expect(tempField!.min).toBe(20);
      expect(tempField!.max).toBe(29);
      expect(tempField!.suggestedUnit).toBe('\u00b0C');
      expect(tempField!.suggestedLabel).toBe('Temperature');
      expect(tempField!.suggestedWidgetType).toBe('gauge');

      const humField = result.data!.detectedFields.find(
        (f) => f.key === 'humidity',
      );
      expect(humField).toBeDefined();
      expect(humField!.suggestedUnit).toBe('%RH');
    });

    it('should detect boolean fields', async () => {
      const samples = [
        {
          timestamp: '2026-01-01T00:00:00Z',
          values: { pump_active: true },
        },
        {
          timestamp: '2026-01-01T00:01:00Z',
          values: { pump_active: false },
        },
        {
          timestamp: '2026-01-01T00:02:00Z',
          values: { pump_active: true },
        },
      ];

      const result = await tool.execute({ samples }, ctx);
      expect(result.success).toBe(true);

      const pumpField = result.data!.detectedFields.find(
        (f) => f.key === 'pump_active',
      );
      expect(pumpField).toBeDefined();
      expect(pumpField!.dataType).toBe('boolean');
      expect(pumpField!.suggestedWidgetType).toBe('indicator');
      expect(pumpField!.min).toBeUndefined();
      expect(pumpField!.max).toBeUndefined();
    });

    it('should return medium confidence for 3-9 samples', async () => {
      const samples = Array.from({ length: 5 }, (_, i) => ({
        timestamp: `2026-01-01T00:0${i}:00Z`,
        values: { ph: 7.0 + i * 0.1 },
      }));

      const result = await tool.execute({ samples }, ctx);
      expect(result.data!.confidence).toBe('medium');
    });

    it('should return low confidence for fewer than 3 samples', async () => {
      const samples = [
        { timestamp: '2026-01-01T00:00:00Z', values: { do: 6.5 } },
      ];

      const result = await tool.execute({ samples }, ctx);
      expect(result.data!.confidence).toBe('low');
    });

    it('should guess units from field names', async () => {
      const samples = [
        {
          timestamp: '2026-01-01T00:00:00Z',
          values: {
            ph: 7.2,
            dissolved_oxygen: 6.5,
            salinity: 35,
            voltage: 12.1,
            wind_speed: 3.5,
            wind_direction: 180,
            lux: 500,
            pressure: 1013,
            current_amps: 2.5,
            power_watts: 30,
            vibration: 0.5,
          },
        },
      ];

      const result = await tool.execute({ samples }, ctx);
      expect(result.success).toBe(true);

      const fieldMap = new Map(
        result.data!.detectedFields.map((f) => [f.key, f]),
      );

      expect(fieldMap.get('ph')!.suggestedUnit).toBe('pH');
      expect(fieldMap.get('dissolved_oxygen')!.suggestedUnit).toBe('mg/L');
      expect(fieldMap.get('salinity')!.suggestedUnit).toBe('ppt');
      expect(fieldMap.get('voltage')!.suggestedUnit).toBe('V');
      expect(fieldMap.get('wind_speed')!.suggestedUnit).toBe('m/s');
      expect(fieldMap.get('wind_direction')!.suggestedUnit).toBe('\u00b0');
      expect(fieldMap.get('lux')!.suggestedUnit).toBe('lux');
      expect(fieldMap.get('pressure')!.suggestedUnit).toBe('hPa');
      expect(fieldMap.get('current_amps')!.suggestedUnit).toBe('A');
      expect(fieldMap.get('power_watts')!.suggestedUnit).toBe('W');
      expect(fieldMap.get('vibration')!.suggestedUnit).toBe('mm/s');
    });

    it('should include context in output', async () => {
      const samples = [
        { timestamp: '2026-01-01T00:00:00Z', values: { temp: 25 } },
      ];

      const result = await tool.execute(
        {
          samples,
          sensorName: 'Pond-Sensor-1',
          mqttTopic: 'farm/pond1/sensors',
        },
        ctx,
      );

      expect(result.data!.context.sensorName).toBe('Pond-Sensor-1');
      expect(result.data!.context.mqttTopic).toBe('farm/pond1/sensors');
      expect(result.data!.context.analysisTimestamp).toBeDefined();
    });

    it('should handle string fields', async () => {
      const samples = [
        {
          timestamp: '2026-01-01T00:00:00Z',
          values: { status: 'online', temp: 25 },
        },
        {
          timestamp: '2026-01-01T00:01:00Z',
          values: { status: 'standby', temp: 26 },
        },
      ];

      const result = await tool.execute({ samples }, ctx);
      const statusField = result.data!.detectedFields.find(
        (f) => f.key === 'status',
      );
      expect(statusField!.dataType).toBe('string');
      expect(statusField!.suggestedWidgetType).toBe('text');
    });
  });
});
