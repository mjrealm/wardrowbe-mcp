# wardrowbe-mcp

An [MCP](https://modelcontextprotocol.io) server for [Wardrowbe](https://github.com/Anyesh/wardrowbe), the self-hosted wardrobe app. It exposes wardrobe tools (list and inspect items, log wear and washes, suggest outfits, accept or reject outfits, analytics) to any MCP client.

It runs over two transports:

- **stdio** (default): for `npx`, Claude Desktop, and MCP proxies that spawn a child process.
- **Streamable HTTP**: for clients and gateways that connect to a URL, such as MCPHub.

## Requirements

- Node.js 20 or newer.
- A running Wardrowbe instance and credentials for it (see [Authentication](#authentication)).

## Getting started

You need three things: your Wardrowbe URL, an OIDC client that can sign you in (Pocket ID works), and a refresh token for that client.

1. **Find your Wardrowbe URL.** This is where you open the web app, e.g. `https://wardrowbe.example.com`.
2. **Set up the OIDC client.** In your IdP, create a client for Wardrowbe. Allow the `openid profile email offline_access` scopes, and register a redirect URI for your sign-in helper (for example `http://localhost:8765/callback`).
3. **Get a refresh token.** Sign in once through the IdP and keep the `refresh_token` from the token response. The server does not open a browser, so this step happens outside it. See [Getting a refresh token](#getting-a-refresh-token) for the steps.
4. **Check it works.** Run the server with the settings below. In an MCP client, call `list_items`. If you get your wardrobe back, it's set up.

```bash
WARDROWBE_URL=https://wardrowbe.example.com \
OIDC_ISSUER_URL=https://pocket.example.com \
OIDC_CLIENT_ID=wardrowbe \
OIDC_REFRESH_TOKEN=<refresh-token> \
npx -y wardrowbe-mcp
```

Over stdio, the process waits for an MCP client to connect, so running it from a terminal shows nothing until a client attaches. Use one of the sections below to connect a client.

If you only have a Wardrowbe access token already, set `WARDROWBE_TOKEN` instead of the `OIDC_*` variables. It expires, so the OIDC route is better for regular use.

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

## Getting a refresh token

You do this once per setup. Repeat it only if the refresh token is revoked, expires, or stops refreshing. The server then uses the token to get Wardrowbe access tokens on its own.

The easiest way is the `login` command:

```bash
npx -y wardrowbe-mcp login --issuer https://pocket.example.com --client-id wardrowbe > refresh-token.txt
```

It opens your browser at the issuer's sign-in page with PKCE and the `offline_access` scope. It catches the redirect on `http://localhost:8765/callback`, exchanges the code, and writes the refresh token to stdout. Status messages go to stderr, so the redirect only captures the token. Use `--port` to change the port, and `--client-secret` for a confidential client. The redirect URI you registered must match the port. Delete `refresh-token.txt` after you copy the token into MCPHub.

The manual steps below do the same thing by hand.

**Before you start:** create an OIDC client in your identity provider for Wardrowbe. Use a public client with PKCE (no secret needed), allow the scopes `openid profile email offline_access`, and register a redirect URI such as `http://localhost:8765/callback`. Write down the client ID.

**1. Create a PKCE verifier and challenge** (macOS or Linux shell):

```bash
VERIFIER=$(openssl rand -base64 48 | tr -d '=+/' | cut -c1-64)
CHALLENGE=$(printf %s "$VERIFIER" | openssl dgst -sha256 -binary | openssl base64 -A | tr '+/' '-_' | tr -d '=')
echo "$VERIFIER"   # keep this, you need it in step 3
```

**2. Open the authorize URL in your browser** and sign in as yourself. Replace the placeholders, and URL-encode the redirect URI if your shell requires it:

```
https://<issuer>/authorize?response_type=code&client_id=<client-id>&redirect_uri=http://localhost:8765/callback&scope=openid%20profile%20email%20offline_access&code_challenge=<CHALLENGE>&code_challenge_method=S256&state=xyz
```

Nothing needs to listen on `localhost:8765`. After you sign in, the browser lands on an error page, and the address bar contains `?code=...`. Copy that `code` value.

**3. Exchange the code for tokens:**

```bash
curl -s -X POST https://<issuer>/api/oidc/token \
  -d grant_type=authorization_code \
  -d client_id=<client-id> \
  -d code=<code-from-step-2> \
  -d redirect_uri=http://localhost:8765/callback \
  -d code_verifier="$VERIFIER"
```

The JSON response includes `refresh_token`. Keep it, and treat it like a password. If the response has no `refresh_token`, check that the client allows `offline_access`.

For Pocket ID, `<issuer>` is your Pocket ID base URL, such as `pocket.example.com`. Its token endpoint path is `/api/oidc/token`. Other providers use different paths, so check their discovery document at `/.well-known/openid-configuration`.

Store the refresh token and client ID as secrets in the MCP client's environment settings. Don't commit them.

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
