/**
 * Dynamic Sensor Type Entities - Unit Tests
 *
 * Tests entity instantiation and property assignment for:
 * - SensorTypeDefinition
 * - IndustryTemplate
 * - ChannelDetectionLog
 * - Sensor.typeDefinitionId (new field)
 */

import { SensorTypeDefinition } from '../sensor-type-definition.entity';
import { IndustryTemplate } from '../industry-template.entity';
import { ChannelDetectionLog, UserAction } from '../channel-detection-log.entity';
import { Sensor } from '../sensor.entity';

describe('SensorTypeDefinition Entity', () => {
  let entity: SensorTypeDefinition;

  beforeEach(() => {
    entity = new SensorTypeDefinition();
  });

  it('should create an instance', () => {
    expect(entity).toBeDefined();
    expect(entity).toBeInstanceOf(SensorTypeDefinition);
  });

  it('should set required properties', () => {
    entity.id = '11111111-1111-1111-1111-111111111111';
    entity.tenantId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    entity.typeKey = 'dissolved_oxygen';
    entity.displayName = 'Dissolved Oxygen';
    entity.isSystem = false;
    entity.defaultChannels = [];
    entity.metadata = {};

    expect(entity.id).toBe('11111111-1111-1111-1111-111111111111');
    expect(entity.tenantId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(entity.typeKey).toBe('dissolved_oxygen');
    expect(entity.displayName).toBe('Dissolved Oxygen');
    expect(entity.isSystem).toBe(false);
    expect(entity.defaultChannels).toEqual([]);
    expect(entity.metadata).toEqual({});
  });

  it('should set optional properties', () => {
    entity.description = 'Measures dissolved oxygen in water';
    entity.icon = 'water-drop';
    entity.category = 'water_quality';
    entity.industry = 'aquaculture';

    expect(entity.description).toBe('Measures dissolved oxygen in water');
    expect(entity.icon).toBe('water-drop');
    expect(entity.category).toBe('water_quality');
    expect(entity.industry).toBe('aquaculture');
  });

  it('should handle JSONB defaultChannels with data', () => {
    entity.defaultChannels = [
      { key: 'do_percent', unit: '%', displayName: 'DO %' },
      { key: 'do_mgl', unit: 'mg/L', displayName: 'DO mg/L' },
    ];

    expect(entity.defaultChannels).toHaveLength(2);
  });

  it('should handle JSONB metadata with data', () => {
    entity.metadata = {
      manufacturer: 'YSI',
      typicalRange: { min: 0, max: 20 },
    };

    expect(entity.metadata['manufacturer']).toBe('YSI');
  });
});

describe('IndustryTemplate Entity', () => {
  let entity: IndustryTemplate;

  beforeEach(() => {
    entity = new IndustryTemplate();
  });

  it('should create an instance', () => {
    expect(entity).toBeDefined();
    expect(entity).toBeInstanceOf(IndustryTemplate);
  });

  it('should set required properties', () => {
    entity.id = '22222222-2222-2222-2222-222222222222';
    entity.templateKey = 'shrimp_farming';
    entity.displayName = 'Shrimp Farming';
    entity.isActive = true;
    entity.sensorTypes = [];

    expect(entity.id).toBe('22222222-2222-2222-2222-222222222222');
    expect(entity.templateKey).toBe('shrimp_farming');
    expect(entity.displayName).toBe('Shrimp Farming');
    expect(entity.isActive).toBe(true);
    expect(entity.sensorTypes).toEqual([]);
  });

  it('should set optional properties', () => {
    entity.description = 'Template for shrimp farming operations';
    entity.icon = 'shrimp';
    entity.dashboardLayout = { columns: 3, widgets: [] };
    entity.alertPresets = { temperature: { warning: 30, critical: 35 } };

    expect(entity.description).toBe('Template for shrimp farming operations');
    expect(entity.icon).toBe('shrimp');
    expect(entity.dashboardLayout).toBeDefined();
    expect(entity.alertPresets).toBeDefined();
  });

  it('should handle JSONB sensorTypes with data', () => {
    entity.sensorTypes = [
      { typeKey: 'dissolved_oxygen', required: true },
      { typeKey: 'ph', required: true },
      { typeKey: 'salinity', required: false },
    ];

    expect(entity.sensorTypes).toHaveLength(3);
  });
});

describe('ChannelDetectionLog Entity', () => {
  let entity: ChannelDetectionLog;

  beforeEach(() => {
    entity = new ChannelDetectionLog();
  });

  it('should create an instance', () => {
    expect(entity).toBeDefined();
    expect(entity).toBeInstanceOf(ChannelDetectionLog);
  });

  it('should set required properties', () => {
    entity.id = '33333333-3333-3333-3333-333333333333';
    entity.tenantId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    entity.sensorId = '44444444-4444-4444-4444-444444444444';
    entity.rawSample = { temperature: 25.3, ph: 7.2, do: 6.5 };
    entity.aiAnalysis = { confidence: 0.95, detectedType: 'multi_parameter' };
    entity.proposedChannels = {
      channels: [
        { key: 'temperature', unit: 'C' },
        { key: 'ph', unit: 'pH' },
      ],
    };

    expect(entity.id).toBe('33333333-3333-3333-3333-333333333333');
    expect(entity.tenantId).toBe('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
    expect(entity.sensorId).toBe('44444444-4444-4444-4444-444444444444');
    expect(entity.rawSample).toBeDefined();
    expect(entity.aiAnalysis).toBeDefined();
    expect(entity.proposedChannels).toBeDefined();
  });

  it('should set optional properties', () => {
    entity.userAction = UserAction.APPROVED;
    entity.finalChannels = {
      channels: [
        { key: 'temperature', unit: 'C' },
        { key: 'ph', unit: 'pH' },
      ],
    };

    expect(entity.userAction).toBe(UserAction.APPROVED);
    expect(entity.finalChannels).toBeDefined();
  });

  it('should accept sensor relation', () => {
    const sensor = new Sensor();
    sensor.id = '44444444-4444-4444-4444-444444444444';
    entity.sensor = sensor;

    expect(entity.sensor).toBe(sensor);
  });
});

describe('Sensor Entity - typeDefinitionId field', () => {
  let sensor: Sensor;

  it('should have typeDefinitionId as optional', () => {
    sensor = new Sensor();
    expect(sensor.typeDefinitionId).toBeUndefined();
  });

  it('should set typeDefinitionId', () => {
    sensor = new Sensor();
    sensor.typeDefinitionId = '55555555-5555-5555-5555-555555555555';

    expect(sensor.typeDefinitionId).toBe('55555555-5555-5555-5555-555555555555');
  });

  it('should accept typeDefinition relation', () => {
    sensor = new Sensor();
    const typeDef = new SensorTypeDefinition();
    typeDef.id = '55555555-5555-5555-5555-555555555555';
    typeDef.typeKey = 'dissolved_oxygen';
    typeDef.displayName = 'Dissolved Oxygen';

    sensor.typeDefinition = typeDef;
    sensor.typeDefinitionId = typeDef.id;

    expect(sensor.typeDefinition).toBe(typeDef);
    expect(sensor.typeDefinitionId).toBe(typeDef.id);
  });
});
