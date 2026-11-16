import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

/** Constant-time check of the Bearer token, so the comparison doesn't leak the key by timing. */
export function isAuthorized(header: string | undefined, apiKey: string): boolean {
  const match = /^Bearer (.+)$/.exec(header ?? "");
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(apiKey);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Serves the MCP endpoint at /mcp over Streamable HTTP, stateless, behind a Bearer API key. */
export function createMcpHttpServer(config: Config) {
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error("MCP_API_KEY is required for the http transport");

  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/" && req.method === "GET") {
      sendJson(res, 200, { name: SERVER_NAME, version: SERVER_VERSION, endpoint: "/mcp" });
      return;
    }
    if (url.pathname !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (!isAuthorized(req.headers.authorization, apiKey)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    // Stateless: a fresh server and transport per request, so no session state is kept between calls.
    const server = createServer(config);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
}
