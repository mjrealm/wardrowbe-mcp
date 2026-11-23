import base64
import hashlib
import secrets
from urllib.parse import parse_qs, urlparse

from starlette.testclient import TestClient

from helpers import ISSUER, KEY, FakeWorld, make_config
from wardrowbe_mcp.app import create_app

PUBLIC = "https://mcp.test"
REDIRECT = "http://localhost:9999/cb"
MCP = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


def pkce():
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
    return verifier, challenge


def sign_in(c: TestClient, world: FakeWorld):
    """Runs the whole flow the way an MCP client would, and returns its token response."""
    reg = c.post("/register", json={"redirect_uris": [REDIRECT], "token_endpoint_auth_method": "none", "grant_types": ["authorization_code", "refresh_token"], "response_types": ["code"], "client_name": "t"})
    assert reg.status_code == 201, reg.text
    client_id = reg.json()["client_id"]

    verifier, challenge = pkce()
    auth = c.get("/authorize", follow_redirects=False, params={
        "response_type": "code", "client_id": client_id, "redirect_uri": REDIRECT, "code_challenge": challenge,
        "code_challenge_method": "S256", "state": "client-state", "scope": "wardrowbe",
    })
    assert auth.status_code == 302, auth.text
    upstream = urlparse(auth.headers["location"])
    assert f"{upstream.scheme}://{upstream.netloc}{upstream.path}" == f"{ISSUER}/authorize"
    q = parse_qs(upstream.query)
    assert q["redirect_uri"] == [f"{PUBLIC}/oauth/callback"] and q["code_challenge_method"] == ["S256"]
    assert "offline_access" in q["scope"][0]

    # The identity provider sends the user back with a code.
    back = c.get("/oauth/callback", follow_redirects=False, params={"code": "upstream-code", "state": q["state"][0]})
    assert back.status_code == 302, back.text
    target = urlparse(back.headers["location"])
    assert f"{target.scheme}://{target.netloc}{target.path}" == REDIRECT
    cb = parse_qs(target.query)
    assert cb["state"] == ["client-state"]

    tok = c.post("/token", data={
        "grant_type": "authorization_code", "code": cb["code"][0], "redirect_uri": REDIRECT,
        "client_id": client_id, "code_verifier": verifier,
    })
    assert tok.status_code == 200, tok.text
    return client_id, tok.json()


def call(c: TestClient, token: str, name="list_items", arguments=None):
    h = {**MCP, "Authorization": f"Bearer {token}"}
    c.post("/mcp", headers=h, json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}})
    return c.post("/mcp", headers=h, json={"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {"name": name, "arguments": arguments or {}}})


def test_metadata_advertises_the_oauth_endpoints(tmp_path):
    world = FakeWorld([])
    with TestClient(create_app(make_config(tmp_path, refresh=None, public_url=PUBLIC), world.client()), base_url=PUBLIC) as c:
        meta = c.get("/.well-known/oauth-authorization-server").json()
        assert meta["authorization_endpoint"] == f"{PUBLIC}/authorize"
        assert meta["registration_endpoint"] == f"{PUBLIC}/register"
        assert "S256" in meta["code_challenge_methods_supported"]
        assert c.get("/").json()["oauth"] is True
        # No token: the client is told where to sign in.
        r = c.post("/mcp", headers=MCP, json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        assert r.status_code == 401
        assert "resource_metadata" in r.headers.get("www-authenticate", "")


def test_sign_in_then_tools_run_as_that_user(tmp_path):
    world = FakeWorld(["idp-rt-1"], user="alice")
    config = make_config(tmp_path, refresh=None, public_url=PUBLIC)
    with TestClient(create_app(config, world.client()), base_url=PUBLIC) as c:
        _, tokens = sign_in(c, world)
        assert tokens["token_type"].lower() == "bearer" and tokens["refresh_token"]

        r = call(c, tokens["access_token"])
        assert r.status_code == 200 and not r.json()["result"].get("isError"), r.text
        # The user's own identity-provider refresh token was used, and Wardrowbe was called with it.
        assert world.refresh_seen == ["idp-rt-1"]
        assert world.api_calls[-1].url.path == "/api/v1/items"


def test_state_survives_a_restart_and_refresh_tokens_rotate(tmp_path):
    config = make_config(tmp_path, refresh=None, public_url=PUBLIC)
    world = FakeWorld(["idp-rt-1"], user="alice")
    with TestClient(create_app(config, world.client()), base_url=PUBLIC) as c:
        client_id, tokens = sign_in(c, world)

    # New process: same state file. The old access token is gone, but the refresh token works.
    world2 = FakeWorld(["idp-rt-1"], user="alice")
    with TestClient(create_app(config, world2.client()), base_url=PUBLIC) as c:
        assert call(c, tokens["access_token"]).status_code == 401
        new = c.post("/token", data={"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"], "client_id": client_id})
        assert new.status_code == 200, new.text
        assert new.json()["refresh_token"] != tokens["refresh_token"]
        assert call(c, new.json()["access_token"]).status_code == 200
        assert world2.refresh_seen == ["idp-rt-1"]
        # The rotated token replaced the old one.
        old = c.post("/token", data={"grant_type": "refresh_token", "refresh_token": tokens["refresh_token"], "client_id": client_id})
        assert old.status_code == 400


def test_a_bad_callback_state_is_refused(tmp_path):
    with TestClient(create_app(make_config(tmp_path, refresh=None, public_url=PUBLIC), FakeWorld([]).client()), base_url=PUBLIC) as c:
        r = c.get("/oauth/callback", params={"code": "x", "state": "unknown"}, follow_redirects=False)
        assert r.status_code == 400


def test_the_api_key_still_works_for_mcp_and_uploads(tmp_path):
    world = FakeWorld(["env-rt"])
    config = make_config(tmp_path, refresh="env-rt", public_url=PUBLIC)
    with TestClient(create_app(config, world.client()), base_url=PUBLIC) as c:
        up = c.post("/uploads", content=b"jpeg", headers={"Authorization": f"Bearer {KEY}", "Content-Type": "image/jpeg"})
        assert up.status_code == 201
        assert c.post("/uploads", content=b"jpeg", headers={"Content-Type": "image/jpeg"}).status_code == 401
        r = call(c, KEY)
        assert r.status_code == 200 and not r.json()["result"].get("isError"), r.text
        assert world.refresh_seen == ["env-rt"]  # The default user, from the config.
