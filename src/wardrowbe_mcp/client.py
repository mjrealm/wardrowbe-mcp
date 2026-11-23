"""Wardrowbe API client and the OIDC token provider behind it."""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import time
from collections.abc import Awaitable, Callable
from typing import Any, Protocol

import httpx
from mcp.server.mcpserver.exceptions import ToolError

from .config import Config, Oidc

log = logging.getLogger("wardrowbe_mcp")

# Refresh this long before the access token expires, so a call never starts with a dead token.
EXPIRY_MARGIN = 60.0
# Used when an access token has no exp claim.
FALLBACK_TTL = 300.0
# Every outbound request is bounded, so a tool call can fail but never hang.
REQUEST_TIMEOUT = httpx.Timeout(30.0, connect=10.0)


class RefreshTokenStore(Protocol):
    path: Any

    def load(self, issuer_url: str, client_id: str) -> str | None: ...

    def save(self, issuer_url: str, client_id: str, refresh_token: str) -> None: ...


class WardrowbeError(ToolError):
    """An error with a message that is safe to show to the model."""


def _jwt_claims(token: str) -> dict[str, Any]:
    """Reads a JWT payload without checking the signature. Only for expiry and identity hints."""
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload))
        return claims if isinstance(claims, dict) else {}
    except (IndexError, ValueError):
        return {}


def _describe(response: httpx.Response) -> str:
    try:
        detail = response.json().get("detail")
    except (ValueError, AttributeError):
        detail = None
    if isinstance(detail, str):
        return detail
    if detail is not None:
        return json.dumps(detail)[:300]
    return response.reason_phrase or "request failed"


class TokenProvider:
    """Gives out a Wardrowbe access token, refreshing it through the identity provider when needed."""

    def __init__(
        self,
        config: Config,
        http: httpx.AsyncClient,
        store: RefreshTokenStore | None = None,
        now: Callable[[], float] = time.time,
    ) -> None:
        self._config = config
        self._http = http
        self._store = store
        self._now = now
        self._access_token: str | None = None
        self._expires_at = 0.0
        self._refresh_token: str | None = None
        self._lock = asyncio.Lock()

    async def get_token(self) -> str:
        if self._config.static_token:
            return self._config.static_token
        if self._access_token and self._now() < self._expires_at - EXPIRY_MARGIN:
            return self._access_token
        # One exchange at a time, so concurrent tool calls don't each refresh the token.
        async with self._lock:
            if self._access_token and self._now() < self._expires_at - EXPIRY_MARGIN:
                return self._access_token
            return await self._exchange()

    async def _exchange(self) -> str:
        oidc = self._config.oidc
        assert oidc is not None
        id_token = await self._refresh_id_token(oidc)
        claims = _jwt_claims(id_token)
        subject = claims.get("sub")
        # Wardrowbe's /auth/sync requires external_id and display_name next to the id token.
        if not isinstance(subject, str) or not subject:
            raise WardrowbeError("The ID token has no sub claim, so Wardrowbe cannot identify the user.")
        email = claims.get("email") if isinstance(claims.get("email"), str) else None
        candidates = [claims.get("name"), claims.get("preferred_username"), email.split("@")[0] if email else None]
        display_name = next((c for c in candidates if isinstance(c, str) and c.strip()), "User")

        response = await self._http.post(
            f"{self._config.wardrowbe_url}/api/v1/auth/sync",
            json={"id_token": id_token, "external_id": subject, "email": email, "display_name": display_name},
        )
        body = _safe_json(response)
        if not response.is_success or not isinstance(body, dict) or not body.get("access_token"):
            raise WardrowbeError(f"Wardrowbe API {response.status_code}: auth/sync failed: {_describe(response)}")

        self._access_token = body["access_token"]
        exp = _jwt_claims(self._access_token).get("exp")
        ttl = float(exp) - self._now() if isinstance(exp, (int, float)) else FALLBACK_TTL
        self._expires_at = self._now() + (ttl if ttl > 0 else FALLBACK_TTL)
        return self._access_token

    async def _refresh_id_token(self, oidc: Oidc) -> str:
        discovery = await self._http.get(f"{oidc.issuer_url}/.well-known/openid-configuration")
        meta = _safe_json(discovery)
        endpoint = meta.get("token_endpoint") if isinstance(meta, dict) else None
        if not discovery.is_success or not endpoint:
            raise WardrowbeError(f"OIDC discovery failed at {oidc.issuer_url} (HTTP {discovery.status_code})")

        # Newest known token first, then the one from the config. A provider that rotates refresh
        # tokens kills the config's token after its first use, so it only seeds the first run.
        newest = self._refresh_token or (self._store.load(oidc.issuer_url, oidc.client_id) if self._store else None)
        candidates = list(dict.fromkeys(t for t in (newest, oidc.refresh_token) if t))
        if not candidates:
            raise WardrowbeError(
                "No refresh token is available. Set OIDC_REFRESH_TOKEN, "
                "or run `wardrowbe-mcp login` and use the token it prints."
            )

        status = 0
        for candidate in candidates:
            result = await self._refresh(endpoint, oidc, candidate)
            if isinstance(result, str):
                self._refresh_token = self._refresh_token or candidate
                return result
            status = result
            # Server errors are not a sign of a bad token, so they are reported as they are.
            if status not in (400, 401):
                break
        raise WardrowbeError(
            f"OIDC refresh failed (HTTP {status}). The refresh token may be expired or revoked. "
            "Get a new one with `wardrowbe-mcp login` and update OIDC_REFRESH_TOKEN."
        )

    async def _refresh(self, endpoint: str, oidc: Oidc, refresh_token: str) -> str | int:
        """Returns the id token, or the HTTP status when the provider refused."""
        form = {"grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": oidc.client_id}
        if oidc.client_secret:
            form["client_secret"] = oidc.client_secret
        response = await self._http.post(endpoint, data=form)
        tokens = _safe_json(response)
        if not response.is_success or not isinstance(tokens, dict) or not tokens.get("id_token"):
            return response.status_code
        # Some providers rotate refresh tokens. Keep the newest one so the next run can use it.
        if tokens.get("refresh_token"):
            self._remember(oidc, tokens["refresh_token"])
        return tokens["id_token"]

    def _remember(self, oidc: Oidc, refresh_token: str) -> None:
        self._refresh_token = refresh_token
        if not self._store:
            return
        try:
            self._store.save(oidc.issuer_url, oidc.client_id, refresh_token)
        except OSError as err:
            log.error("could not save the refresh token to %s: %s", self._store.path, err)


def _safe_json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except ValueError:
        return None


class WardrowbeClient:
    """Thin JSON client for the Wardrowbe REST API."""

    def __init__(
        self, config: Config, get_token: Callable[[], Awaitable[str]], http: httpx.AsyncClient
    ) -> None:
        self._base = f"{config.wardrowbe_url}/api/v1"
        self._get_token = get_token
        self._http = http

    async def get(self, path: str, **query: Any) -> Any:
        return await self._request("GET", path, params={k: _q(v) for k, v in query.items() if v is not None})

    async def post(self, path: str, body: Any = None) -> Any:
        return await self._request("POST", path, json=body)

    async def post_form(self, path: str, data: dict[str, str], files: dict[str, tuple[str, bytes, str]]) -> Any:
        """Sends a multipart form, such as an item with its photo."""
        return await self._request("POST", path, data=data, files=files)

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            token = await self._get_token()
            response = await self._http.request(
                method, f"{self._base}{path}", headers={"Authorization": f"Bearer {token}"}, **kwargs
            )
        except httpx.TimeoutException as err:
            raise WardrowbeError(f"Timed out talking to Wardrowbe or the identity provider ({type(err).__name__}).") from err
        except httpx.HTTPError as err:
            raise WardrowbeError(f"Could not reach Wardrowbe or the identity provider ({type(err).__name__}).") from err
        if not response.is_success:
            raise WardrowbeError(f"Wardrowbe API {response.status_code}: {_describe(response)}")
        return _safe_json(response)


def _q(value: Any) -> str:
    return str(value).lower() if isinstance(value, bool) else str(value)
