import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getMcpSearchConfig } from "@evidencegraph/config";
import { IntegrationError } from "./errors.js";

export function createMcpTransport(config) {
  if (config.transport === "stdio") {
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      stderr: "ignore",
    });
  }
  if (config.transport === "http") {
    return new StreamableHTTPClientTransport(new URL(config.url), {
      ...(config.token
        ? {
            requestInit: {
              headers: { authorization: `Bearer ${config.token}` },
            },
          }
        : {}),
    });
  }
  throw new IntegrationError(
    "MCP_NOT_CONFIGURED",
    "No supported MCP transport is configured.",
  );
}

export function createMcpClient({
  config = getMcpSearchConfig(),
  transport,
  clientInfo = { name: "evidencegraph", version: "0.0.1" },
  clientOptions = { capabilities: {} },
} = {}) {
  if (!config) {
    throw new IntegrationError(
      "MCP_NOT_CONFIGURED",
      "No MCP search server is configured.",
    );
  }
  const resolvedTransport = transport ?? createMcpTransport(config);
  const client = new Client(clientInfo, clientOptions);
  let connected = false;

  async function connect() {
    if (connected) return;
    await client.connect(resolvedTransport);
    connected = true;
  }

  async function listTools(options) {
    await connect();
    const result = await client.listTools(undefined, options);
    return result.tools;
  }

  async function callTool(name, args, options) {
    await connect();
    return client.callTool({ name, arguments: args }, undefined, options);
  }

  async function close() {
    if (!connected) return;
    connected = false;
    await client.close();
  }

  return {
    callTool,
    client,
    close,
    config,
    connect,
    listTools,
    transport: resolvedTransport,
  };
}
