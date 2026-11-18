import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WardrowbeClient } from "./client.js";
import {
  ALLOWED_IMAGE_TYPES,
  MAX_TOOL_UPLOAD_BYTES,
  sharedUploads,
  type UploadStore,
} from "./uploads.js";

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
export function registerTools(
  server: McpServer,
  client: WardrowbeClient,
  uploads: UploadStore = sharedUploads,
): void {
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

  server.registerTool(
    "upload_photo",
    {
      title: "Upload a photo",
      description: `Upload a photo of a clothing item so add_item can use it. Pass the image as base64. Keep it small: the limit is ${MAX_TOOL_UPLOAD_BYTES / 1024} KB, so use a reduced-size image. Returns an upload_id for add_item. The id is good for 10 minutes and works once.`,
      inputSchema: {
        image_base64: z.string().min(1).describe("The image bytes, base64-encoded, without a data: prefix"),
        mime_type: z.enum(ALLOWED_IMAGE_TYPES as [string, ...string[]]).describe("Image type"),
        filename: z.string().max(200).optional().describe("File name, e.g. blue-shirt.jpg"),
      },
    },
    ({ image_base64, mime_type, filename }) =>
      run(async () => {
        const bytes = Buffer.from(image_base64, "base64");
        if (bytes.length === 0) throw new Error("The image_base64 value decoded to no data.");
        if (bytes.length > MAX_TOOL_UPLOAD_BYTES) {
          throw new Error(
            `The photo is ${Math.round(bytes.length / 1024)} KB, over the ${MAX_TOOL_UPLOAD_BYTES / 1024} KB limit for upload_photo. Send a smaller image.`,
          );
        }
        const upload_id = uploads.put({ bytes, contentType: mime_type, filename: filename ?? "photo.jpg" });
        return { upload_id, expires_in_seconds: 600 };
      }),
  );

  server.registerTool(
    "add_item",
    {
      title: "Add a wardrobe item",
      description:
        "Add a new item to the wardrobe from a photo. The photo must first be uploaded to the server's upload endpoint, which returns an upload_id. Pass that id here. Wardrowbe detects the type and colors unless skip_ai is true or you pass them.",
      inputSchema: {
        upload_id: z.string().uuid().describe("upload_id returned when the photo was uploaded"),
        type: z.string().optional().describe("Item type, e.g. top, bottom, shoes. Detected if omitted."),
        subtype: z.string().optional(),
        name: z.string().max(100).optional(),
        brand: z.string().max(100).optional(),
        notes: z.string().max(1000).optional(),
        colors: z.string().optional().describe("Comma-separated color names"),
        primary_color: z.string().optional(),
        favorite: z.boolean().optional(),
        skip_ai: z.boolean().optional().describe("Skip AI tagging and use only the fields given"),
      },
    },
    ({ upload_id, ...fields }) =>
      run(async () => {
        const photo = uploads.take(upload_id);
        const form = new FormData();
        const bytes = new Uint8Array(photo.bytes);
        form.append("image", new Blob([bytes], { type: photo.contentType }), photo.filename);
        for (const [key, value] of Object.entries(fields)) {
          if (value !== undefined) form.append(key, String(value));
        }
        return client.postForm("/items", form);
      }),
  );
}
