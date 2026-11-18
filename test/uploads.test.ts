import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "node:http";
import type { Config } from "../src/config.js";
import { createMcpHttpServer } from "../src/http.js";
import { createServer } from "../src/server.js";
import { MAX_PENDING_UPLOADS, MAX_UPLOAD_BYTES, UploadError, UploadStore } from "../src/uploads.js";

const BASE = "https://wardrowbe.example.com";
const KEY = "test-key";

function config(): Config {
  return {
    wardrowbeUrl: BASE,
    staticToken: "static-token",
    transport: "http",
    host: "127.0.0.1",
    port: 0,
    apiKey: KEY,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("UploadStore", () => {
  it("hands a photo out once", () => {
    const store = new UploadStore();
    const id = store.put({ bytes: Buffer.from("abc"), contentType: "image/jpeg", filename: "shirt.jpg" });

    expect(store.take(id).filename).toBe("shirt.jpg");
    expect(() => store.take(id)).toThrow(UploadError);
  });

  it("forgets photos after the time limit", () => {
    let now = 0;
    const store = new UploadStore(() => now, 1000);
    const id = store.put({ bytes: Buffer.from("abc"), contentType: "image/png", filename: "a.png" });

    now = 1000;
    expect(() => store.take(id)).toThrow(/expired or already been used/);
  });

  it("refuses new photos when too many are waiting", () => {
    const store = new UploadStore();
    for (let i = 0; i < MAX_PENDING_UPLOADS; i++) {
      store.put({ bytes: Buffer.from("x"), contentType: "image/jpeg", filename: "p.jpg" });
    }
    expect(() => store.put({ bytes: Buffer.from("x"), contentType: "image/jpeg", filename: "p.jpg" })).toThrow(
      /Too many photos/,
    );
  });
});

describe("POST /uploads", () => {
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
  });

  async function start(store: UploadStore): Promise<string> {
    server = createMcpHttpServer(config(), store);
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it("requires the API key", async () => {
    const store = new UploadStore();
    const base = await start(store);
    const res = await fetch(`${base}/uploads`, {
      method: "POST",
      headers: { "Content-Type": "image/jpeg" },
      body: Buffer.from("photo"),
    });
    expect(res.status).toBe(401);
  });

  it("stores the photo and returns an upload_id", async () => {
    const store = new UploadStore();
    const base = await start(store);
    const res = await fetch(`${base}/uploads`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "image/heic",
        "X-Filename": encodeURIComponent("blue shirt.heic"),
      },
      body: Buffer.from("photo-bytes"),
    });
    expect(res.status).toBe(201);
    const { upload_id } = (await res.json()) as { upload_id: string };

    const saved = store.take(upload_id);
    expect(saved.bytes.toString()).toBe("photo-bytes");
    expect(saved.contentType).toBe("image/heic");
    expect(saved.filename).toBe("blue shirt.heic");
  });

  it("rejects files that are not images", async () => {
    const base = await start(new UploadStore());
    const res = await fetch(`${base}/uploads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "text/plain" },
      body: "hello",
    });
    expect(res.status).toBe(415);
  });

  it("rejects photos over the size limit", async () => {
    const base = await start(new UploadStore());
    const res = await fetch(`${base}/uploads`, {
      method: "POST",
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "image/jpeg" },
      body: Buffer.alloc(MAX_UPLOAD_BYTES + 1),
    });
    expect(res.status).toBe(413);
  });

  it("only accepts POST", async () => {
    const base = await start(new UploadStore());
    const res = await fetch(`${base}/uploads`, { headers: { Authorization: `Bearer ${KEY}` } });
    expect(res.status).toBe(405);
  });
});

describe("add_item tool", () => {
  it("sends the stored photo and fields to Wardrowbe as a multipart upload", async () => {
    const store = new UploadStore();
    const id = store.put({ bytes: Buffer.from("jpeg-bytes"), contentType: "image/jpeg", filename: "shirt.jpg" });

    let sent: FormData | undefined;
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === `${BASE}/api/v1/items`) {
        sent = init?.body as FormData;
        return json({ id: "item-1", type: "top" }, 201);
      }
      throw new Error(`unexpected ${String(input)}`);
    });

    const server = createServer(config(), fetchFn as unknown as typeof fetch, store);
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);

    const result = await client.callTool({
      name: "add_item",
      arguments: { upload_id: id, name: "Blue shirt", favorite: true, skip_ai: false },
    });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as { text: string }[])[0].text)).toEqual({ id: "item-1", type: "top" });
    expect(sent).toBeInstanceOf(FormData);
    const image = sent!.get("image") as File;
    expect(image.name).toBe("shirt.jpg");
    expect(image.type).toBe("image/jpeg");
    expect(Buffer.from(await image.arrayBuffer()).toString()).toBe("jpeg-bytes");
    expect(sent!.get("name")).toBe("Blue shirt");
    expect(sent!.get("favorite")).toBe("true");
    expect(sent!.get("skip_ai")).toBe("false");
    expect(sent!.has("brand")).toBe(false);
  });

  it("returns a tool error for an unknown or used upload_id", async () => {
    const server = createServer(config(), vi.fn() as unknown as typeof fetch, new UploadStore());
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);

    const result = await client.callTool({
      name: "add_item",
      arguments: { upload_id: "9f1d7c4e-2a3b-4c5d-8e6f-7a8b9c0d1e2f" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toMatch(/not found|expired/);
  });
});
