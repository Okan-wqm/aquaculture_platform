import 'reflect-metadata';

import {
  DetectSensorChannelsRequest,
  SensorChannelDetectionResponder,
} from '../sensor-channel-detection.responder';
import { ToolExecutionContext, ToolResult } from '../../tools/core/tool.interface';

/**
 * SENSOR-MEDIUM-070: the deterministic channel-detection responder chains the
 * two read-only sensor-config tools under a first-class service principal —
 * no LLM, no fabricated user, no user RBAC.
 */
describe('SensorChannelDetectionResponder (SENSOR-MEDIUM-070)', () => {
  const executeTool = jest.fn<Promise<ToolResult>, [string, unknown, ToolExecutionContext]>();
  const responder = new SensorChannelDetectionResponder({ executeTool } as never);

  const req: DetectSensorChannelsRequest = {
    tenantId: 'tenant-abc',
    sensorId: 's1',
    samples: [{ timestamp: '2026-01-01T00:00:00Z', values: { temp: 21.5 } }],
  };

  const analyzeResult: ToolResult = {
    success: true,
    data: {
      detectedFields: [
        {
          key: 'temp',
          dataType: 'number',
          sampleCount: 1,
          suggestedUnit: '°C',
          suggestedLabel: 'Temp',
          suggestedWidgetType: 'gauge',
        },
      ],
      sampleCount: 1,
      confidence: 'low',
      context: { analysisTimestamp: '2026-01-01T00:00:00Z' },
    },
    durationMs: 1,
    cacheable: false,
  };

  const suggestResult: ToolResult = {
    success: true,
    data: {
      sensorId: 's1',
      tenantId: 'tenant-abc',
      proposals: [
        {
          channelKey: 'temp',
          displayLabel: 'Temp',
          dataType: 'number',
          unit: '°C',
          widgetType: 'gauge',
          confidence: 'low',
        },
      ],
      industryContext: 'general',
    },
    durationMs: 1,
    cacheable: false,
  };

  beforeEach(() => jest.clearAllMocks());

  it('chains analyze → suggest under a read-only service principal and returns proposals', async () => {
    executeTool.mockResolvedValueOnce(analyzeResult).mockResolvedValueOnce(suggestResult);

    const res = await responder.detectChannels(req);

    expect(res.error).toBeUndefined();
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0]!.channelKey).toBe('temp');
    expect(res.detectedFields).toHaveLength(1);
    expect(res.confidence).toBe('low');

    // 1st call analyses the raw samples; 2nd feeds its detectedFields to suggest.
    expect(executeTool).toHaveBeenNthCalledWith(
      1,
      'analyze_sensor_data',
      expect.objectContaining({ samples: req.samples }),
      expect.anything(),
    );
    expect(executeTool).toHaveBeenNthCalledWith(
      2,
      'suggest_sensor_channels',
      expect.objectContaining({ sensorId: 's1' }),
      expect.anything(),
    );
    // suggest is fed analyze's detectedFields (the deterministic chain).
    const suggestInput = executeTool.mock.calls[1]![1] as { detectedFields: unknown[] };
    expect(suggestInput.detectedFields).toHaveLength(1);

    // The context is a read-only service principal, NOT a fabricated user.
    const ctx = executeTool.mock.calls[0]![2];
    expect(ctx.servicePrincipal).toEqual({
      name: 'sensor-service',
      grantedToolNames: ['analyze_sensor_data', 'suggest_sensor_channels'],
    });
    expect(ctx.userRoles).toEqual([]);
    expect(ctx.actuationPolicy).toBe('blocked');
    expect(ctx.schemaName).toBe('tenant_tenantabc');
  });

  it('returns BAD_REQUEST without calling any tool when samples are empty', async () => {
    const res = await responder.detectChannels({ ...req, samples: [] });

    expect(res.error?.code).toBe('BAD_REQUEST');
    expect(res.proposals).toEqual([]);
    expect(executeTool).not.toHaveBeenCalled();
  });

  it('surfaces INTERNAL and does not proceed to suggest when analyze fails', async () => {
    executeTool.mockResolvedValueOnce({
      success: false,
      error: 'analyze boom',
      durationMs: 1,
      cacheable: false,
    });

    const res = await responder.detectChannels(req);

    expect(res.error?.code).toBe('INTERNAL');
    expect(res.proposals).toEqual([]);
    expect(executeTool).toHaveBeenCalledTimes(1);
  });
});
