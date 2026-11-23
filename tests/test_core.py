import json

import pytest
from starlette.testclient import TestClient

from helpers import ISSUER, KEY, WARDROWBE, FakeWorld, make_config
from wardrowbe_mcp.app import create_app
from wardrowbe_mcp.client import TokenProvider, WardrowbeError
from wardrowbe_mcp.config import ConfigError, load_config
from wardrowbe_mcp.token_store import TokenStore
from wardrowbe_mcp.uploads import MAX_PENDING_UPLOADS, PendingUpload, UploadError, UploadStore

AUTH = {"Authorization": f"Bearer {KEY}"}
MCP_HEADERS = {**AUTH, "Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


def rpc(client: TestClient, method: str, params: dict | None = None, id: int = 1, headers=MCP_HEADERS):
    return client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": id, "method": method, "params": params or {}})


def initialized(client: TestClient, headers=MCP_HEADERS):
    r = rpc(client, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}, headers=headers)
    assert r.status_code == 200, r.text


# ---- config ----------------------------------------------------------------------------------------

def test_config_requires_the_basics():
    with pytest.raises(ConfigError, match="WARDROWBE_URL"):
        load_config({})
    with pytest.raises(ConfigError, match="MCP_API_KEY"):
        load_config({"WARDROWBE_URL": "https://w.test"})
    with pytest.raises(ConfigError, match="OIDC"):
        load_config({"WARDROWBE_URL": "https://w.test", "MCP_API_KEY": "k"})


def test_public_url_needs_oidc_and_sets_state_file():
    base = {"WARDROWBE_URL": "https://w.test", "MCP_API_KEY": "k", "WARDROWBE_TOKEN": "t", "PUBLIC_URL": "https://mcp.test/"}
    with pytest.raises(ConfigError, match="OIDC_ISSUER_URL"):
        load_config(base)
    cfg = load_config({**base, "OIDC_ISSUER_URL": ISSUER, "OIDC_CLIENT_ID": "wardrowbe", "XDG_CONFIG_HOME": "/xdg"})
    assert cfg.public_url == "https://mcp.test"
    assert str(cfg.state_file) == "/xdg/wardrowbe-mcp/oauth-state.json"
    assert cfg.oidc.refresh_token is None  # No seed token is needed with OAuth.


# ---- uploads ---------------------------------------------------------------------------------------

def test_upload_store_ids_work_once_and_expire():
    clock = [0.0]
    store = UploadStore(now=lambda: clock[0], ttl=10)
    upload_id = store.put(PendingUpload(b"x", "image/jpeg", "a.jpg"))
    assert store.take(upload_id).data == b"x"
    with pytest.raises(UploadError):
        store.take(upload_id)
    other = store.put(PendingUpload(b"y", "image/jpeg", "b.jpg"))
    clock[0] = 11
    with pytest.raises(UploadError):
        store.take(other)


def test_upload_store_caps_pending_photos():
    store = UploadStore()
    for _ in range(MAX_PENDING_UPLOADS):
        store.put(PendingUpload(b"x", "image/png", "a.png"))
    with pytest.raises(UploadError, match="Too many"):
        store.put(PendingUpload(b"x", "image/png", "a.png"))


# ---- http app --------------------------------------------------------------------------------------

def test_endpoints_need_the_api_key(tmp_path):
    world = FakeWorld(["env-rt"])
    with TestClient(create_app(make_config(tmp_path), world.client())) as c:
        assert c.get("/").json()["oauth"] is False
        assert c.get("/healthz").text == "ok"
        assert c.post("/uploads", content=b"x", headers={"Content-Type": "image/jpeg"}).status_code == 401
        assert rpc(c, "tools/list", headers={"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}).status_code == 401
        bad = {**MCP_HEADERS, "Authorization": "Bearer nope"}
        assert rpc(c, "tools/list", headers=bad).status_code == 401


def test_upload_endpoint_validates_the_photo(tmp_path):
    with TestClient(create_app(make_config(tmp_path), FakeWorld([]).client())) as c:
        ok = c.post("/uploads", content=b"jpeg", headers={**AUTH, "Content-Type": "image/jpeg", "X-Filename": "../a%20b.jpg"})
        assert ok.status_code == 201 and ok.json()["expires_in_seconds"] == 600
        assert c.post("/uploads", content=b"x", headers={**AUTH, "Content-Type": "text/plain"}).status_code == 415
        assert c.post("/uploads", content=b"", headers={**AUTH, "Content-Type": "image/png"}).status_code == 400
        assert c.get("/uploads", headers=AUTH).status_code == 405


def test_tools_list_and_add_item_end_to_end(tmp_path):
    world = FakeWorld(["env-rt"])
    with TestClient(create_app(make_config(tmp_path), world.client())) as c:
        initialized(c)
        names = {t["name"] for t in rpc(c, "tools/list").json()["result"]["tools"]}
        assert {"list_items", "add_item", "archive_item", "get_wardrobe_summary"} <= names
        assert "upload_photo" not in names

        upload_id = c.post("/uploads", content=b"jpeg-bytes", headers={**AUTH, "Content-Type": "image/jpeg", "X-Filename": "tee.jpg"}).json()["upload_id"]
        result = rpc(c, "tools/call", {"name": "add_item", "arguments": {"upload_id": upload_id, "name": "Tee", "favorite": True}}).json()["result"]
        assert not result.get("isError"), result
        sent = world.api_calls[-1]
        assert sent.url.path == "/api/v1/items" and sent.method == "POST"
        body = sent.read()
        assert b"jpeg-bytes" in body and b'filename="tee.jpg"' in body and b"Tee" in body and b"true" in body

        again = rpc(c, "tools/call", {"name": "add_item", "arguments": {"upload_id": upload_id}}).json()["result"]
        assert again["isError"] is True
        assert "not found" in json.dumps(again)


def test_upload_ticket_flow_needs_no_key_and_works_once(tmp_path):
    world = FakeWorld(["env-rt"])
    config = make_config(tmp_path, public_url="https://mcp.test")
    with TestClient(create_app(make_config(tmp_path), world.client())) as c:
        initialized(c)
        res = rpc(c, "tools/call", {"name": "get_upload_url", "arguments": {}}).json()["result"]
        info = json.loads(res["content"][0]["text"])
        assert info["relative_to_server"] is True and info["upload_url"] == f"/uploads/{info['upload_id']}"
        url = info["upload_url"]

        # No Authorization header: the ticket is the credential. A bad photo does not burn it.
        assert c.post(url, content=b"x", headers={"Content-Type": "text/plain"}).status_code == 415
        assert c.post(url, content=b"", headers={"Content-Type": "image/png"}).status_code == 400
        ok = c.post(url, content=b"jpeg-bytes", headers={"Content-Type": "image/jpeg", "X-Filename": "tee.jpg"})
        assert ok.status_code == 201 and ok.json()["upload_id"] == info["upload_id"]
        assert c.post(url, content=b"again", headers={"Content-Type": "image/jpeg"}).status_code == 404
        assert c.post("/uploads/not-a-ticket", content=b"x", headers={"Content-Type": "image/jpeg"}).status_code == 404

        added = rpc(c, "tools/call", {"name": "add_item", "arguments": {"upload_id": info["upload_id"]}}).json()["result"]
        assert not added.get("isError"), added
        assert b"jpeg-bytes" in world.api_calls[-1].read()

    with TestClient(create_app(config, FakeWorld(["env-rt"]).client())) as c:
        initialized(c)
        res = rpc(c, "tools/call", {"name": "get_upload_url", "arguments": {}}).json()["result"]
        assert json.loads(res["content"][0]["text"])["upload_url"].startswith("https://mcp.test/uploads/")


def test_upload_ticket_expires_and_counts_toward_the_cap():
    clock = [0.0]
    store = UploadStore(now=lambda: clock[0], ttl=10)
    ticket = store.reserve()
    clock[0] = 11
    with pytest.raises(UploadError):
        store.fill(ticket, PendingUpload(b"x", "image/png", "a.png"))
    for _ in range(MAX_PENDING_UPLOADS):
        store.reserve()
    with pytest.raises(UploadError, match="Too many"):
        store.reserve()


def test_list_items_passes_filters(tmp_path):
    world = FakeWorld(["env-rt"])
    with TestClient(create_app(make_config(tmp_path), world.client())) as c:
        initialized(c)
        r = rpc(c, "tools/call", {"name": "list_items", "arguments": {"type": "top", "needs_wash": True}}).json()["result"]
        assert not r.get("isError"), r
        assert dict(world.api_calls[-1].url.params) == {"type": "top", "needs_wash": "true"}


# ---- refresh token handling ------------------------------------------------------------------------

async def test_saved_token_wins_after_rotation_restart(tmp_path):
    config = make_config(tmp_path)
    first = FakeWorld(["env-rt"], rotate_to="rt-2")
    await TokenProvider(config, first.client(), TokenStore(config.token_file)).get_token()

    second = FakeWorld(["rt-2"], rotate_to="rt-3")  # env-rt is dead now
    await TokenProvider(config, second.client(), TokenStore(config.token_file)).get_token()
    assert second.refresh_seen == ["rt-2"]
    assert TokenStore(config.token_file).load(ISSUER, "wardrowbe") == "rt-3"


async def test_configured_token_is_the_fallback(tmp_path):
    config = make_config(tmp_path, refresh="new-env-rt")
    TokenStore(config.token_file).save(ISSUER, "wardrowbe", "revoked-rt")
    world = FakeWorld(["new-env-rt"])
    await TokenProvider(config, world.client(), TokenStore(config.token_file)).get_token()
    assert world.refresh_seen == ["revoked-rt", "new-env-rt"]


async def test_all_tokens_rejected_fails_fast_with_instructions(tmp_path):
    config = make_config(tmp_path)
    world = FakeWorld([])
    with pytest.raises(WardrowbeError, match="login"):
        await TokenProvider(config, world.client(), TokenStore(config.token_file)).get_token()
    assert world.refresh_seen == ["env-rt"]  # No browser, no waiting.


async def test_no_token_at_all_fails_fast(tmp_path):
    config = make_config(tmp_path, refresh=None)
    with pytest.raises(WardrowbeError, match="No refresh token"):
        await TokenProvider(config, FakeWorld([]).client(), TokenStore(config.token_file)).get_token()


def test_login_pkce_and_authorize_url():
    from urllib.parse import parse_qs, urlparse

    from wardrowbe_mcp.config import Oidc
    from wardrowbe_mcp.login import build_authorize_url, pkce_pair

    verifier, challenge = pkce_pair()
    url = build_authorize_url("https://idp/authorize", Oidc("https://idp", "cid"), "http://127.0.0.1:8765/callback", "st", challenge)
    q = parse_qs(urlparse(url).query)
    assert q["code_challenge"] == [challenge] and q["code_challenge_method"] == ["S256"]
    assert "offline_access" in q["scope"][0] and q["state"] == ["st"]
    assert verifier != challenge
