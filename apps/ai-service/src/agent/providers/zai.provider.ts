import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';

import { OpenAiProvider } from './openai.provider';
import type { LlmProviderId } from './llm-provider.interface';

/**
 * Z.ai (Zhipu GLM) provider (BYOK) — the tenant's OWN key, their bill.
 *
 * Z.ai exposes an OpenAI-COMPATIBLE Chat Completions API at
 * https://api.z.ai/api/paas/v4, so this provider extends OpenAiProvider and
 * overrides ONLY the client construction (baseURL + defaultHeaders). The
 * entire normalized-contract translation (tool_use/tool_result flattening,
 * stop-reason mapping, streaming-free chat) is inherited unchanged — the
 * agent loop and every guard see a third first-class provider with zero
 * duplicated translation logic.
 *
 * Default model: the persona defaults are Anthropic-named; agent-profile
 * resolution maps provider `zai` without a tenant chatModel override to
 * ZAI_DEFAULT_MODEL ('glm-5.3').
 */
export const ZAI_DEFAULT_MODEL = 'glm-5.3';

const ZAI_BASE_URL = 'https://api.z.ai/api/paas/v4';

/** GLM generations that understand reasoning_effort (5.x family). */
function supportsReasoningEffort(model: string): boolean {
  return /^(glm-5|glm-6)/i.test(model.trim());
}

@Injectable()
export class ZaiProvider extends OpenAiProvider {
  override readonly id = 'zai' as const;
  protected override readonly logger = new Logger('ZaiProvider');

  protected override newClient(apiKey: string): OpenAI {
    // FARM-AI-0.1: the relay client carries the same 30s / 1-retry transport
    // contract as the base provider — the override only changes the baseURL.
    // (The Sprint 0.1 port had left this client on the SDK's 600s default and
    // its spec probed the parent class, so the gap was invisible.)
    return new OpenAI({ apiKey, baseURL: ZAI_BASE_URL, timeout: 30_000, maxRetries: 1 });
  }

  /**
   * Z.ai GLM-5.x: thinking is always-on; reasoning_effort steers its depth
   * (low | high | max, default max). 'low' keeps chat turns fast and cheap —
   * the right register for an advisory assistant. (User preference 2026-09-18.)
   */
  protected override requestExtras(
    params: import('./llm-provider.interface').LlmChatParams,
  ): Record<string, unknown> {
    // reasoning_effort is a GLM-5.x knob (docs: supported by GLM-5.2+; older
    // generations reject or ignore it). Send it only where it exists so a
    // quarterly model switch in the panel (chatModel field) needs NO code
    // change — e.g. dropping back to glm-4.6 for a cheaper package works
    // as-is.
    return supportsReasoningEffort(params.model) ? { reasoning_effort: 'low' } : {};
  }

  /**
   * Credential probe override: the OpenAI-compatible models.list endpoint is
   * not guaranteed to exist on every relay — a 404 there means "endpoint
   * absent", NOT "bad key". 401 remains a hard reject; everything else is
   * transient (not a key verdict), exactly like the parent.
   */
  override async validateCredential(credential: {
    provider: LlmProviderId;
    apiKey: string;
  }): Promise<boolean> {
    try {
      return await super.validateCredential(credential);
    } catch (err) {
      if (err instanceof OpenAI.NotFoundError) {
        this.logger.warn(
          'Z.ai key probe hit 404 on models.list (relay endpoint absent) — accepting the key as valid',
        );
        return true;
      }
      throw err;
    }
  }
}
