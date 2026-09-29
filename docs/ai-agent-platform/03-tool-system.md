# 03 - Tool System Design

## ITool Interface

File: `apps/ai-service/src/tools/core/tool.interface.ts`

```typescript
export interface ITool<TInput = unknown, TOutput = unknown> {
  getMetadata(): ToolMetadata;
  validate(input: TInput): Promise<{ valid: boolean; errors?: string[] }>;
  execute(input: TInput, ctx: ToolExecutionContext): Promise<ToolResult<TOutput>>;
}
```

## ToolMetadata

```typescript
export type ToolCategory =
  | 'water_chemistry'
  | 'growth_analytics'
  | 'feed_management'
  | 'risk_assessment'
  | 'sensor_query'
  | 'farm_query'
  | 'actuation'
  | 'reporting';

export type ToolRuntime = 'cloud' | 'edge' | 'both';

export interface ToolMetadata {
  name: string; // Snake_case tool identifier (e.g., 'calculate_ammonia_toxicity')
  description: string; // Sent to Claude as tool description
  category: ToolCategory;
  runtime: ToolRuntime; // 'cloud' | 'edge' | 'both'
  requiredPermissions: string[]; // e.g. ['operator', 'manager', 'expert']
  inputSchema: Record<string, unknown>; // JSON Schema sent to Claude
  requiresModule: string | null; // Billing module required, null for free tools
  requiresConfirmation: boolean; // true = pause and ask human before executing
}
```

## ToolExecutionContext

Built only by `apps/ai-service/src/tenant-boundary/tool-context.factory.ts`
from the trusted request (gateway JWT, messaging bridge, or a service
principal's mTLS identity). Never from model output or client-supplied values.

```typescript
/** The view a tool's run() receives. */
export interface TenantBoundToolContext {
  readonly tenant: TenantBinding; // the one tenant this execution may touch
  readonly userId: string;
  readonly correlationId: string; // For distributed tracing
}

/** What the executor evaluates (authorization fields a tool never sees). */
export interface ToolExecutionContext extends TenantBoundToolContext {
  userRoles: string[];
  persona: string;
  personaTier: AiPersonaTier | null;
  offeredToolNames: readonly string[];
  actuationPolicy: ActuationPolicy;
  servicePrincipal?: { name: string; grantedToolNames: string[] };
}
```

## ToolResult

```typescript
export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  durationMs: number; // Execution time in milliseconds
  cacheable: boolean; // Whether this result should be cached
  cacheTtlSeconds?: number; // Cache TTL in seconds (if cacheable)
}
```

## @Tool() Decorator

File: `apps/ai-service/src/tools/core/tool.decorator.ts`

Uses `Reflect.defineMetadata` to attach `ToolMetadata` to the class at definition time with a Symbol key.

```typescript
const TOOL_METADATA_KEY = Symbol('tool:metadata');

export function Tool(metadata: ToolMetadata): ClassDecorator {
  return (target: Function) => {
    Reflect.defineMetadata(TOOL_METADATA_KEY, metadata, target);
  };
}

export function getToolMetadata(target: Function): ToolMetadata | undefined {
  return Reflect.getMetadata(TOOL_METADATA_KEY, target);
}
```

The `ToolRegistryService` calls `getToolMetadata(tool.constructor)` at bootstrap to discover all decorated tools.

## BaseTool Abstract Class

File: `apps/ai-service/src/tools/core/base-tool.ts`

```typescript
export abstract class BaseTool<TInput = unknown, TOutput = unknown>
  implements ITool<TInput, TOutput>
{
  protected readonly logger: Logger;

  constructor() {
    this.logger = new Logger(this.constructor.name);
  }

  getMetadata(): ToolMetadata {
    const metadata = getToolMetadata(this.constructor);
    if (!metadata) throw new Error(`Missing @Tool() decorator`);
    return metadata;
  }

  async validate(input: TInput): Promise<{ valid: boolean; errors?: string[] }> {
    if (input === null || input === undefined) {
      return { valid: false, errors: ['Input is required'] };
    }
    return { valid: true };
  }

  async execute(input: TInput, ctx: ToolExecutionContext): Promise<ToolResult<TOutput>> {
    // 1. Validate input
    // 2. Call this.run(input, ctx)
    // 3. Wrap in ToolResult with timing, cacheability
    // 4. Catch errors and return ToolResult with success: false
  }

  /** Subclasses implement this -- the actual computation (tenant-bound view only) */
  protected abstract run(input: TInput, ctx: TenantBoundToolContext): Promise<TOutput>;

  /** Override to enable caching (default: false) */
  protected isCacheable(): boolean {
    return false;
  }

  /** Override to set cache TTL in seconds (default: 300) */
  protected getCacheTtl(): number {
    return 300;
  }
}
```

The `execute` method handles validation, timing, error catching, and cache metadata. Subclasses only implement `run()`.

## Tenant boundary (K10)

Tools have no database path of their own. A tool reaches tenant data only by
sending a request through `TenantBoundNatsClient`
(`apps/ai-service/src/tenant-boundary/tenant-bound-nats.client.ts`):

- `run(input, ctx)` receives a `TenantBoundToolContext`. Its `tenant` is a
  `TenantBinding` minted only by `tenant-boundary/tool-context.factory.ts` from
  the trusted request, never from model output.
- Request fields are typed tenant-free (`Omit<XRequest, 'tenantId'>`); the
  client writes the bound tenant itself and refuses any tenant/schema key.
- The owning service answers with the tenant-bound envelope
  `{ ok, tenantId, data | error }` and reads inside `runInTenantRead`. A reply
  naming another tenant is refused before its data is read: the run stops with
  `tenant_mismatch` and a `TenantAccessDenied` security event is written.

The former `TenantScopedTool` base class (a tool-held `DataSource` with a
session `search_path` that also exposed the cross-tenant `ai` schema) was
removed with PR-T1. `tests/invariants/ai-tenant-boundary.spec.ts` §A and the
ESLint block for `apps/ai-service/src/tools/**` keep transports and TypeORM out
of tool code.

## ToolExecutorService

File: `apps/ai-service/src/tools/core/tool-executor.service.ts`

Pipeline: **resolve tool -> permission check -> confirmation check -> execute -> audit log**

```typescript
@Injectable()
export class ToolExecutorService {
  constructor(private readonly registry: ToolRegistryService) {}

  async executeTool(toolName: string, input: unknown, ctx: ToolExecutionContext): Promise<ToolResult> {
    // 1. Resolve tool from registry
    const tool = this.registry.getTool(toolName);
    if (!tool) return { success: false, error: `Unknown tool: ${toolName}`, ... };

    // 2. Permission check - at least one required permission must match user roles
    const metadata = tool.getMetadata();
    const hasPermission = metadata.requiredPermissions.some(p => ctx.userRoles.includes(p));
    if (!hasPermission) return { success: false, error: 'Permission denied', ... };

    // 3. Confirmation flag check (logged, not yet blocking)
    // 4. Execute tool
    const result = await tool.execute(input, ctx);

    // 5. Audit log (async, fire-and-forget)
    this.logExecution(toolName, input, result, ctx).catch(...);

    return result;
  }
}
```

## ToolRegistryService

File: `apps/ai-service/src/tools/tool-registry.service.ts`

Central registry that discovers all `@Tool()` decorated classes injected via the `TOOL_PROVIDERS` multi-provider token (a Symbol).

```typescript
@Injectable()
export class ToolRegistryService implements OnModuleInit {
  private readonly tools = new Map<string, ITool>();
  private readonly metadataCache = new Map<string, ToolMetadata>();

  constructor(@Inject(TOOL_PROVIDERS) private readonly toolProviders: ITool[]) {}

  onModuleInit(): void {
    // Iterates toolProviders, reads @Tool() metadata, indexes by name
    // Throws on duplicate tool names
  }

  getTool(name: string): ITool | undefined; // O(1) Map lookup
  getAllMetadata(): ToolMetadata[]; // All registered tool metadata
  getMetadataByCategory(category: ToolCategory): ToolMetadata[];
  getToolNamesForRoles(roles: string[]): string[];
  getClaudeToolDefinitions(toolNames: string[]): Array<{ name; description; input_schema }>;
  hasTool(name: string): boolean;
}
```

### Multi-Provider Registration

Tool category modules register their tools using the `TOOL_PROVIDERS` Symbol token:

```typescript
// water-chemistry-tools.module.ts
const TOOLS = [
  CalculateAmmoniaToxicityTool,
  CalculateH2SToxicityTool,
  CalculateCO2LevelTool,
  CalculateCarbonateTool,
  CalculateReagentDosingTool,
  GetReagentListTool,
  SimulateDosingEffectTool,
];

@Module({
  providers: [
    ...TOOLS,
    ...TOOLS.map((tool) => ({
      provide: TOOL_PROVIDERS,
      useExisting: tool,
    })),
  ],
  exports: [TOOL_PROVIDERS],
})
export class WaterChemistryToolsModule {}
```

The `ToolRegistryModule` provides a default empty array for `TOOL_PROVIDERS` so the registry works even with no tools registered.

## How to Add a New Tool (3 Steps)

### Step 1: Create the tool class

```typescript
@Tool({
  name: 'my_new_tool',
  description: 'Does something useful',
  category: 'water_chemistry',
  runtime: 'both',
  requiredPermissions: ['operator', 'manager', 'expert'],
  inputSchema: { type: 'object', properties: { ... }, required: [...] },
  requiresModule: null,
  requiresConfirmation: false,
})
@Injectable()
export class MyNewTool extends BaseTool<MyInput, MyOutput> {
  protected async run(input: MyInput, ctx: ToolExecutionContext): Promise<MyOutput> {
    // implementation
  }
}
```

### Step 2: Register in a tools module

Add to the `TOOLS` array in the appropriate category module (e.g., `water-chemistry-tools.module.ts`) or create a new category module following the same pattern.

### Step 3: Done

The tool is automatically discovered by `ToolRegistryService`, registered in the registry, and available to agents via `getClaudeToolDefinitions()`. No other wiring needed.

## Files

- `apps/ai-service/src/tools/core/tool.interface.ts` - ITool, ToolMetadata, ToolResult, ToolExecutionContext, TOOL_PROVIDERS
- `apps/ai-service/src/tools/core/tool.decorator.ts` - @Tool() decorator, getToolMetadata()
- `apps/ai-service/src/tools/core/base-tool.ts` - BaseTool abstract class
- `apps/ai-service/src/tools/core/tool-executor.service.ts` - ToolExecutorService (permission + execute + audit)
- `apps/ai-service/src/tools/core/index.ts` - Re-exports
- `apps/ai-service/src/tools/tool-registry.service.ts` - ToolRegistryService
- `apps/ai-service/src/tools/tool-registry.module.ts` - ToolRegistryModule
