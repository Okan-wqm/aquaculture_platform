import { Controller, Logger } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { AgentConfigService } from './agent-config.service';

interface IsEnabledRequest {
  tenantId: string;
}

interface IsEnabledResponse {
  enabled: boolean;
  reason: 'ok' | 'disabled' | 'key_missing';
}

/**
 * NATS request-reply: `request.ai.isEnabled` — the SINGLE source of truth for
 * "is AI usable for this tenant" (config.isEnabled AND a valid provider key).
 *
 * Before this, messaging kept its own `tenant_ai_settings.aiEnabled` flag, a
 * second master switch that could disagree with ai-service (e.g. enabled in
 * messaging but no key in ai-service → the message routed to AI only to bounce
 * with AI_KEY_MISSING). Messaging now asks ai-service, so enablement lives in
 * exactly one place — the tenant's AI provider config.
 */
@Controller()
export class AiEnablementResponder {
  private readonly logger = new Logger(AiEnablementResponder.name);

  constructor(private readonly agentConfig: AgentConfigService) {}

  @MessagePattern('request.ai.isEnabled')
  async isEnabled(@Payload() payload: IsEnabledRequest): Promise<IsEnabledResponse> {
    if (!payload?.tenantId) {
      return { enabled: false, reason: 'disabled' };
    }
    try {
      const enablement = await this.agentConfig.resolveEnablement(payload.tenantId);
      return { enabled: enablement.enabled, reason: enablement.reason };
    } catch (error) {
      // Fail closed — a lookup fault must not present AI as available.
      this.logger.warn(
        `request.ai.isEnabled failed for ${payload.tenantId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return { enabled: false, reason: 'disabled' };
    }
  }
}
