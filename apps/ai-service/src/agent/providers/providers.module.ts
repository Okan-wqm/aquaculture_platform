import { Module } from '@nestjs/common';
import { AnthropicProvider } from './anthropic.provider';
import { LlmProviderFactory } from './llm-provider.factory';

/**
 * SSoT for LLM provider wiring. Both the agent runner (chat) and the
 * tenant-config CRUD (key-validation ping) depend on the factory, so it lives
 * in its own module to avoid an AgentModule ↔ AgentConfigModule import cycle.
 * Adding OpenAiProvider (Faz 1b) touches only this module + the factory map.
 */
@Module({
  providers: [AnthropicProvider, LlmProviderFactory],
  exports: [LlmProviderFactory],
})
export class LlmProvidersModule {}
