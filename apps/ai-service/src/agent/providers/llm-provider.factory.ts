import { Injectable } from '@nestjs/common';
import { AnthropicProvider } from './anthropic.provider';
import { LlmProvider, LlmProviderId } from './llm-provider.interface';

/**
 * Resolves the concrete provider for a tenant's chosen provider id.
 *
 * WHY a factory (not a switch in the runner): keeps the loop provider-agnostic
 * and makes the provider set the single extension point. Adding OpenAI (Faz 1b)
 * = inject OpenAiProvider and add it to the registry map here; the agent loop is
 * untouched. Unknown ids fail fast rather than silently defaulting to a provider
 * the tenant did not choose (which would spend the wrong key).
 */
@Injectable()
export class LlmProviderFactory {
  private readonly registry: ReadonlyMap<LlmProviderId, LlmProvider>;

  constructor(private readonly anthropic: AnthropicProvider) {
    // OpenAiProvider joins this map in Faz 1b once the `openai` dependency is
    // added against the real package.json (not the symlinked worktree).
    this.registry = new Map<LlmProviderId, LlmProvider>([
      [anthropic.id, anthropic],
    ]);
  }

  /** Whether a provider is wired in this build. */
  supports(providerId: LlmProviderId): boolean {
    return this.registry.has(providerId);
  }

  /** Provider ids available in this build (for UI/validation error messages). */
  availableProviders(): LlmProviderId[] {
    return [...this.registry.keys()];
  }

  get(providerId: LlmProviderId): LlmProvider {
    const provider = this.registry.get(providerId);
    if (!provider) {
      throw new Error(
        `AI provider "${providerId}" is not available in this build. ` +
          `Available: ${this.availableProviders().join(', ') || '(none)'}`,
      );
    }
    return provider;
  }
}
