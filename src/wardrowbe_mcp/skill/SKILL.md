---
name: wardrowbe
description: Manage a Wardrowbe wardrobe through MCP tools. Use it to browse and add items, log wear and washes, archive or restore items, check wardrobe stats, and handle outfit suggestions.
---

# Wardrowbe wardrobe

Use these tools to help the user with their own wardrobe. Wardrowbe stores each item with a photo, a type, colors, and wear and wash history.

## Choosing a tool

| The user wants to... | Use |
| --- | --- |
| See how the wardrobe is doing | `get_wardrobe_summary` |
| Find or look at items | `list_items`, then `get_item` for details |
| Know what needs washing | `get_items_to_wash` |
| Know what they wear most | `get_most_worn_items` |
| Log a day's wear or a wash | `log_wear`, `log_wash` |
| Remove an item from suggestions without deleting it | `archive_item` |
| Bring an archived item back | `restore_item` |
| Add a new item from a photo | `get_upload_url`, upload the file to that URL, then `add_item` (see below) |
| Get or respond to outfit suggestions | `suggest_outfit`, `accept_outfit`, `reject_outfit` |

## Adding an item from a photo

Photos never go through MCP tool calls as image data. You read the photo from **your own filesystem** and send the raw file over plain HTTP to a one-time URL this server gives you. The MCP server cannot read files on your machine and `add_item` takes no file path, so the upload is always your job. No password or key is needed: the URL itself is the credential.

### Steps

1. Find the photo on your own filesystem: a path the user gave you, an attachment saved to disk, or a file you downloaded. Check that it exists and is an image.
2. Call `get_upload_url`. It returns `upload_id`, `upload_url` and `expires_in_seconds`.
3. Send the file to `upload_url` with a shell or HTTP tool:

   ```bash
   curl -s -X POST "$UPLOAD_URL" \
     -H "Content-Type: image/jpeg" \
     -H "X-Filename: blue-shirt.jpg" \
     --data-binary @blue-shirt.jpg
   # {"upload_id": "3f2b...", "expires_in_seconds": 600}
   ```

4. Call `add_item` with that `upload_id`. Pass `type`, `name`, `colors`, or `brand` only if the user gave them. Otherwise leave them out and Wardrowbe detects them.

### Details

- `Content-Type` must match the file: `image/jpeg`, `image/png`, `image/webp`, `image/heic` or `image/heif`. Send the raw bytes with `--data-binary`. Don't use `-F` or base64.
- `X-Filename` is optional and only used as a label.
- If `relative_to_server` is `true`, `upload_url` is only a path. Put the server's address in front of it: the MCP server URL without `/mcp`.
- Treat `upload_url` like a password for one photo. Don't show it to the user or paste it anywhere else.
- Up to 15 MB per photo. The URL works once and expires after 10 minutes, so upload and call `add_item` back to back. A rejected photo (wrong type, too large) does not use up the URL.
- `415` means the wrong image type. `413` means the file is too large. `404` means the URL expired or was already used, so call `get_upload_url` again.
- One upload per item. For several photos, repeat steps 2 to 4 for each.

### If you can't send files

Without a shell or HTTP tool, don't paste the image into a tool call or try to encode it. Tell the user you can't upload from here and ask them to add the photo in the Wardrowbe app.

## Archiving

Archive is reversible. Prefer it over anything destructive. When an item is archived, it stays in the wardrobe and can be restored, but it's left out of outfit suggestions. Confirm with the user before archiving an item they didn't name.

## Reading results

- Tool results are JSON. Summarize them for the user rather than dumping the raw fields.
- `get_most_worn_items` returns at most 5 items.
- Errors come back as tool errors with Wardrowbe's message. Read the message and tell the user what went wrong. Retry only if the fix is clear, such as a wrong ID.
