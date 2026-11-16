import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { WardrowbeClient, TokenProvider } from "./client.js";
import { registerTools } from "./tools.js";

export const SERVER_NAME = "wardrowbe-mcp";
export const SERVER_VERSION = "0.1.0";

/** Builds an MCP server with all Wardrowbe tools registered against the configured instance. */
export function createServer(config: Config, fetchFn: typeof fetch = fetch): McpServer {
  const client = new WardrowbeClient(config, new TokenProvider(config, fetchFn), fetchFn);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, client);
  return server;
}
