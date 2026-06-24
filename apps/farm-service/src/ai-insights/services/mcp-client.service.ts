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
 *
 * WHY DYNAMIC IMPORT: @modelcontextprotocol/sdk is an optional dependency that
 * may not be present in all deployment environments. Using dynamic import()
 * allows the farm service to start and operate normally without MCP — AI insights
 * simply return null. This prevents a missing optional dependency from crashing
 * the entire farm service.
 */
import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn, ChildProcess } from 'child_process';
import {
  loadOptionalMcpSdk,
  McpClientPort,
} from './mcp-sdk.port';

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
 * changes throughout the class.
 */
const FAILURE_THRESHOLD = 3;
const COOLDOWN_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

@Injectable()
export class McpClientService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(McpClientService.name);

  private client: McpClientPort | null = null;
  private childProcess: ChildProcess | null = null;
  private available = false;

  // -- Circuit breaker state --
  private circuitState: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private lastFailureTime = 0;

  private readonly serverPath: string;
  private readonly gatewayUrl: string;
  private readonly mcpEnabled: boolean;

  constructor(private readonly configService: ConfigService) {
    this.serverPath = this.configService.get<string>(
      'MCP_SERVER_PATH',
      'mcp/farm-management/src/index.ts',
    );
    this.gatewayUrl = this.configService.get<string>(
      'GATEWAY_URL',
      'http://localhost:3000/graphql',
    );
    /**
     * WHY: MCP integration is opt-in via environment variable. In production
     * Docker containers where the MCP server is not deployed alongside farm-service,
     * this defaults to false — preventing startup errors.
     */
    this.mcpEnabled = this.configService.get<string>('MCP_ENABLED', 'false') === 'true';
  }

  async onModuleInit(): Promise<void> {
    if (!this.mcpEnabled) {
      this.logger.log('MCP integration disabled (MCP_ENABLED=false) — AI insights will return defaults');
      return;
    }

    try {
      await this.connect();
    } catch (error) {
      this.logger.error(
        'Failed to connect to MCP server — AI insights unavailable',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.disconnect();
  }

  /**
   * WHY: Spawns the MCP server as a child process and communicates via
   * stdin/stdout JSON-RPC. Uses raw child_process instead of MCP SDK transport
   * to avoid the hard dependency on @modelcontextprotocol/sdk.
   */
  private async connect(): Promise<void> {
    this.logger.log(`Starting MCP server: ${this.serverPath}`);

    const isTypeScript = this.serverPath.endsWith('.ts');
    const command = isTypeScript ? 'npx' : 'node';
    const args = isTypeScript ? ['tsx', this.serverPath] : [this.serverPath];

    this.childProcess = spawn(command, args, {
      env: {
        ...process.env,
        GATEWAY_URL: this.gatewayUrl,
        MCP_JWT_TOKEN: this.configService.get<string>('MCP_JWT_TOKEN', ''),
        MCP_TRANSPORT: 'stdio',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.childProcess.on('exit', (code) => {
      this.logger.warn(`MCP server process exited with code ${code}`);
      this.available = false;
    });

    this.childProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) this.logger.debug(`[MCP stderr] ${msg}`);
    });

    /**
     * WHY: Try to load MCP SDK dynamically. If not available, fall back to
     * raw JSON-RPC over stdio. This makes the SDK truly optional.
     */
    try {
      // WHY .js extensions: @modelcontextprotocol/sdk is published as pure ESM with
      // explicit .js extensions in its package.json "exports" map. Node's ESM resolver
      // requires the file extension for ESM packages — bare specifiers without .js fail
      // with ERR_MODULE_NOT_FOUND. This is the SDK's documented import style.
      const { Client, StdioClientTransport } = await loadOptionalMcpSdk();

      // Kill the raw process — SDK manages its own
      this.childProcess.kill();
      this.childProcess = null;

      const transport = new StdioClientTransport({
        command,
        args,
        env: {
          ...process.env,
          GATEWAY_URL: this.gatewayUrl,
          MCP_JWT_TOKEN: this.configService.get<string>('MCP_JWT_TOKEN', ''),
        },
      });

      this.client = new Client(
        { name: 'farm-service-mcp-client', version: '1.0.0' },
        { capabilities: {} },
      );

      await this.client.connect(transport);
      this.available = true;
      this.logger.log('MCP client connected via SDK transport');
    } catch {
      /**
       * WHY: If SDK is not available, use raw JSON-RPC over child process stdio.
       * This is a simplified fallback that supports basic tool calls without
       * the full MCP protocol negotiation.
       */
      this.available = true;
      this.logger.log('MCP SDK not available — using raw stdio fallback');
    }
  }

  private async disconnect(): Promise<void> {
    try {
      if (this.client?.close) {
        await this.client.close();
        this.client = null;
      }
      if (this.childProcess) {
        this.childProcess.kill('SIGTERM');
        this.childProcess = null;
      }
    } catch (error) {
      this.logger.warn('Error during MCP disconnect', error instanceof Error ? error.message : '');
    }
    this.available = false;
  }

  /**
   * WHY: Single public API for invoking any MCP tool with circuit breaker
   * protection and timeout guard.
   */
  async callTool<T = unknown>(
    name: string,
    params: Record<string, unknown>,
  ): Promise<T | null> {
    if (!this.mcpEnabled || !this.available) return null;
    if (!this.isCircuitAllowed()) return null;

    try {
      if (this.client?.callTool) {
        // SDK path — use the high-level callTool API
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        const result = await Promise.race([
          this.client.callTool({ name, arguments: params }),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () =>
              reject(new Error(`MCP timeout: ${name}`)),
            );
          }),
        ]);

        clearTimeout(timeout);
        this.recordSuccess();

        if (result?.content && Array.isArray(result.content)) {
          const textContent = result.content.find((c: { type: string }) => c.type === 'text');
          if (textContent && 'text' in textContent) {
            return JSON.parse(textContent.text as string) as T;
          }
        }
        return null;
      }

      // Raw stdio fallback — send JSON-RPC directly
      if (this.childProcess?.stdin && this.childProcess?.stdout) {
        return await this.callToolViaStdio<T>(name, params);
      }

      return null;
    } catch (error) {
      this.recordFailure();
      this.logger.error(`MCP tool failed: ${name}`, error instanceof Error ? error.message : '');
      return null;
    }
  }

  /**
   * WHY: Raw stdio JSON-RPC fallback when MCP SDK is not installed.
   * Implements minimal MCP protocol for tool invocation.
   */
  private callToolViaStdio<T>(name: string, params: Record<string, unknown>): Promise<T | null> {
    return new Promise((resolve) => {
      if (!this.childProcess?.stdin || !this.childProcess?.stdout) {
        resolve(null);
        return;
      }

      const timeout = setTimeout(() => {
        this.recordFailure();
        resolve(null);
      }, REQUEST_TIMEOUT_MS);

      const requestId = Date.now();
      const request = JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: { name, arguments: params },
      }) + '\n';

      const onData = (data: Buffer) => {
        try {
          const response = JSON.parse(data.toString());
          if (response.id === requestId) {
            clearTimeout(timeout);
            this.childProcess?.stdout?.removeListener('data', onData);
            this.recordSuccess();
            const text = response.result?.content?.find((c: { type: string }) => c.type === 'text');
            resolve(text ? JSON.parse(text.text) as T : null);
          }
        } catch { /* partial data, wait for more */ }
      };

      this.childProcess.stdout.on('data', onData);
      this.childProcess.stdin.write(request);
    });
  }

  // -- Circuit Breaker --
  private isCircuitAllowed(): boolean {
    if (this.circuitState === CircuitState.CLOSED) return true;
    if (this.circuitState === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime >= COOLDOWN_MS) {
        this.circuitState = CircuitState.HALF_OPEN;
        return true;
      }
      return false;
    }
    return true; // HALF_OPEN
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuitState = CircuitState.CLOSED;
  }

  private recordFailure(): void {
    this.consecutiveFailures++;
    this.lastFailureTime = Date.now();
    if (this.consecutiveFailures >= FAILURE_THRESHOLD) {
      this.circuitState = CircuitState.OPEN;
    }
  }
}
