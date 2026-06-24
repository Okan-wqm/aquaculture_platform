import { Injectable, Logger, OnModuleInit, Inject } from '@nestjs/common';
import { ITool, TOOL_PROVIDERS, ToolMetadata, ToolCategory } from './core/tool.interface';
import { getToolMetadata } from './core/tool.decorator';

/**
 * Central tool registry - discovers all @Tool() decorated classes
 * injected via the TOOL_PROVIDERS multi-provider token.
 */
@Injectable()
export class ToolRegistryService implements OnModuleInit {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly tools = new Map<string, ITool>();
  private readonly metadataCache = new Map<string, ToolMetadata>();

  constructor(
    @Inject(TOOL_PROVIDERS)
    private readonly toolProviders: ITool[],
  ) {}

  onModuleInit(): void {
    for (const tool of this.toolProviders) {
      const metadata = getToolMetadata(tool.constructor);
      if (!metadata) {
        this.logger.warn(
          `Tool provider ${tool.constructor.name} is missing @Tool() decorator - skipping`,
        );
        continue;
      }

      const existing = this.tools.get(metadata.name);
      if (existing) {
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
