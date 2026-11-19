# wardrowbe-mcp

An [MCP](https://modelcontextprotocol.io) server for [Wardrowbe](https://github.com/Anyesh/wardrowbe), the self-hosted wardrobe app. It lets any MCP client list and inspect items, log wear and washes, suggest outfits, and check analytics.

Requires Node.js 20 or newer.

## Quick start

You need:

- Node.js 20 or newer
- Your Wardrowbe URL, for example `https://wardrowbe.example.com`
- An OIDC identity provider that runs Wardrowbe sign-in. Pocket ID works.

Setup has four steps: create an OIDC client, get a refresh token, add the server to your MCP client, and check that it works.

### Step 1: Create an OIDC client

In your identity provider:

1. Create a client. A **public** client uses PKCE and has no secret. A **confidential** client has a client secret. Both work. If yours is confidential, you'll set `OIDC_CLIENT_SECRET` in steps 2 and 3.
2. Allow the scopes `openid profile email offline_access`. `offline_access` is required. Without it the provider returns no refresh token.
3. Add the redirect URI `http://localhost:8765/callback` exactly as written.
4. Note two values: the issuer URL (for example `https://pocket.example.com`) and the client ID (for example `wardrowbe`).

### Step 2: Get a refresh token

Run this on a computer with a web browser. It can be your laptop, even if the MCP server runs somewhere else. Port `8765` must be free.

Run it from a folder outside any project, such as your home directory. Running it inside a clone of this repository fails with `sh: wardrowbe-mcp: command not found`.

If your client is confidential, set the secret in your shell first. `read -s` keeps it out of your shell history and off the command line. Type the secret when prompted and press Enter. Skip this for a public client.

```bash
read -s OIDC_CLIENT_SECRET && export OIDC_CLIENT_SECRET
```

Then run the login. It reads `OIDC_CLIENT_SECRET` from the environment automatically.

```bash
cd ~
npx -y @mdeleon23/wardrowbe-mcp@0.3.0 login \
  --issuer https://pocket.example.com \
  --client-id wardrowbe \
  > refresh-token.txt
chmod 600 refresh-token.txt
```

The command pins `@0.3.0`, the release this step was checked against. You can drop the pin to use the latest release.

1. The command prints progress messages to your terminal and tries to open the provider's sign-in page in your browser. If the browser doesn't open, copy the URL from the terminal into a browser yourself.
2. Sign in and approve the request.
3. The browser then redirects to `localhost:8765`. The terminal prints `Refresh token printed to stdout`. If you see an error instead, see [Troubleshooting](#troubleshooting).
4. `refresh-token.txt` now contains the token. Treat it like a password.

### Step 3: Add the server to your MCP client

For Claude Desktop or Claude Code, add this to your MCP config. Replace `<refresh-token>` with the contents of `refresh-token.txt`:

```json
{
  "mcpServers": {
    "wardrowbe": {
      "command": "npx",
      "args": ["-y", "@mdeleon23/wardrowbe-mcp"],
      "env": {
        "WARDROWBE_URL": "https://wardrowbe.example.com",
        "OIDC_ISSUER_URL": "https://pocket.example.com",
        "OIDC_CLIENT_ID": "wardrowbe",
        "OIDC_REFRESH_TOKEN": "<refresh-token>"
      }
    }
  }
}
```

Save the config, then delete `refresh-token.txt`. The token now lives only in your MCP config.

If you use a confidential client, also add `"OIDC_CLIENT_SECRET": "<client-secret>"` to `env`. Use the same secret as in step 2. The server needs it to refresh the token, so a token from a confidential client won't work without it.

To use a plain access token instead, set `WARDROWBE_TOKEN` in place of the `OIDC_*` variables. It expires, so OIDC is better for regular use.

### Step 4: Check that it works

Restart your MCP client, then ask it to call `get_wardrobe_summary`. It should return your item counts without asking you to sign in. If it reports a token or sign-in error, see [Troubleshooting](#troubleshooting).

## Troubleshooting

**"The identity provider returned no refresh_token"**
The client doesn't allow `offline_access`. Enable that scope on the client, then repeat step 2.

**`sh: wardrowbe-mcp: command not found`**
You ran step 2 from inside a project folder, most likely this repository. Run it from another folder, such as your home directory.

**`Token exchange failed (HTTP 401: invalid_client)`**
The client is confidential, and `OIDC_CLIENT_SECRET` is missing or wrong at login. Set the secret as shown in step 2, then run the login again.

**Port 8765 is in use, or the browser redirect never arrives**
Another program is using port `8765`. Stop it, then repeat step 2. The redirect URI must still be `http://localhost:8765/callback`.

**"OIDC refresh failed" or "The refresh token may be expired or revoked"**
The token is no longer valid. Repeat step 2, then replace `OIDC_REFRESH_TOKEN` in your MCP config with the new token and restart the client.

If your provider rotates refresh tokens, the server saves each new token to `WARDROWBE_TOKEN_FILE`. At startup, though, `OIDC_REFRESH_TOKEN` takes priority over that file. If sign-in worked before and fails after a restart, repeat step 2 and update the config.

**A tool call starts a browser sign-in, or fails without one**
The server can start a browser sign-in by itself the first time a tool needs a token, but that path has not been reliable. Don't rely on it. Complete step 2 ahead of time and set `OIDC_REFRESH_TOKEN`.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `WARDROWBE_URL` | yes | | Base URL of your Wardrowbe instance. |
| `WARDROWBE_TOKEN` | or OIDC | | A Wardrowbe access token (JWT). |
| `OIDC_ISSUER_URL` | or token | | OIDC issuer, e.g. `https://pocket.example.com`. |
| `OIDC_CLIENT_ID` | with OIDC | | OIDC client ID. |
| `OIDC_CLIENT_SECRET` | no | | Only for confidential clients. |
| `OIDC_REFRESH_TOKEN` | no | | Refresh token from step 2 of the Quick start. Takes priority over the saved one. |
| `WARDROWBE_TOKEN_FILE` | no | `~/.config/wardrowbe-mcp/refresh-token.json` | Where the refresh token is saved. |
| `MCP_TRANSPORT` | no | `stdio` | `stdio` or `http`. |
| `MCP_BIND_HOST` | no | `127.0.0.1` | Address for HTTP. Use `0.0.0.0` in containers. |
| `MCP_PORT` | no | `8080` | Port for HTTP. |
| `MCP_API_KEY` | http only | | Bearer key that clients send to `/mcp`. |

## How sign-in works

The server turns the refresh token into a short-lived access token before each batch of calls. It takes the refresh token from `OIDC_REFRESH_TOKEN` if you set it, and otherwise from `WARDROWBE_TOKEN_FILE`. If the provider issues a new refresh token, the server saves it to that file.

Step 2 of the Quick start is the supported way to get a refresh token. This works on headless hosts and in containers too: sign in on any machine with a browser, then pass the token in with `OIDC_REFRESH_TOKEN`.

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
