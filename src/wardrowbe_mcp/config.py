"""Settings read from environment variables."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class Oidc:
    issuer_url: str
    client_id: str
    client_secret: str | None = None
    # Seeds the first run. After that the saved token is used first.
    refresh_token: str | None = None


@dataclass(frozen=True)
class Config:
    wardrowbe_url: str
    api_key: str
    static_token: str | None
    oidc: Oidc | None
    token_file: Path | None
    host: str
    port: int
    # Public https URL of this server. Setting it turns on OAuth sign-in for MCP clients.
    public_url: str | None = None
    state_file: Path | None = None


def default_token_file(env: Mapping[str, str]) -> Path:
    base = (env.get("XDG_CONFIG_HOME") or "").strip()
    root = Path(base) if base else Path.home() / ".config"
    return root / "wardrowbe-mcp" / "refresh-token.json"


def load_config(env: Mapping[str, str] | None = None) -> Config:
    env = os.environ if env is None else env

    def get(name: str) -> str | None:
        value = (env.get(name) or "").strip()
        return value or None

    url = (get("WARDROWBE_URL") or "").rstrip("/")
    if not url:
        raise ConfigError("WARDROWBE_URL is required (e.g. https://wardrowbe.example.com)")
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ConfigError(f"WARDROWBE_URL is not a valid URL: {url}")

    api_key = get("MCP_API_KEY")
    if not api_key:
        raise ConfigError("MCP_API_KEY is required. Clients send it as a Bearer token.")

    static_token = get("WARDROWBE_TOKEN")
    issuer, client_id, refresh = get("OIDC_ISSUER_URL"), get("OIDC_CLIENT_ID"), get("OIDC_REFRESH_TOKEN")
    oidc: Oidc | None = None
    token_file: Path | None = None
    if issuer or client_id or refresh:
        if not issuer or not client_id:
            raise ConfigError("OIDC needs OIDC_ISSUER_URL and OIDC_CLIENT_ID")
        oidc = Oidc(issuer.rstrip("/"), client_id, get("OIDC_CLIENT_SECRET"), refresh)
        token_file = Path(get("WARDROWBE_TOKEN_FILE") or default_token_file(env))

    if not static_token and not oidc:
        raise ConfigError(
            "Set WARDROWBE_TOKEN, or OIDC_ISSUER_URL and OIDC_CLIENT_ID to sign in with your identity provider"
        )

    port_text = get("MCP_PORT") or "8080"
    try:
        port = int(port_text)
    except ValueError:
        port = 0
    if not 1 <= port <= 65535:
        raise ConfigError(f'MCP_PORT must be a port number, got "{port_text}"')

    public_url = (get("PUBLIC_URL") or "").rstrip("/") or None
    state_file: Path | None = None
    if public_url:
        parsed_public = urlparse(public_url)
        if parsed_public.scheme not in ("http", "https") or not parsed_public.netloc:
            raise ConfigError(f"PUBLIC_URL is not a valid URL: {public_url}")
        if not oidc:
            raise ConfigError("PUBLIC_URL turns on OAuth sign-in, which needs OIDC_ISSUER_URL and OIDC_CLIENT_ID")
        state_file = Path(get("WARDROWBE_STATE_FILE") or default_token_file(env).with_name("oauth-state.json"))

    # Containers need 0.0.0.0 to be reachable, so that is the default for this server.
    return Config(
        url, api_key, static_token, oidc, token_file, get("MCP_BIND_HOST") or "0.0.0.0", port, public_url, state_file
    )
