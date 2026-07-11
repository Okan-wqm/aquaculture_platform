import { Module } from '@nestjs/common';
import { AnthropicProvider } from './anthropic.provider';
import { LlmProviderFactory } from './llm-provider.factory';
import { OpenAiProvider } from './openai.provider';

/**
 * SSoT for LLM provider wiring. Both the agent runner (chat) and the
 * tenant-config CRUD (key-validation ping) depend on the factory, so it lives
 * in its own module to avoid an AgentModule ↔ AgentConfigModule import cycle.
 */
@Module({
  providers: [AnthropicProvider, OpenAiProvider, LlmProviderFactory],
  exports: [LlmProviderFactory],
})
export class LlmProvidersModule {}
