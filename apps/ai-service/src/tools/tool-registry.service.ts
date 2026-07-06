import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DiscoveryService } from '@nestjs/core';
import { ITool, ToolMetadata, ToolCategory } from './core/tool.interface';
import { getToolMetadata } from './core/tool.decorator';

/**
 * Central tool registry — discovers all @Tool() decorated providers at
 * application startup via NestJS DiscoveryService.
 *
 * WHY DiscoveryService (FAZ0-BOOT-01): the previous implementation injected a
 * `TOOL_PROVIDERS` token expecting Angular-style `multi: true` accumulation.
 * NestJS has no multi-providers — the registry module's own
 * `{ provide: TOOL_PROVIDERS, useValue: [] }` always won DI resolution and the
 * registry initialized with ZERO tools, so every agent run had an empty tool
 * belt. DiscoveryService is the framework-native pattern: it enumerates every
 * instantiated provider across all modules; we register the ones carrying
 * @Tool() metadata. Correct behaviour is now the zero-effort default — a new
 * tool only needs to be a provider in any module (architectural tier 2).
 */
@Injectable()
export class ToolRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly tools = new Map<string, ITool>();
  private readonly metadataCache = new Map<string, ToolMetadata>();

  constructor(private readonly discovery: DiscoveryService) {}

  onModuleInit(): void {
    // Lifecycle guarantee: Nest instantiates ALL static providers before any
    // onModuleInit hook fires, so every tool instance exists by the time this
    // runs — no import-order coupling between the registry and tool modules.
    for (const wrapper of this.discovery.getProviders()) {
      const instance: unknown = wrapper.instance;
      if (instance === null || typeof instance !== 'object') {
        continue;
      }

      const metadata = getToolMetadata(instance.constructor);
      if (!metadata) {
        continue; // not a tool — the overwhelmingly common case
      }

      if (
        typeof (instance as ITool).execute !== 'function' ||
        typeof (instance as ITool).validate !== 'function'
      ) {
        this.logger.warn(
          `@Tool()-decorated provider ${instance.constructor.name} does not implement ITool — skipping`,
        );
        continue;
      }
      const tool = instance as ITool;

      const existing = this.tools.get(metadata.name);
      if (existing) {
        // Same class provided by two modules yields two instances — benign
        // registration duplication, first one wins. Two DIFFERENT classes
        // claiming one tool name is a real conflict Claude cannot resolve.
        if (existing.constructor === tool.constructor) {
          continue;
        }
        throw new Error(
          `Duplicate tool name: "${metadata.name}" registered by both ` +
            `${existing.constructor.name} and ${tool.constructor.name}`,
        );
      }

      this.tools.set(metadata.name, tool);
      this.metadataCache.set(metadata.name, metadata);
      this.logger.log(`Registered tool: ${metadata.name} [${metadata.category}]`);
    }

    this.logger.log(`Tool registry initialized with ${this.tools.size} tools`);
  }

  /** Get a tool by name */
  getTool(name: string): ITool | undefined {
    return this.tools.get(name);
  }

  /** Get all tool metadata (for Claude tool definitions) */
  getAllMetadata(): ToolMetadata[] {
    return Array.from(this.metadataCache.values());
  }

  /** Get tool metadata filtered by category */
  getMetadataByCategory(category: ToolCategory): ToolMetadata[] {
    return this.getAllMetadata().filter((m) => m.category === category);
  }

  /** Get tool names filtered by allowed permissions */
  getToolNamesForRoles(roles: string[]): string[] {
    return this.getAllMetadata()
      .filter((m) => m.requiredPermissions.some((p) => roles.includes(p)))
      .map((m) => m.name);
  }

  /** Get tool metadata as Claude tool definitions (for API call) */
  getClaudeToolDefinitions(toolNames: string[]): Array<{
    name: string;
    description: string;
    input_schema: Record<string, unknown>;
  }> {
    return toolNames
      .map((name) => this.metadataCache.get(name))
      .filter((m): m is ToolMetadata => m !== undefined)
      .map((m) => ({
        name: m.name,
        description: m.description,
        input_schema: m.inputSchema,
      }));
  }

  /** Check if a tool exists */
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  /** Get total tool count */
  get size(): number {
    return this.tools.size;
  }
}
