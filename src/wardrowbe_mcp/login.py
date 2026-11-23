"""`wardrowbe-mcp login`: sign in with your identity provider once and get a refresh token.

Runs the OIDC authorization-code flow with PKCE. A short-lived listener on 127.0.0.1 receives the
redirect, so register `http://127.0.0.1:<LOGIN_PORT>/callback` (default port 8765) as a redirect URI
on the OIDC client. The refresh token is saved to the token file and printed, so it can also be
used as OIDC_REFRESH_TOKEN on a server.
"""

from __future__ import annotations

import base64
import hashlib
import os
import secrets
import sys
import time
import webbrowser
from pathlib import Path
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

from .config import Oidc, default_token_file
from .oauth import UPSTREAM_SCOPES
from .token_store import TokenStore

DEFAULT_LOGIN_PORT = 8765
LOGIN_TIMEOUT = 300


class LoginError(Exception):
    pass


def pkce_pair() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def build_authorize_url(endpoint: str, oidc: Oidc, redirect_uri: str, state: str, challenge: str) -> str:
    query = urlencode(
        {
            "response_type": "code",
            "client_id": oidc.client_id,
            "redirect_uri": redirect_uri,
            "scope": UPSTREAM_SCOPES,
            "state": state,
            "code_challenge": challenge,
            "code_challenge_method": "S256",
        }
    )
    return f"{endpoint}?{query}"


def exchange_code(http: httpx.Client, token_endpoint: str, oidc: Oidc, code: str, redirect_uri: str, verifier: str) -> str:
    form = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": redirect_uri,
        "client_id": oidc.client_id,
        "code_verifier": verifier,
    }
    if oidc.client_secret:
        form["client_secret"] = oidc.client_secret
    response = http.post(token_endpoint, data=form)
    try:
        body = response.json()
    except ValueError:
        body = None
    if not response.is_success or not isinstance(body, dict):
        raise LoginError(f"The identity provider refused the code (HTTP {response.status_code}).")
    refresh = body.get("refresh_token")
    if not refresh:
        raise LoginError("No refresh token came back. Enable the offline_access scope on the OIDC client.")
    return refresh


def _wait_for_redirect(port: int, state: str) -> str:
    """Serves one request on the loopback address and returns the authorization code."""
    result: dict[str, str] = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path != "/callback":
                self.send_error(404)
                return
            query = {k: v[0] for k, v in parse_qs(parsed.query).items()}
            if query.get("state") != state:
                self.send_error(400, "State mismatch")
                return
            result.update(query)
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.end_headers()
            self.wfile.write(b"Signed in. You can close this tab and return to the terminal.\n")

        def log_message(self, *args: object) -> None:
            pass

    server = HTTPServer(("127.0.0.1", port), Handler)
    server.timeout = 5
    try:
        deadline = time.monotonic() + LOGIN_TIMEOUT
        while "code" not in result and "error" not in result:
            if time.monotonic() > deadline:
                raise LoginError("Timed out waiting for the sign-in to finish.")
            server.handle_request()
    finally:
        server.server_close()
    if "error" in result:
        raise LoginError(f"Sign-in failed: {result['error']}")
    return result["code"]


def run_login(env: dict[str, str] | None = None) -> int:
    env = dict(os.environ if env is None else env)
    issuer = (env.get("OIDC_ISSUER_URL") or "").strip().rstrip("/")
    client_id = (env.get("OIDC_CLIENT_ID") or "").strip()
    if not issuer or not client_id:
        print("login needs OIDC_ISSUER_URL and OIDC_CLIENT_ID", file=sys.stderr)
        return 2
    oidc = Oidc(issuer, client_id, (env.get("OIDC_CLIENT_SECRET") or "").strip() or None)
    port = int(env.get("LOGIN_PORT") or DEFAULT_LOGIN_PORT)
    redirect_uri = f"http://127.0.0.1:{port}/callback"
    try:
        with httpx.Client(timeout=30) as http:
            meta = http.get(f"{issuer}/.well-known/openid-configuration").json()
            verifier, challenge = pkce_pair()
            state = secrets.token_urlsafe(24)
            url = build_authorize_url(meta["authorization_endpoint"], oidc, redirect_uri, state, challenge)
            print(f"Redirect URI to allow on the OIDC client: {redirect_uri}", file=sys.stderr)
            print(f"Open this URL to sign in:\n\n{url}\n", file=sys.stderr)
            webbrowser.open(url)
            code = _wait_for_redirect(port, state)
            refresh = exchange_code(http, meta["token_endpoint"], oidc, code, redirect_uri, verifier)
    except (LoginError, httpx.HTTPError, KeyError, ValueError, OSError) as err:
        print(f"login failed: {err}", file=sys.stderr)
        return 1
    token_file = (env.get("WARDROWBE_TOKEN_FILE") or "").strip()
    path = TokenStore(Path(token_file) if token_file else default_token_file(env))
    path.save(issuer, client_id, refresh)
    print(f"Saved the refresh token to {path.path}", file=sys.stderr)
    print(refresh)
    return 0
