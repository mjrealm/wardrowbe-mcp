import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";

const BASE = "https://wardrowbe.example.com";
const ITEM = "8c1f2a3e-4b5d-4e6f-8a7b-9c0d1e2f3a4b";

const config: Config = {
  wardrowbeUrl: BASE,
  staticToken: "static-token",
  transport: "stdio",
  host: "127.0.0.1",
  port: 8080,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ANALYTICS = {
  wardrobe: { total_items: 42 },
  insights: ["You have more tops than bottoms."],
  most_worn: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "e" }],
  never_worn: [{ id: "z" }],
  least_worn: [],
  color_distribution: [],
  type_distribution: [],
  acceptance_trend: [],
  insight_items: [],
};

async function connect(fetchFn: typeof fetch) {
  const server = createServer(config, fetchFn);
  const client = new Client({ name: "test", version: "0.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function textOf(result: unknown): string {
  return (result as { content: { text: string }[] }).content[0].text;
}

describe("summary and maintenance tools", () => {
  it("get_wardrobe_summary keeps the overview fields from /analytics", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`${BASE}/api/v1/analytics?days=30`);
      return json(ANALYTICS);
    });
    const client = await connect(fetchFn as unknown as typeof fetch);

    const result = await client.callTool({ name: "get_wardrobe_summary", arguments: {} });
    const body = JSON.parse(textOf(result));
    expect(body.wardrobe).toEqual({ total_items: 42 });
    expect(body.insights).toEqual(["You have more tops than bottoms."]);
    expect(body.never_worn).toHaveLength(1);
    expect(body).not.toHaveProperty("color_distribution");
  });

  it("get_most_worn_items returns the requested number, capped at what Wardrowbe sends", async () => {
    const fetchFn = vi.fn(async () => json(ANALYTICS));
    const client = await connect(fetchFn as unknown as typeof fetch);

    const result = await client.callTool({ name: "get_most_worn_items", arguments: { limit: 2 } });
    expect(JSON.parse(textOf(result)).items).toEqual([{ id: "a" }, { id: "b" }]);
  });

  it("get_items_to_wash asks Wardrowbe for items that need washing", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      expect(String(input)).toBe(`${BASE}/api/v1/items?needs_wash=true&page_size=5`);
      return json({ items: [{ id: ITEM }], total: 1 });
    });
    const client = await connect(fetchFn as unknown as typeof fetch);

    const result = await client.callTool({ name: "get_items_to_wash", arguments: { limit: 5 } });
    expect(result.isError).toBeFalsy();
  });

  it("archive_item posts the reason, and restore_item posts without a body", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return json({ id: ITEM, archived: true });
    });
    const client = await connect(fetchFn as unknown as typeof fetch);

    await client.callTool({ name: "archive_item", arguments: { item_id: ITEM, reason: "worn out" } });
    await client.callTool({ name: "restore_item", arguments: { item_id: ITEM } });

    expect(calls[0]).toEqual({ url: `${BASE}/api/v1/items/${ITEM}/archive`, body: { reason: "worn out" } });
    expect(calls[1]).toEqual({ url: `${BASE}/api/v1/items/${ITEM}/restore`, body: undefined });
  });

  it("rejects a malformed item id before calling Wardrowbe", async () => {
    const fetchFn = vi.fn();
    const client = await connect(fetchFn as unknown as typeof fetch);

    const result = await client.callTool({ name: "restore_item", arguments: { item_id: "not-a-uuid" } });
    expect(result.isError).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("skill resource", () => {
  it("serves SKILL.md as a markdown resource", async () => {
    const client = await connect(vi.fn() as unknown as typeof fetch);

    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain("skill://wardrowbe-skill/SKILL.md");

    const read = await client.readResource({ uri: "skill://wardrowbe-skill/SKILL.md" });
    const first = read.contents[0] as { mimeType?: string; text: string };
    expect(first.mimeType).toBe("text/markdown");
    expect(first.text).toMatch(/^---\nname: wardrowbe/);
    expect(first.text).toContain("add_item");
  });
});
