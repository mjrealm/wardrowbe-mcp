"""OAuth for MCP clients, delegated to your OIDC provider.

The MCP client talks OAuth to this server (discovery, dynamic registration, /authorize, /token).
This server in turn sends the user to the identity provider (Pocket ID) to sign in, keeps that
user's refresh token, and hands the MCP client its own tokens. No manual refresh token is needed.

    MCP client --> /authorize --> identity provider --> /oauth/callback --> MCP client redirect_uri
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
import secrets
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx
from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    RefreshToken,
    TokenError,
    construct_redirect_uri,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse, Response
from starlette.routing import Route

from .config import Oidc

log = logging.getLogger("wardrowbe_mcp")

UPSTREAM_SCOPES = "openid profile email offline_access"
ACCESS_TOKEN_TTL = 3600
REFRESH_TOKEN_TTL = 30 * 24 * 3600
AUTH_CODE_TTL = 300
LOGIN_TTL = 600
# Caps how many sign-ins can be pending at once, so unauthenticated /authorize calls cannot fill memory.
MAX_PENDING_LOGINS = 200


class SessionStore:
    """What survives a restart: registered clients, each user's identity-provider refresh token, and
    the refresh tokens given to MCP clients. Kept in one JSON file readable only by the current user."""

    def __init__(self, path: Path | None) -> None:
        self.path = path
        self.data: dict[str, dict[str, Any]] = {"clients": {}, "sessions": {}, "refresh": {}}
        if path:
            try:
                loaded = json.loads(path.read_text("utf-8"))
                for key in self.data:
                    if isinstance(loaded.get(key), dict):
                        self.data[key] = loaded[key]
            except (FileNotFoundError, ValueError, OSError):
                pass

    def save(self) -> None:
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            tmp = self.path.with_name(self.path.name + ".tmp")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(self.data, f, indent=2)
            os.replace(tmp, self.path)
        except OSError as err:
            log.error("could not save sign-in state to %s: %s", self.path, err)

    # The TokenStore interface, scoped to one user, so the TokenProvider keeps rotated tokens here.
    def for_subject(self, subject: str) -> "SubjectTokens":
        return SubjectTokens(self, subject)


class SubjectTokens:
    def __init__(self, store: SessionStore, subject: str) -> None:
        self._store = store
        self._subject = subject
        self.path = store.path

    def load(self, issuer_url: str, client_id: str) -> str | None:
        entry = self._store.data["sessions"].get(self._subject)
        if not entry or entry.get("issuerUrl") != issuer_url or entry.get("clientId") != client_id:
            return None
        return entry.get("refreshToken") or None

    def save(self, issuer_url: str, client_id: str, refresh_token: str) -> None:
        self._store.data["sessions"][self._subject] = {
            "issuerUrl": issuer_url, "clientId": client_id, "refreshToken": refresh_token,
        }
        self._store.save()


class _Login:
    def __init__(self, client: OAuthClientInformationFull, params: AuthorizationParams, verifier: str) -> None:
        self.client = client
        self.params = params
        self.verifier = verifier
        self.expires_at = time.time() + LOGIN_TTL


class UpstreamOAuthProvider:
    """Implements the MCP SDK's OAuth server provider on top of an OIDC identity provider."""

    def __init__(
        self,
        oidc: Oidc,
        public_url: str,
        api_key: str,
        http: httpx.AsyncClient,
        store: SessionStore,
        now: Any = time.time,
    ) -> None:
        self._oidc = oidc
        self._public_url = public_url.rstrip("/")
        self._api_key = api_key
        self._http = http
        self._store = store
        self._now = now
        self._logins: dict[str, _Login] = {}
        self._codes: dict[str, AuthorizationCode] = {}
        self._access: dict[str, AccessToken] = {}

    @property
    def callback_url(self) -> str:
        return f"{self._public_url}/oauth/callback"

    # ---- clients ---------------------------------------------------------------------------------

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        raw = self._store.data["clients"].get(client_id)
        return OAuthClientInformationFull.model_validate(raw) if raw else None

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        if not client_info.client_id:
            raise ValueError("client_id is required")
        self._store.data["clients"][client_info.client_id] = client_info.model_dump(mode="json")
        self._store.save()

    # ---- step 1: send the user to the identity provider --------------------------------------------

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        self._sweep()
        if len(self._logins) >= MAX_PENDING_LOGINS:
            raise TokenError(error="temporarily_unavailable", error_description="Too many sign-ins are pending")
        endpoint = (await self._discover())["authorization_endpoint"]
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        state = secrets.token_urlsafe(32)
        self._logins[state] = _Login(client, params, verifier)
        query = urlencode(
            {
                "response_type": "code",
                "client_id": self._oidc.client_id,
                "redirect_uri": self.callback_url,
                "scope": UPSTREAM_SCOPES,
                "state": state,
                "code_challenge": challenge,
                "code_challenge_method": "S256",
            }
        )
        return f"{endpoint}?{query}"

    # ---- step 2: the identity provider sends the user back here ------------------------------------

    def callback_route(self) -> Route:
        return Route("/oauth/callback", self._callback, methods=["GET"])

    async def _callback(self, request: Request) -> Response:
        state = request.query_params.get("state", "")
        login = self._logins.pop(state, None)
        if login is None or login.expires_at < self._now():
            return _error_page("This sign-in link has expired or was already used. Start the connection again.")
        params = login.params

        def back(**query: str) -> Response:
            return RedirectResponse(
                construct_redirect_uri(str(params.redirect_uri), state=params.state, **query), status_code=302
            )

        if request.query_params.get("error"):
            return back(error="access_denied", error_description="Sign-in was cancelled or refused")
        code = request.query_params.get("code")
        if not code:
            return back(error="invalid_request", error_description="No code from the identity provider")
        try:
            tokens = await self._exchange_upstream_code(code, login.verifier)
        except httpx.HTTPError as err:
            log.error("identity provider token request failed: %s", err)
            return back(error="server_error", error_description="Could not reach the identity provider")
        id_token = tokens.get("id_token")
        refresh = tokens.get("refresh_token")
        subject = _subject(id_token) if isinstance(id_token, str) else None
        if not subject or not refresh:
            return _error_page(
                "The identity provider returned no refresh token or no user id. Enable the offline_access "
                "scope on the OIDC client and try again."
            )

        self._store.data["sessions"][subject] = {
            "issuerUrl": self._oidc.issuer_url, "clientId": self._oidc.client_id, "refreshToken": refresh,
        }
        self._store.save()

        own_code = secrets.token_urlsafe(32)
        self._codes[own_code] = AuthorizationCode(
            code=own_code,
            scopes=params.scopes or [],
            expires_at=self._now() + AUTH_CODE_TTL,
            client_id=login.client.client_id or "",
            code_challenge=params.code_challenge,
            redirect_uri=params.redirect_uri,
            redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
            resource=params.resource,
            subject=subject,
        )
        return back(code=own_code)

    async def _exchange_upstream_code(self, code: str, verifier: str) -> dict[str, Any]:
        endpoint = (await self._discover())["token_endpoint"]
        form = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.callback_url,
            "client_id": self._oidc.client_id,
            "code_verifier": verifier,
        }
        if self._oidc.client_secret:
            form["client_secret"] = self._oidc.client_secret
        response = await self._http.post(endpoint, data=form)
        try:
            body = response.json()
        except ValueError:
            body = None
        return body if response.is_success and isinstance(body, dict) else {}

    async def _discover(self) -> dict[str, Any]:
        response = await self._http.get(f"{self._oidc.issuer_url}/.well-known/openid-configuration")
        meta = response.json() if response.is_success else {}
        if not meta.get("authorization_endpoint") or not meta.get("token_endpoint"):
            raise TokenError(error="server_error", error_description="OIDC discovery failed")
        return meta

    # ---- step 3: the MCP client trades our code for our tokens -----------------------------------

    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> AuthorizationCode | None:
        self._sweep()
        code = self._codes.get(authorization_code)
        return code if code and code.client_id == client.client_id else None

    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode
    ) -> OAuthToken:
        self._codes.pop(authorization_code.code, None)  # Each code works once.
        return self._issue(
            client.client_id or "", authorization_code.scopes, authorization_code.resource,
            authorization_code.subject,
        )

    async def load_refresh_token(self, client: OAuthClientInformationFull, refresh_token: str) -> RefreshToken | None:
        entry = self._store.data["refresh"].get(refresh_token)
        if not entry or entry["client_id"] != client.client_id or entry["expires_at"] < self._now():
            return None
        return RefreshToken(
            token=refresh_token, client_id=entry["client_id"], scopes=entry["scopes"],
            expires_at=int(entry["expires_at"]), resource=entry.get("resource"), subject=entry["subject"],
        )

    async def exchange_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: RefreshToken, scopes: list[str]
    ) -> OAuthToken:
        self._store.data["refresh"].pop(refresh_token.token, None)  # Rotate: the old one dies.
        return self._issue(
            client.client_id or "", scopes or refresh_token.scopes, refresh_token.resource, refresh_token.subject
        )

    def _issue(self, client_id: str, scopes: list[str], resource: str | None, subject: str | None) -> OAuthToken:
        now = self._now()
        access = secrets.token_urlsafe(32)
        refresh = secrets.token_urlsafe(32)
        self._access[access] = AccessToken(
            token=access, client_id=client_id, scopes=scopes, expires_at=int(now + ACCESS_TOKEN_TTL),
            resource=resource, subject=subject,
        )
        self._store.data["refresh"][refresh] = {
            "client_id": client_id, "scopes": scopes, "resource": resource, "subject": subject,
            "expires_at": now + REFRESH_TOKEN_TTL, "access": access,
        }
        self._store.save()
        return OAuthToken(
            access_token=access, token_type="Bearer", expires_in=ACCESS_TOKEN_TTL,
            scope=" ".join(scopes) or None, refresh_token=refresh,
        )

    # ---- using the tokens ------------------------------------------------------------------------

    async def load_access_token(self, token: str) -> AccessToken | None:
        """Accepts an OAuth access token, or the static MCP_API_KEY (which acts as the default user)."""
        self._sweep()
        found = self._access.get(token)
        if found:
            return found
        if secrets.compare_digest(token.encode(), self._api_key.encode()):
            return AccessToken(token=token, client_id="api-key", scopes=[], expires_at=None, subject=None)
        return None

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        self._access.pop(token.token, None)
        removed = self._store.data["refresh"].pop(token.token, None)
        if removed:
            self._access.pop(removed.get("access", ""), None)
        else:  # An access token: drop its refresh token too.
            for key, entry in list(self._store.data["refresh"].items()):
                if entry.get("access") == token.token:
                    del self._store.data["refresh"][key]
        self._store.save()

    def _sweep(self) -> None:
        now = self._now()
        for key in [k for k, v in self._logins.items() if v.expires_at < now]:
            del self._logins[key]
        for key in [k for k, v in self._codes.items() if v.expires_at < now]:
            del self._codes[key]
        for key in [k for k, v in self._access.items() if v.expires_at and v.expires_at < now]:
            del self._access[key]


def _subject(id_token: str) -> str | None:
    try:
        payload = id_token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        sub = json.loads(base64.urlsafe_b64decode(payload)).get("sub")
        return sub if isinstance(sub, str) and sub else None
    except (IndexError, ValueError):
        return None


def _error_page(message: str) -> Response:
    from html import escape

    return HTMLResponse(f"<!doctype html><title>Sign-in failed</title><p>{escape(message)}</p>", status_code=400)
