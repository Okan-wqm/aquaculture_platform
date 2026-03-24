/**
 * WHY: McpClientService encapsulates all communication with the MCP Farm
 * Intelligence server via stdio transport. By isolating MCP protocol concerns
 * in a dedicated service, the business logic layer (AiInsightsService) stays
 * decoupled from transport details — satisfying the Single Responsibility and
 * Dependency Inversion principles.
 *
 * CIRCUIT BREAKER: Protects the farm service from cascading failures when the
 * MCP server process is unresponsive. After 3 consecutive failures, the circuit
 * opens for 30 seconds and callTool returns null immediately — allowing callers
 * to fall back to cached data gracefully.
 */
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * WHY: Enum makes circuit breaker state transitions explicit and prevents
 * magic string comparisons scattered across the class.
 */
enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

/**
 * WHY: Constants are extracted so tuning thresholds does not require code
 * changes throughout the class. Environment-specific overrides can be added
 * via ConfigService in the future.
 */
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

@Injectable()
export class McpClientService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpClientService.name);

  /**
   * WHY: The MCP SDK Client provides a high-level callTool API over the
   * JSON-RPC transport, handling message framing and request correlation.
   */
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  // -- Circuit breaker state --
  private circuitState: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  /**
   * WHY: MCP_SERVER_PATH allows operators to point at different server builds
   * (dev vs production) without changing application code.
   */
  private readonly serverPath: string;
  private readonly gatewayUrl: string;

  constructor(private readonly configService: ConfigService) {
    /**
     * WHY: Default path resolves to the MCP server source via tsx for
     * development. In production Docker images, MCP_SERVER_PATH is overridden
     * to point at the compiled dist/index.js. Using tsx as default avoids
     * build synchronization issues during local development.
     */
    this.serverPath = this.configService.get<string>(
      'MCP_SERVER_PATH',
      'mcp/farm-management/src/index.ts',
    );
    this.gatewayUrl = this.configService.get<string>(
      'GATEWAY_URL',
      'http://localhost:3000/graphql',
    );
  }

  /**
   * WHY: onModuleInit is the NestJS lifecycle hook that guarantees the MCP
   * server process is up before any resolver can call callTool(). This avoids
   * race conditions during application bootstrap.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.connect();
    } catch (error) {
      /**
       * WHY: A failed MCP connection at startup should NOT crash the entire
       * farm service — the rest of the farm APIs (tanks, batches, feeding) must
       * remain operational. AI insights will gracefully return null.
       */
      this.logger.error(
        'Failed to connect to MCP server on startup — AI insights will be unavailable until reconnected',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * WHY: Graceful shutdown prevents orphaned child processes and leaked file
   * descriptors in container environments.
   */
  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  /**
   * WHY: Spawns the MCP server as a child process and establishes the stdio
   * transport. Separated from onModuleInit so it can be retried independently.
   */
  private async connect(): Promise<void> {
    this.logger.log(`Connecting to MCP server at ${this.serverPath}`);

    /**
     * WHY: StdioClientTransport spawns the child process and wires
     * stdin/stdout for JSON-RPC framing. Environment variables are forwarded
     * so the MCP server can reach the GraphQL gateway.
     *
     * WHY: Use 'npx tsx' for .ts files (development) and 'node' for .js files
     * (production). This avoids requiring a separate build step during dev.
     */
    const isTypeScript = this.serverPath.endsWith('.ts');
    const command = isTypeScript ? 'npx' : 'node';
    const args = isTypeScript ? ['tsx', this.serverPath] : [this.serverPath];

    this.transport = new StdioClientTransport({
      command,
      args,
      env: {
        ...process.env,
        GATEWAY_URL: this.gatewayUrl,
        /**
         * WHY: MCP_JWT_TOKEN must be forwarded from the farm service env so
         * that the child MCP server can authenticate with the gateway.
         */
        MCP_JWT_TOKEN: this.configService.get<string>('MCP_JWT_TOKEN', ''),
      },
    });

    this.client = new Client(
      { name: 'farm-service-mcp-client', version: '1.0.0' },
      { capabilities: {} },
    );

    await this.client.connect(this.transport);
    this.logger.log('MCP client connected successfully');
  }

  /**
   * WHY: Cleanly shuts down the MCP SDK client and transport, which in turn
   * sends SIGTERM to the child process.
   */
  private async disconnect(): Promise<void> {
    try {
      if (this.client) {
        await this.client.close();
        this.client = null;
      }
      if (this.transport) {
        await this.transport.close();
        this.transport = null;
      }
      this.logger.log('MCP client disconnected');
    } catch (error) {
      this.logger.warn(
        'Error during MCP client disconnect',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * WHY: callTool is the single public API for invoking any MCP tool. It
   * wraps the raw MCP SDK call with circuit breaker protection and a timeout
   * guard, ensuring the farm service never blocks indefinitely on a stalled
   * MCP server.
   *
   * @param name  - MCP tool name (e.g. 'assess_risk', 'detect_anomalies')
   * @param params - Tool-specific input parameters
   * @returns Parsed JSON result from the tool, or null if the call failed
   */
  async callTool<T = unknown>(
    name: string,
    params: Record<string, unknown>,
  ): Promise<T | null> {
    /**
     * WHY: Circuit breaker check BEFORE attempting the call avoids wasting
     * resources on a server that is known to be down.
     */
    if (!this.isCircuitAllowed()) {
      this.logger.warn(
        `Circuit breaker OPEN — skipping MCP tool call: ${name}`,
      );
      return null;
    }

    if (!this.client) {
      this.logger.warn(`MCP client not connected — cannot call tool: ${name}`);
      this.recordFailure();
      return null;
    }

    try {
      /**
       * WHY: AbortController enforces a hard timeout so that a stalled MCP
       * server cannot block the NestJS event loop indefinitely.
       */
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS,
      );

      const result = await Promise.race([
        this.client.callTool({ name, arguments: params }),
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () =>
            reject(new Error(`MCP tool call timed out after ${REQUEST_TIMEOUT_MS}ms: ${name}`)),
          );
        }),
      ]);

      clearTimeout(timeout);

      /**
       * WHY: Reset circuit breaker on success so that after a transient
       * failure the system recovers automatically.
       */
      this.recordSuccess();

      /**
       * WHY: MCP tools return content as an array of { type, text } items.
       * We parse the first text block as JSON, which is the convention used
       * by all farm-management MCP tools (see assess-risk.ts, detect-anomalies.ts).
       */
      if (result && result.content && Array.isArray(result.content)) {
        const textContent = result.content.find(
          (c: { type: string }) => c.type === 'text',
        );
        if (textContent && 'text' in textContent) {
          return JSON.parse(textContent.text as string) as T;
        }
      }

      return null;
    } catch (error) {
      this.recordFailure();
      this.logger.error(
        `MCP tool call failed: ${name}`,
        error instanceof Error ? error.message : String(error),
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Circuit Breaker internals
  // ---------------------------------------------------------------------------

  /**
   * WHY: Determines whether a call should be attempted based on the current
   * circuit state. In HALF_OPEN, exactly one probe call is allowed to check
   * if the MCP server has recovered.
   */
  private isCircuitAllowed(): boolean {
    if (this.circuitState === CircuitState.CLOSED) {
      return true;
    }

    if (this.circuitState === CircuitState.OPEN) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed >= COOLDOWN_MS) {
        /**
         * WHY: Transition to HALF_OPEN allows a single probe call. If it
         * succeeds, the circuit fully closes; if it fails, it reopens.
         */
        this.circuitState = CircuitState.HALF_OPEN;
        this.logger.log('Circuit breaker transitioning to HALF_OPEN — allowing probe call');
        return true;
      }
      return false;
    }

    // HALF_OPEN: allow the probe
    return true;
  }

  /**
   * WHY: Records a successful call and resets the circuit to CLOSED,
   * clearing the failure counter so normal operation resumes.
   */
  private recordSuccess(): void {
    if (this.circuitState !== CircuitState.CLOSED) {
      this.logger.log('Circuit breaker CLOSED — MCP server recovered');
    }
    this.consecutiveFailures = 0;
    this.circuitState = CircuitState.CLOSED;
  }

  /**
   * WHY: Records a failure and opens the circuit after FAILURE_THRESHOLD
   * consecutive errors to prevent thundering-herd retries against a down server.
   */
  private recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();

    if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.circuitState = CircuitState.OPEN;
      this.logger.warn(
        `Circuit breaker OPEN after ${this.consecutiveFailures} consecutive failures — ` +
        `cooling down for ${COOLDOWN_MS / 1000}s`,
      );
    }
  }
}
