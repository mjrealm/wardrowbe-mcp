#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { createMcpHttpServer } from "./http.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  if (config.transport === "http") {
    const httpServer = createMcpHttpServer(config);
    httpServer.listen(config.port, config.host, () => {
      console.error(
        `${SERVER_NAME} ${SERVER_VERSION} listening on http://${config.host}:${config.port}/mcp`,
      );
    });
    return;
  }

  // stdio: stdout carries MCP frames, so diagnostics go to stderr only.
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} ${SERVER_VERSION} running on stdio`);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${SERVER_NAME}: ${message}`);
  process.exit(err instanceof ConfigError ? 2 : 1);
});
