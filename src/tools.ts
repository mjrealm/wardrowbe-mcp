import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WardrowbeClient } from "./client.js";

const uuid = z.string().uuid().describe("Item or outfit UUID");
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .describe("Date as YYYY-MM-DD");

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

/** Wraps a tool body so API errors come back as tool errors the model can read, not crashes. */
async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

/** Registers the Wardrowbe tools on an MCP server. */
export function registerTools(server: McpServer, client: WardrowbeClient): void {
  server.registerTool(
    "list_items",
    {
      title: "List wardrobe items",
      description:
        "List items in the user's wardrobe. Filter by type, status, favorites, or items that need washing.",
      inputSchema: {
        type: z.string().optional().describe("Item type, e.g. top, bottom, shoes"),
        subtype: z.string().optional(),
        colors: z.string().optional().describe("Comma-separated color names"),
        status: z.string().optional(),
        favorite: z.boolean().optional(),
        needs_wash: z.boolean().optional(),
        search: z.string().optional(),
        page: z.number().int().min(1).optional(),
        page_size: z.number().int().min(1).optional(),
      },
    },
    (args) => run(() => client.get("/items", args)),
  );

  server.registerTool(
    "get_item",
    {
      title: "Get a wardrobe item",
      description: "Get full details for one wardrobe item, including its wear and wash status.",
      inputSchema: { item_id: uuid },
    },
    ({ item_id }) => run(() => client.get(`/items/${item_id}`)),
  );

  server.registerTool(
    "log_wear",
    {
      title: "Log an item as worn",
      description:
        "Record that an item was worn. Defaults to today in the user's timezone when worn_at is omitted.",
      inputSchema: {
        item_id: uuid,
        worn_at: isoDate.optional(),
        occasion: z.string().optional(),
        notes: z.string().optional(),
      },
    },
    ({ item_id, ...body }) => run(() => client.post(`/items/${item_id}/wear`, body)),
  );

  server.registerTool(
    "log_wash",
    {
      title: "Log an item as washed",
      description:
        "Record that an item was washed. Defaults to today in the user's timezone when washed_at is omitted.",
      inputSchema: {
        item_id: uuid,
        washed_at: isoDate.optional(),
        method: z.string().max(50).optional(),
        notes: z.string().optional(),
      },
    },
    ({ item_id, ...body }) => run(() => client.post(`/items/${item_id}/wash`, body)),
  );

  server.registerTool(
    "suggest_outfit",
    {
      title: "Suggest an outfit",
      description:
        "Ask Wardrowbe to suggest an outfit from the wardrobe. Rate limited to about 10 requests per minute per user.",
      inputSchema: {
        occasion: z.string().optional(),
        time_of_day: z.string().optional(),
        exclude_items: z.array(uuid).optional(),
        include_items: z.array(uuid).optional(),
      },
    },
    (args) =>
      run(() =>
        client.post("/outfits/suggest", {
          occasion: args.occasion,
          time_of_day: args.time_of_day,
          exclude_items: args.exclude_items ?? [],
          include_items: args.include_items ?? [],
        }),
      ),
  );

  server.registerTool(
    "accept_outfit",
    {
      title: "Accept an outfit",
      description: "Mark a suggested outfit as accepted.",
      inputSchema: { outfit_id: uuid },
    },
    ({ outfit_id }) => run(() => client.post(`/outfits/${outfit_id}/accept`)),
  );

  server.registerTool(
    "reject_outfit",
    {
      title: "Reject an outfit",
      description: "Mark a suggested outfit as rejected, so it is not suggested again.",
      inputSchema: { outfit_id: uuid },
    },
    ({ outfit_id }) => run(() => client.post(`/outfits/${outfit_id}/reject`)),
  );

  server.registerTool(
    "get_analytics",
    {
      title: "Wardrobe analytics",
      description: "Get wardrobe analytics, including trends over a chosen window of days.",
      inputSchema: {
        days: z.number().int().min(7).max(365).optional().describe("Trend window, 7 to 365 days"),
      },
    },
    ({ days }) => run(() => client.get("/analytics", { days: days ?? 30 })),
  );
}
