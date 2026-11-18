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
| Add a new item | `upload_photo`, then `add_item` (see below) |
| Get or respond to outfit suggestions | `suggest_outfit`, `accept_outfit`, `reject_outfit` |

## Adding an item from a photo

1. Ask the user for a photo of the item.
2. Make sure the photo is under 300 KB before calling `upload_photo`. Phone photos usually aren't, so re-encode them first (see below).
3. Call `upload_photo` with the image as base64 and its MIME type. It returns an `upload_id`.
4. Call `add_item` with that `upload_id`. Pass `type`, `name`, `colors`, or `brand` only if the user gave them. Otherwise leave them out and Wardrowbe detects them.

### Re-encoding a large photo

Shrink the photo before encoding it to base64. Resize the longest side to 512 pixels and save it as JPEG at quality 70. Most clothing photos come out well under 300 KB this way. If the result is still over the limit, lower the quality in steps of 10, down to 50.

If you have no tool to resize or re-encode images, don't send the original. Tell the user the photo is too large and ask for a smaller one, or ask them to use the app, which can upload full-size photos.

An `upload_id` works once and expires after 10 minutes. If `add_item` says the upload was not found, upload the photo again.

## Archiving

Archive is reversible. Prefer it over anything destructive. When an item is archived, it stays in the wardrobe and can be restored, but it's left out of outfit suggestions. Confirm with the user before archiving an item they didn't name.

## Reading results

- Tool results are JSON. Summarize them for the user rather than dumping the raw fields.
- `get_most_worn_items` returns at most 5 items.
- Errors come back as tool errors with Wardrowbe's message. Read the message and tell the user what went wrong. Retry only if the fix is clear, such as a wrong ID.
