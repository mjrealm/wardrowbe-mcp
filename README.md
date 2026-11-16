# wardrowbe-mcp

An [MCP](https://modelcontextprotocol.io) server for [Wardrowbe](https://github.com/Anyesh/wardrowbe), the self-hosted wardrobe app. It exposes wardrobe tools (list and inspect items, log wear and washes, suggest outfits, accept or reject outfits, analytics) to any MCP client.

It runs over two transports:

- **stdio** (default): for `npx`, Claude Desktop, and MCP proxies that spawn a child process.
- **Streamable HTTP**: for clients and gateways that connect to a URL, such as MCPHub.

## Requirements

- Node.js 20 or newer.
- A running Wardrowbe instance and credentials for it (see [Authentication](#authentication)).

## Quick start

```bash
WARDROWBE_URL=https://wardrowbe.example.com \
WARDROWBE_TOKEN=<access-token> \
npx -y wardrowbe-mcp
```

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `WARDROWBE_URL` | yes | | Base URL of your Wardrowbe instance. |
| `WARDROWBE_TOKEN` | one of these | | A Wardrowbe access token (JWT). |
| `OIDC_ISSUER_URL` | one of these | | OIDC issuer, e.g. `https://pocket.example.com`. |
| `OIDC_CLIENT_ID` | with OIDC | | OIDC client ID. |
| `OIDC_CLIENT_SECRET` | no | | Only for confidential clients. |
| `OIDC_REFRESH_TOKEN` | with OIDC | | Refresh token from a one-time sign-in. |
| `MCP_TRANSPORT` | no | `stdio` | `stdio` or `http`. |
| `MCP_BIND_HOST` | no | `127.0.0.1` | Address for the HTTP transport. Use `0.0.0.0` in containers. |
| `MCP_PORT` | no | `8080` | Port for the HTTP transport. |
| `MCP_API_KEY` | http only | | Bearer key that clients must send to `/mcp`. |

## Authentication

Wardrowbe signs its own access tokens. There are two ways to provide one:

1. **Static token.** Set `WARDROWBE_TOKEN`. It expires, so this suits short-lived use.
2. **OIDC refresh token (recommended).** Set the `OIDC_*` variables. On each call, the server exchanges the refresh token for an ID token, trades that at `POST /api/v1/auth/sync` for a Wardrowbe access token, and caches it until shortly before it expires. If the issuer rotates refresh tokens, the server keeps the newest one in memory only. Your IdP client needs `offline_access`, or the issuer won't return a refresh token.

Get the initial refresh token with a normal OIDC sign-in in a browser, for example with a PKCE helper script. The server itself can't open a browser.

## Use with npx (stdio)

Claude Desktop or Claude Code:

```json
{
  "mcpServers": {
    "wardrowbe": {
      "command": "npx",
      "args": ["-y", "wardrowbe-mcp"],
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

## Use over HTTP (MCPHub or any URL-based client)

Run the server:

```bash
MCP_TRANSPORT=http \
MCP_BIND_HOST=0.0.0.0 \
MCP_API_KEY="$(openssl rand -hex 32)" \
WARDROWBE_URL=https://wardrowbe.example.com \
OIDC_ISSUER_URL=https://pocket.example.com \
OIDC_CLIENT_ID=wardrowbe \
OIDC_REFRESH_TOKEN=<refresh-token> \
npx -y wardrowbe-mcp
```

Then register it as a remote server:

- **URL:** `http://<host>:8080/mcp`
- **Header:** `Authorization: Bearer <MCP_API_KEY>`

`GET /` returns a small JSON info response without auth. Every other route needs the Bearer key.

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

Tool errors come back as MCP tool errors with the Wardrowbe error message, so the model can read them and retry.

## Development

```bash
npm install
npm run build
npm test
```

## Compatibility

Written against the Wardrowbe backend at version 1.13.x. The endpoints above come from its FastAPI routes. If Wardrowbe changes them, update `src/tools.ts`.
