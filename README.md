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
         "args": ["-y", "@mjrealm/wardrowbe-mcp"],
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
npx -y @mjrealm/wardrowbe-mcp login --issuer https://pocket.example.com --client-id wardrowbe > refresh-token.txt
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
npx -y @mjrealm/wardrowbe-mcp
```

Register the server at `http://<host>:8080/mcp` with the header `Authorization: Bearer <MCP_API_KEY>`. `GET /` returns a small info response without auth.

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
| `get_analytics` | `GET /analytics` | `days` from 7 to 365. |

## Development

```bash
npm install
npm run build
npm test
```

Written against Wardrowbe 1.13.x. If Wardrowbe changes its endpoints, update `src/tools.ts`.
