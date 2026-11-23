# wardrowbe-mcp

An HTTP [MCP](https://modelcontextprotocol.io) server for [Wardrowbe](https://github.com/Anyesh/wardrowbe), meant to run as a pod next to it. It serves two things on one port, both behind one Bearer key:

- `/mcp`: the MCP endpoint (Streamable HTTP, stateless). Register it in MCPHub or any client that connects to a URL.
- `POST /uploads/<ticket>`: photo upload. The `get_upload_url` tool hands out the one-time ticket. Send raw image bytes, then call `add_item`. The photo never passes through the model. `POST /uploads` takes the Bearer key instead.

HTTP only. There is no stdio mode.

## TL;DR

You need an OIDC client (Pocket ID works) with the `offline_access` scope and this redirect URI: `<PUBLIC_URL>/oauth/callback`. `PUBLIC_URL` is the https address MCP clients use to reach this server.

```bash
docker run -p 8080:8080 -v wardrowbe-mcp:/data \
  -e PUBLIC_URL=https://wardrowbe-mcp.example.com \
  -e MCP_API_KEY="$(openssl rand -hex 32)" \
  -e WARDROWBE_URL=https://wardrowbe.example.com \
  -e OIDC_ISSUER_URL=https://pocket.example.com \
  -e OIDC_CLIENT_ID=wardrowbe \
  ghcr.io/mjrealm/wardrowbe-mcp:latest
```

Add `https://wardrowbe-mcp.example.com/mcp` as a server in your MCP client (MCPHub, Claude, and so on). The client starts a sign-in, you log in with Pocket ID once, and that is it. There is no refresh token to fetch or paste.

Confidential OIDC client? Also set `OIDC_CLIENT_SECRET`.

## Image

Images are published to GitHub Container Registry by [.github/workflows/release.yml](.github/workflows/release.yml), after the tests pass. The image is multi-arch (amd64, arm64).

| Tag | When | Use it for |
| --- | --- | --- |
| `ghcr.io/mjrealm/wardrowbe-mcp:1.2.3` | git tag `v1.2.3` | Pinned, repeatable deploys. |
| `...:1.2` | git tag `v1.2.x` | Patch updates only. |
| `...:1` | git tag `v1.x.y` (from 1.0.0) | Minor and patch updates. |
| `...:latest` | every push to `main` | The newest build, which may be unreleased. |
| `...:sha-<short>` | every push to `main` | One exact commit. |

Versions follow [semantic versioning](https://semver.org). To release, bump `version` in `pyproject.toml`, then tag it:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The workflow fails if the tag and `pyproject.toml` disagree.

The package is private until you make it public in its GitHub package settings. A private image needs a pull secret where you run it. To build locally instead: `docker build -t wardrowbe-mcp .`.

## How sign-in works

With `PUBLIC_URL` set, this server is an OAuth server for MCP clients and signs users in through your identity provider:

1. The MCP client finds the server's OAuth endpoints, registers itself, and opens `/authorize`.
2. The server sends you to Pocket ID. You sign in there.
3. Pocket ID sends you back to `/oauth/callback`. The server keeps your refresh token and gives the client its own tokens.
4. Tool calls run as you. Access tokens last an hour. Clients refresh them on their own, and the refresh token rotates.

Each user has their own session, kept in `/data/oauth-state.json`. After a restart the client's refresh token still works, so nobody signs in again.

**Without `PUBLIC_URL`** the server skips OAuth. Clients send `MCP_API_KEY` as a Bearer token, and calls run as one fixed user, from `WARDROWBE_TOKEN` or `OIDC_REFRESH_TOKEN` (get one with `wardrowbe-mcp login`, see below). That mode also works with OAuth on: a request that carries `MCP_API_KEY` runs as that default user.

## Getting a refresh token

`wardrowbe-mcp login` runs the OIDC sign-in (authorization code with PKCE) in your browser and prints the refresh token. It also saves it to `WARDROWBE_TOKEN_FILE`.

```bash
OIDC_ISSUER_URL=https://pocket.example.com OIDC_CLIENT_ID=wardrowbe wardrowbe-mcp login
```

Allow `http://127.0.0.1:8765/callback` as a redirect URI on the OIDC client (change the port with `LOGIN_PORT`). Put the printed token in `OIDC_REFRESH_TOKEN` on the server. This is only needed without `PUBLIC_URL`; with it, clients sign in through the server.

## Adding items from photos

The agent uploads the photo from its own filesystem, with no key of its own:

1. The agent calls the `get_upload_url` tool (through MCPHub, so it is already signed in). It gets a one-time URL, `<PUBLIC_URL>/uploads/<ticket>`.
2. It sends the raw image bytes to that URL, which needs no other credential:

   ```bash
   curl -s -X POST "<upload_url>" -H "Content-Type: image/jpeg" -H "X-Filename: blue-shirt.jpg" --data-binary @blue-shirt.jpg
   # {"upload_id": "...", "expires_in_seconds": 600}
   ```

3. It calls `add_item` with the `upload_id`.

A URL works once and expires after 10 minutes. A rejected photo (wrong type, too large) does not use it up. Types: jpeg, png, webp, heic, heif. Up to 15 MB.

`POST /uploads` with `Authorization: Bearer <MCP_API_KEY>` (or an OAuth access token) still works, for scripts that hold the key.

## Configuration

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `WARDROWBE_URL` | yes | | Base URL of your Wardrowbe instance. |
| `PUBLIC_URL` | for OAuth | | Public https URL of this server. Turns on OAuth sign-in. Needs OIDC settings. |
| `MCP_API_KEY` | yes | | Bearer key for `POST /uploads`, and for `/mcp` without OAuth. Agents don't need it for uploads. |
| `OIDC_ISSUER_URL` | or token | | OIDC issuer. |
| `OIDC_CLIENT_ID` | with OIDC | | OIDC client ID. |
| `OIDC_CLIENT_SECRET` | no | | Only for confidential clients. |
| `OIDC_REFRESH_TOKEN` | no | | Only for the default user (no OAuth). Seeds the first run. After that the saved token is used first. |
| `WARDROWBE_TOKEN` | or OIDC | | A Wardrowbe access token (JWT). It expires, so OIDC is better. |
| `WARDROWBE_TOKEN_FILE` | no | `~/.config/wardrowbe-mcp/refresh-token.json` | Where the rotated refresh token is saved. The image sets `/data/refresh-token.json`. |
| `WARDROWBE_STATE_FILE` | no | `~/.config/wardrowbe-mcp/oauth-state.json` | OAuth clients, user sessions and refresh tokens. The image sets `/data/oauth-state.json`. |
| `MCP_BIND_HOST` | no | `0.0.0.0` | Address to listen on. |
| `MCP_PORT` | no | `8080` | Port. |

## Operating notes

- **Keep `/data` on a volume.** It holds the OAuth state and the rotated refresh tokens. Without it, every restart signs everyone out.
- **`PUBLIC_URL` must be https** for real clients, and `<PUBLIC_URL>/oauth/callback` must be a redirect URI on the OIDC client.
- **Run one replica.** Pending uploads are held in memory, so an upload and its `add_item` call must reach the same pod.
- **Put it behind TLS.** Access tokens and the API key travel as Bearer tokens.
- Dynamic client registration is open, as OAuth for MCP expects. Registering a client gives no access: a user still has to sign in with your identity provider.
- The ID token comes straight from the provider's token endpoint over TLS, so the server reads its `sub` without checking the signature.
- Every request to the identity provider and Wardrowbe has a timeout (30 s), so a tool call fails with a message instead of hanging.
- `GET /` and `GET /healthz` need no key.

## Development

```bash
python -m venv .venv && .venv/bin/pip install -e ".[dev]"
.venv/bin/pytest
```

Requires Python 3.11 or newer and `mcp` 2.x. Dependencies are listed in `pyproject.toml`, so there is no `requirements.txt`.
