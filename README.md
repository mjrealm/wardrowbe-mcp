# wardrowbe-mcp

An [MCP](https://modelcontextprotocol.io) server for [Wardrowbe](https://github.com/Anyesh/wardrowbe), the self-hosted wardrobe app. It lets any MCP client list and inspect items, log wear and washes, suggest outfits, and check analytics.

Requires Node.js 20 or newer.

## Quick start

You need your Wardrowbe URL and an OIDC client for Wardrowbe. Pocket ID works.

1. In your IdP, create a public client with PKCE. Allow the scopes `openid profile email offline_access`, and add the redirect URI `http://localhost:8765/callback`.
2. Add the server to your MCP client. For Claude Desktop or Claude Code:

   ```json
   {
     "mcpServers": {
       "wardrowbe": {
         "command": "npx",
         "args": ["-y", "@mdeleon23/wardrowbe-mcp"],
         "env": {
           "WARDROWBE_URL": "https://wardrowbe.example.com",
           "OIDC_ISSUER_URL": "https://pocket.example.com",
           "OIDC_CLIENT_ID": "wardrowbe"
         }
       }
     }
   }
   ```

3. Call `list_items` from your client. The first time, your browser opens for sign-in. After that, the refresh token is saved and you won't be asked again.

To use a plain access token instead, set `WARDROWBE_TOKEN` in place of the `OIDC_*` variables. It expires, so OIDC is better for regular use.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `WARDROWBE_URL` | yes | | Base URL of your Wardrowbe instance. |
| `WARDROWBE_TOKEN` | or OIDC | | A Wardrowbe access token (JWT). |
| `OIDC_ISSUER_URL` | or token | | OIDC issuer, e.g. `https://pocket.example.com`. |
| `OIDC_CLIENT_ID` | with OIDC | | OIDC client ID. |
| `OIDC_CLIENT_SECRET` | no | | Only for confidential clients. |
| `OIDC_REFRESH_TOKEN` | no | | Use this refresh token instead of the saved one. For headless hosts (see below). |
| `WARDROWBE_TOKEN_FILE` | no | `~/.config/wardrowbe-mcp/refresh-token.json` | Where the refresh token is saved. |
| `MCP_TRANSPORT` | no | `stdio` | `stdio` or `http`. |
| `MCP_BIND_HOST` | no | `127.0.0.1` | Address for HTTP. Use `0.0.0.0` in containers. |
| `MCP_PORT` | no | `8080` | Port for HTTP. |
| `MCP_API_KEY` | http only | | Bearer key that clients send to `/mcp`. |

## How sign-in works

With OIDC set, the server signs in through your browser the first time a tool needs a token. It catches the redirect on `localhost:8765`, then saves the refresh token to `WARDROWBE_TOKEN_FILE` with owner-only permissions. Later runs reuse it. If the token is revoked, the server signs in once more.

The browser sign-in needs a browser on the same machine as the server. On a headless host or in a container, sign in elsewhere and pass the token in:

```bash
npx -y @mdeleon23/wardrowbe-mcp login --issuer https://pocket.example.com --client-id wardrowbe > refresh-token.txt
```

Then set `OIDC_REFRESH_TOKEN` to the contents of `refresh-token.txt`, and delete the file.

## HTTP transport

For MCPHub or any client that connects to a URL:

```bash
MCP_TRANSPORT=http \
MCP_BIND_HOST=0.0.0.0 \
MCP_API_KEY="$(openssl rand -hex 32)" \
WARDROWBE_URL=https://wardrowbe.example.com \
OIDC_ISSUER_URL=https://pocket.example.com \
OIDC_CLIENT_ID=wardrowbe \
OIDC_REFRESH_TOKEN=<refresh-token> \
npx -y @mdeleon23/wardrowbe-mcp
```

Register the server at `http://<host>:8080/mcp` with the header `Authorization: Bearer <MCP_API_KEY>`. `GET /` returns a small info response without auth.

### Adding items from photos

Photos go to the server directly, not through the AI, so the model never has to handle image bytes:

1. The app uploads the photo to `POST /uploads` with the same Bearer key. Send the raw image as the body, with `Content-Type` set to `image/jpeg`, `image/png`, `image/webp`, or `image/heic`. Optionally set `X-Filename` (URL-encoded).
2. The response is `{"upload_id": "...", "expires_in_seconds": 600}`.
3. The agent calls `add_item` with that `upload_id`. The upload is used once and then deleted. Uploads over 15 MB are refused, and uploads expire after 10 minutes.

```bash
curl -s -X POST https://<host>:8080/uploads \
  -H "Authorization: Bearer <MCP_API_KEY>" \
  -H "Content-Type: image/jpeg" \
  -H "X-Filename: blue-shirt.jpg" \
  --data-binary @blue-shirt.jpg
```

An agent can also do the whole thing through MCP with the `upload_photo` tool, which takes the photo as base64 (up to 300 KB) and returns an `upload_id` for `add_item`. The model has to write the image out in full, so keep photos small for this route. Full-size phone photos should go through `/uploads`.

`add_item` works over stdio too, as long as the `upload_id` came from `upload_photo` in the same server process. `/uploads` is HTTP only.

## Tools

| Tool | Wardrowbe endpoint | Notes |
| --- | --- | --- |
| `list_items` | `GET /items` | Filter by type, status, favorites, needs wash, search. Paginated. |
| `get_item` | `GET /items/{id}` | |
| `log_wear` | `POST /items/{id}/wear` | Defaults to today. |
| `log_wash` | `POST /items/{id}/wash` | Defaults to today. |
| `suggest_outfit` | `POST /outfits/suggest` | Rate limited to about 10 per minute per user. |
| `accept_outfit` | `POST /outfits/{id}/accept` | |
| `reject_outfit` | `POST /outfits/{id}/reject` | |
| `upload_photo` | `POST /uploads` (in-process) | Takes a small photo as base64 (up to 300 KB) and returns an `upload_id`. |
| `add_item` | `POST /items` | Takes an `upload_id` from `upload_photo` or `/uploads`. Wardrowbe detects the type unless you pass one. |
| `get_analytics` | `GET /analytics` | `days` from 7 to 365. |
| `get_wardrobe_summary` | `GET /analytics` | Counts, insights, most and never worn items. Good first call. |
| `get_most_worn_items` | `GET /analytics` | Up to 5 items, from the same trend window. |
| `get_items_to_wash` | `GET /items?needs_wash=true` | Items worn since their last wash. |
| `archive_item` | `POST /items/{id}/archive` | Hides an item from suggestions. Reversible. Takes an optional `reason`. |
| `restore_item` | `POST /items/{id}/restore` | Brings an archived item back. |

## Skill

The server publishes `skill://wardrowbe-skill/SKILL.md` as an MCP resource. It explains which tool to use for each task, how to add an item from a photo (including re-encoding large photos), and how archiving works. Clients that install skills pick it up automatically. The source is in [`skill/SKILL.md`](skill/SKILL.md).

## Development

```bash
npm install
npm run build
npm test
```

Written against Wardrowbe 1.13.x. If Wardrowbe changes its endpoints, update `src/tools.ts`.
