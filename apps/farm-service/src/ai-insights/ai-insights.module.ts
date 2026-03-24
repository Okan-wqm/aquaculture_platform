/**
 * WHY: AiInsightsModule encapsulates all AI/MCP-related providers in a single
 * NestJS module, following the Module pattern that keeps feature boundaries
 * explicit. This module can be conditionally imported (e.g. via feature flag)
 * to enable/disable AI capabilities without touching other farm service modules.
 *
 * PROVIDER REGISTRATION ORDER:
 *  1. McpClientService  — lowest level: manages MCP server process lifecycle
 *  2. AiInsightsService — middle layer: business logic, caching, composition
 *  3. AiInsightsResolver — top layer: GraphQL API surface
 *
 * EXPORTS: AiInsightsService is exported so other farm modules (e.g. alerts,
 * scheduler) can consume AI insights programmatically without going through
 * the GraphQL layer.
 */
import { Module } from '@nestjs/common';
import { McpClientService } from './services/mcp-client.service';
import { AiInsightsService } from './services/ai-insights.service';
import { AiInsightsResolver } from './ai-insights.resolver';

@Module({
  providers: [
    /**
     * WHY: McpClientService is module-scoped (not global) because only
     * AiInsightsService should interact with the MCP server. This prevents
     * accidental coupling from other modules.
     */
    McpClientService,
    AiInsightsService,
    AiInsightsResolver,
  ],
  exports: [
    /**
     * WHY: Exporting AiInsightsService (not McpClientService) ensures other
     * modules access AI insights through the cached business logic layer,
     * never bypassing cache or circuit breaker protections.
     */
    AiInsightsService,
  ],
})
export class AiInsightsModule {}
