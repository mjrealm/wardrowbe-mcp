import base64
import json
from collections.abc import Callable
from pathlib import Path

import httpx

from wardrowbe_mcp.config import Config, Oidc

ISSUER = "https://idp.test"
WARDROWBE = "https://w.test"
KEY = "test-key"


def jwt(claims: dict) -> str:
    def enc(obj: dict) -> str:
        return base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()

    return f"{enc({'alg': 'none'})}.{enc(claims)}.sig"


def make_config(tmp: Path, *, refresh: str | None = "env-rt", public_url: str | None = None, secret: str | None = None) -> Config:
    return Config(
        wardrowbe_url=WARDROWBE,
        api_key=KEY,
        static_token=None,
        oidc=Oidc(ISSUER, "wardrowbe", secret, refresh),
        token_file=tmp / "refresh-token.json",
        host="127.0.0.1",
        port=8080,
        public_url=public_url,
        state_file=(tmp / "oauth-state.json") if public_url else None,
    )


class FakeWorld:
    """A fake identity provider and a fake Wardrowbe behind one httpx mock transport."""

    def __init__(self, accepted_refresh: list[str], rotate_to: str | None = None, user: str = "user-1") -> None:
        self.accepted_refresh = accepted_refresh
        self.rotate_to = rotate_to
        self.user = user
        self.refresh_seen: list[str] = []
        self.auth_codes: dict[str, str] = {}  # upstream code -> verifier challenge
        self.api_calls: list[httpx.Request] = []
        self.sync_calls = 0

    def id_token(self) -> str:
        return jwt({"sub": self.user, "email": f"{self.user}@example.com", "exp": 9_999_999_999})

    def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        if url == f"{ISSUER}/.well-known/openid-configuration":
            return httpx.Response(
                200,
                json={
                    "authorization_endpoint": f"{ISSUER}/authorize",
                    "token_endpoint": f"{ISSUER}/token",
                },
            )
        if url == f"{ISSUER}/token":
            form = dict(x.split("=", 1) for x in request.content.decode().split("&"))
            if form["grant_type"] == "authorization_code":
                if form["code"] != "upstream-code" or not form.get("code_verifier"):
                    return httpx.Response(400, json={"error": "invalid_grant"})
                return httpx.Response(
                    200, json={"id_token": self.id_token(), "refresh_token": "idp-rt-1", "access_token": "x"}
                )
            token = form["refresh_token"].replace("%2F", "/")
            self.refresh_seen.append(token)
            if token not in self.accepted_refresh:
                return httpx.Response(400, json={"error": "invalid_grant"})
            body = {"id_token": self.id_token()}
            if self.rotate_to:
                body["refresh_token"] = self.rotate_to
            return httpx.Response(200, json=body)
        if url == f"{WARDROWBE}/api/v1/auth/sync":
            self.sync_calls += 1
            return httpx.Response(200, json={"access_token": jwt({"exp": 9_999_999_999})})
        if url.startswith(f"{WARDROWBE}/api/v1/"):
            self.api_calls.append(request)
            return httpx.Response(200, json={"items": [], "total": 0})
        raise AssertionError(f"unexpected request {request.method} {url}")

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler))
