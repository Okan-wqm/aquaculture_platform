export interface McpTextContent {
  type: string;
  text?: string;
}

export interface McpToolResult {
  content?: McpTextContent[];
}

export interface McpClientPort {
  connect(transport: unknown): Promise<void>;
  callTool(request: { name: string; arguments: Record<string, unknown> }): Promise<McpToolResult>;
  close?(): Promise<void>;
}

export interface McpTransportOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

interface McpSdkClientModule {
  Client: new (
    clientInfo: { name: string; version: string },
    options: { capabilities: Record<string, unknown> },
  ) => McpClientPort;
}

interface McpSdkTransportModule {
  StdioClientTransport: new (options: McpTransportOptions) => unknown;
}

export interface McpSdkPort {
  Client: McpSdkClientModule['Client'];
  StdioClientTransport: McpSdkTransportModule['StdioClientTransport'];
}

export async function loadOptionalMcpSdk(): Promise<McpSdkPort> {
  const clientModule = (await import(
    '@modelcontextprotocol/sdk/client/index.js'
  )) as Partial<McpSdkClientModule>;
  const transportModule = (await import(
    '@modelcontextprotocol/sdk/client/stdio.js'
  )) as Partial<McpSdkTransportModule>;

  if (typeof clientModule.Client !== 'function') {
    throw new Error('MCP SDK Client export is unavailable');
  }

  if (typeof transportModule.StdioClientTransport !== 'function') {
    throw new Error('MCP SDK StdioClientTransport export is unavailable');
  }

  return {
    Client: clientModule.Client,
    StdioClientTransport: transportModule.StdioClientTransport,
  };
}
