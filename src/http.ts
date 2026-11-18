import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Config } from "./config.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_UPLOAD_BYTES,
  sharedUploads,
  UPLOAD_TTL_MS,
  UploadError,
  type UploadStore,
} from "./uploads.js";

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

/** Reads the body, or returns "too-large" if it goes past the limit. The rest is drained so the response can be sent. */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | "too-large"> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? "too-large" : Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Keeps just a safe file name: no folders, no control characters, at most 200 characters. */
function sanitizeFilename(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  let name = raw ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // Keep the raw value if it isn't valid percent-encoding.
  }
  name = name
    .split(/[\\/]/)
    .pop()!
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 200);
  return name || "photo.jpg";
}

/**
 * POST /uploads takes the raw photo bytes (Content-Type image/*, optional X-Filename header) and
 * returns an upload_id. The add_item tool then uses that id, so the photo never passes through the model.
 */
async function handleUpload(req: IncomingMessage, res: ServerResponse, uploads: UploadStore): Promise<void> {
  const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED_IMAGE_TYPES.includes(contentType)) {
    sendJson(res, 415, { error: `Send the photo as one of: ${ALLOWED_IMAGE_TYPES.join(", ")}` });
    return;
  }
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    sendJson(res, 413, { error: `Photo is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` });
    return;
  }

  const body = await readBody(req, MAX_UPLOAD_BYTES);
  if (body === "too-large") {
    sendJson(res, 413, { error: `Photo is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` });
    return;
  }
  if (body.length === 0) {
    sendJson(res, 400, { error: "The request had no photo data" });
    return;
  }

  try {
    const upload_id = uploads.put({
      bytes: body,
      contentType,
      filename: sanitizeFilename(req.headers["x-filename"]),
    });
    sendJson(res, 201, { upload_id, expires_in_seconds: UPLOAD_TTL_MS / 1000 });
  } catch (err) {
    if (err instanceof UploadError) {
      sendJson(res, 429, { error: err.message });
      return;
    }
    throw err;
  }
}

/**
 * Serves the MCP endpoint at /mcp over Streamable HTTP, stateless, behind a Bearer API key.
 * Also serves POST /uploads, where the app sends a photo before asking the agent to add it.
 */
export function createMcpHttpServer(config: Config, uploads: UploadStore = sharedUploads) {
  const apiKey = config.apiKey;
  if (!apiKey) throw new Error("MCP_API_KEY is required for the http transport");

  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/" && req.method === "GET") {
      sendJson(res, 200, { name: SERVER_NAME, version: SERVER_VERSION, endpoint: "/mcp", uploads: "/uploads" });
      return;
    }
    if (url.pathname !== "/mcp" && url.pathname !== "/uploads") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (!isAuthorized(req.headers.authorization, apiKey)) {
      res.setHeader("WWW-Authenticate", "Bearer");
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (url.pathname === "/uploads") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        sendJson(res, 405, { error: "method not allowed" });
        return;
      }
      await handleUpload(req, res, uploads);
      return;
    }

    // Stateless: a fresh server and transport per request, so no session state is kept between calls.
    const server = createServer(config, fetch, uploads);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
}
