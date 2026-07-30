import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { randomUUID } from 'crypto';

import { ToolExecutorService } from '../tools/core/tool-executor.service';
import { ToolExecutionContext } from '../tools/core/tool.interface';
import {
  AnalyzeSensorDataOutput,
  DetectedField,
  SensorSample,
} from '../tools/sensor-config/analyze-sensor-data.tool';
import {
  ChannelProposal,
  SuggestChannelsOutput,
} from '../tools/sensor-config/suggest-channels.tool';

/**
 * `request.ai.sensor.detectChannels` — the SINGLE entrypoint for a backend
 * service to derive sensor channel proposals from raw samples.
 *
 * SENSOR-MEDIUM-070: sensor-service's channel-detection used to POST to a
 * long-dead HTTP endpoint (`/api/v2/ai/chat`, replaced by NATS request.ai.chat)
 * with a FORGED `x-user-payload` supervisor user — a header-based privilege
 * fabrication that also silently 404'd, degrading the feature to local
 * heuristics. This responder is the honest replacement: it runs the two
 * DETERMINISTIC sensor-config tools (`analyze_sensor_data` → `suggest_sensor_
 * channels`) in sequence under a first-class SERVICE PRINCIPAL — no LLM, no
 * persona, no fabricated user, and no user-RBAC. The tools were always plain TS
 * logic; the old LLM only chained them, so chaining them directly is faithful
 * and cheaper. Identity on the wire is the caller's mTLS NATS cert (ADR-015).
 */
export interface DetectSensorChannelsRequest {
  tenantId: string;
  sensorId: string;
  /** Raw sensor samples ({ timestamp, values }) to analyse. */
  samples: SensorSample[];
  sensorName?: string;
  mqttTopic?: string;
  industryContext?: string;
  correlationId?: string;
}

export interface DetectSensorChannelsResponse {
  proposals: ChannelProposal[];
  detectedFields: DetectedField[];
  confidence: 'high' | 'medium' | 'low';
  /** Present only on failure — the caller falls back to local heuristics. */
  error?: { code: 'BAD_REQUEST' | 'INTERNAL'; message: string };
}

/** Stable service-principal identity for the sensor channel-detection caller. */
const SERVICE_PRINCIPAL = 'sensor-service';

/** The exact read-only tools this principal may run — nothing else. */
const GRANTED_TOOLS = ['analyze_sensor_data', 'suggest_sensor_channels'];

@Controller()
export class SensorChannelDetectionResponder {
  private readonly logger = new Logger(SensorChannelDetectionResponder.name);

  constructor(private readonly toolExecutor: ToolExecutorService) {}

  @MessagePattern('request.ai.sensor.detectChannels')
  async detectChannels(
    @Payload() payload: DetectSensorChannelsRequest,
  ): Promise<DetectSensorChannelsResponse> {
    if (
      !payload.tenantId ||
      !payload.sensorId ||
      !Array.isArray(payload.samples) ||
      payload.samples.length === 0
    ) {
      return {
        proposals: [],
        detectedFields: [],
        confidence: 'low',
        error: {
          code: 'BAD_REQUEST',
          message: 'tenantId, sensorId and at least one sample are required',
        },
      };
    }

    // Derive the tenant schema the same way the chat responder does; the tools
    // scope any tenant query to it.
    const cleanId = payload.tenantId.replace(/-/g, '').substring(0, 16).toLowerCase();
    const ctx: ToolExecutionContext = {
      tenantId: payload.tenantId,
      schemaName: `tenant_${cleanId}`,
      // A service identity, deliberately NOT a user UUID — the executor never
      // consults user RBAC for it; the service grant below is the sole authority.
      userId: `service:${SERVICE_PRINCIPAL}`,
      userRoles: [],
      correlationId: payload.correlationId ?? randomUUID(),
      persona: 'service',
      // Fail-closed: a service principal never actuates. Combined with the
      // read-only grant, an actuation tool is refused twice over.
      actuationPolicy: 'blocked',
      servicePrincipal: { name: SERVICE_PRINCIPAL, grantedToolNames: GRANTED_TOOLS },
    };

    try {
      const analyze = await this.toolExecutor.executeTool(
        'analyze_sensor_data',
        { samples: payload.samples, sensorName: payload.sensorName, mqttTopic: payload.mqttTopic },
        ctx,
      );
      if (!analyze.success || analyze.data === undefined) {
        return {
          proposals: [],
          detectedFields: [],
          confidence: 'low',
          error: { code: 'INTERNAL', message: analyze.error ?? 'analyze_sensor_data failed' },
        };
      }
      const analysis = analyze.data as AnalyzeSensorDataOutput;

      const suggest = await this.toolExecutor.executeTool(
        'suggest_sensor_channels',
        {
          sensorId: payload.sensorId,
          detectedFields: analysis.detectedFields,
          industryContext: payload.industryContext,
        },
        ctx,
      );
      if (!suggest.success || suggest.data === undefined) {
        return {
          proposals: [],
          detectedFields: analysis.detectedFields,
          confidence: analysis.confidence,
          error: { code: 'INTERNAL', message: suggest.error ?? 'suggest_sensor_channels failed' },
        };
      }
      const suggestion = suggest.data as SuggestChannelsOutput;

      return {
        proposals: suggestion.proposals,
        detectedFields: analysis.detectedFields,
        confidence: analysis.confidence,
      };
    } catch (error) {
      this.logger.error(
        `detectChannels failed for tenant ${payload.tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        proposals: [],
        detectedFields: [],
        confidence: 'low',
        error: { code: 'INTERNAL', message: 'channel detection failed' },
      };
    }
  }
}
