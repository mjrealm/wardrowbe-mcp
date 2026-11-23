"""The ASGI app: /mcp (Streamable HTTP) and POST /uploads, with an API key and optional OAuth sign-in."""

from __future__ import annotations

import dataclasses
import hmac
import re
from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from importlib.resources import files
from urllib.parse import unquote

import httpx
from mcp.server.auth.middleware.auth_context import get_access_token
from mcp.server.auth.settings import AuthSettings, ClientRegistrationOptions
from mcp.server.mcpserver import MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route
from starlette.types import ASGIApp, Receive, Scope, Send

from . import __version__
from .client import REQUEST_TIMEOUT, TokenProvider, WardrowbeClient
from .config import Config
from .oauth import SessionStore, UpstreamOAuthProvider
from .token_store import TokenStore
from .tools import register_tools
from .uploads import (
    ALLOWED_IMAGE_TYPES,
    MAX_UPLOAD_BYTES,
    UPLOAD_TTL_SECONDS,
    PendingUpload,
    UploadError,
    UploadStore,
)

SERVER_NAME = "wardrowbe-mcp"
SCOPE = "wardrowbe"
# Scopes a client may register for. Many clients ask for the standard OIDC ones, so accept them
# too. They grant nothing extra: every token is for the same Wardrowbe user and the same tools.
CLIENT_SCOPES = [SCOPE, "openid", "profile", "email", "offline_access"]


def is_authorized(header: str | None, api_key: str) -> bool:
    """Constant-time check of the Bearer token, so the comparison doesn't leak the key by timing."""
    match = re.fullmatch(r"Bearer (.+)", header or "")
    return bool(match) and hmac.compare_digest(match.group(1).encode(), api_key.encode())


class BearerAuth:
    """Rejects requests to the listed paths unless `verify` accepts the Bearer token."""

    def __init__(self, app: ASGIApp, paths: tuple[str, ...], verify: Callable[[str], Awaitable[bool]]) -> None:
        self.app = app
        self.paths = paths
        self.verify = verify

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["path"].rstrip("/") in self.paths:
            header = dict(scope["headers"]).get(b"authorization", b"").decode("latin-1")
            match = re.fullmatch(r"Bearer (.+)", header)
            if not match or not await self.verify(match.group(1)):
                response = JSONResponse(
                    {"error": "unauthorized"}, status_code=401, headers={"WWW-Authenticate": "Bearer"}
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


def sanitize_filename(raw: str | None) -> str:
    """Keeps just a safe file name: no folders, no control characters, at most 200 characters."""
    name = unquote(raw or "")
    name = re.split(r"[\\/]", name)[-1]
    name = re.sub(r"[\x00-\x1f\x7f]", "", name).strip()[:200]
    return name or "photo.jpg"


async def _read_photo(request: Request) -> PendingUpload | Response:
    """Reads and checks the photo in the request body, or returns the error response to send."""
    content_type = request.headers.get("content-type", "").split(";")[0].strip().lower()
    if content_type not in ALLOWED_IMAGE_TYPES:
        return JSONResponse({"error": f"Send the photo as one of: {', '.join(ALLOWED_IMAGE_TYPES)}"}, 415)
    too_large = JSONResponse({"error": f"Photo is larger than {MAX_UPLOAD_BYTES // 1024 // 1024} MB"}, 413)
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES:
        return too_large
    body = bytearray()
    async for chunk in request.stream():
        body += chunk
        if len(body) > MAX_UPLOAD_BYTES:
            return too_large
    if not body:
        return JSONResponse({"error": "The request had no photo data"}, 400)
    return PendingUpload(bytes(body), content_type, sanitize_filename(request.headers.get("x-filename")))


def make_upload_routes(uploads: UploadStore) -> list[Route]:
    """POST /uploads takes the Bearer key. POST /uploads/<ticket> needs no key: the ticket, handed out
    by the get_upload_url tool, is the credential. It works once and expires with the upload TTL."""

    async def create(request: Request) -> Response:
        photo = await _read_photo(request)
        if isinstance(photo, Response):
            return photo
        try:
            upload_id = uploads.put(photo)
        except UploadError as err:
            return JSONResponse({"error": str(err)}, 429)
        return JSONResponse({"upload_id": upload_id, "expires_in_seconds": UPLOAD_TTL_SECONDS}, 201)

    async def to_ticket(request: Request) -> Response:
        ticket = request.path_params["ticket"]
        if not uploads.has_ticket(ticket):
            return JSONResponse({"error": "This upload link was not found, expired, or was already used"}, 404)
        photo = await _read_photo(request)
        if isinstance(photo, Response):
            return photo  # A bad photo does not use up the ticket.
        try:
            upload_id = uploads.fill(ticket, photo)
        except UploadError as err:
            return JSONResponse({"error": str(err)}, 404)
        return JSONResponse({"upload_id": upload_id, "expires_in_seconds": UPLOAD_TTL_SECONDS}, 201)

    return [
        Route("/uploads", create, methods=["POST"]),
        Route("/uploads/{ticket}", to_ticket, methods=["POST", "PUT"]),
    ]


def create_app(config: Config, http: httpx.AsyncClient | None = None, uploads: UploadStore | None = None) -> Starlette:
    uploads = uploads or UploadStore()
    owns_http = http is None
    http = http or httpx.AsyncClient(timeout=REQUEST_TIMEOUT, headers={"Accept": "application/json"})

    # The default user: the configured static token or refresh token. Used when a request carries MCP_API_KEY.
    default_tokens = TokenProvider(config, http, TokenStore(config.token_file) if config.token_file else None)

    # With OAuth on, each signed-in user gets their own provider, seeded from the sessions the sign-in saved.
    sessions = SessionStore(config.state_file)
    per_user: dict[str, TokenProvider] = {}
    user_config = dataclasses.replace(
        config,
        static_token=None,
        oidc=dataclasses.replace(config.oidc, refresh_token=None) if config.oidc else None,
    )

    async def get_token() -> str:
        access = get_access_token()
        subject = access.subject if access else None
        if subject is None:
            return await default_tokens.get_token()
        if subject not in per_user:
            per_user[subject] = TokenProvider(user_config, http, sessions.for_subject(subject))
        return await per_user[subject].get_token()

    oauth: UpstreamOAuthProvider | None = None
    mcp_kwargs: dict = {}
    if config.public_url and config.oidc:
        oauth = UpstreamOAuthProvider(config.oidc, config.public_url, config.api_key, http, sessions)
        mcp_kwargs = {
            "auth_server_provider": oauth,
            "auth": AuthSettings(
                issuer_url=config.public_url,
                resource_server_url=f"{config.public_url}/mcp",
                client_registration_options=ClientRegistrationOptions(
                    enabled=True, valid_scopes=CLIENT_SCOPES, default_scopes=[SCOPE]
                ),
                required_scopes=None,
                # Tokens are opaque and issued only by this server, for this one resource.
                validate_token_resource=False,
            ),
        }

    mcp = MCPServer(SERVER_NAME, version=__version__, **mcp_kwargs)
    register_tools(mcp, WardrowbeClient(config, get_token, http), uploads, config.public_url)

    skill_text = (files("wardrowbe_mcp") / "skill" / "SKILL.md").read_text("utf-8")

    @mcp.resource(
        "skill://wardrowbe-skill/SKILL.md",
        name="wardrowbe-skill",
        description="How to use the Wardrowbe tools: choosing a tool, adding items from photos, archiving.",
        mime_type="text/markdown",
    )
    def skill() -> str:
        return skill_text

    # Stateless, so no session is kept between calls. The Bearer key protects the endpoints, so the
    # localhost-only Host header check is off; it would reject requests addressed to a service name.
    app = mcp.streamable_http_app(
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False),
    )
    app.router.routes.extend(make_upload_routes(uploads))

    async def info(_: Request) -> Response:
        return JSONResponse(
            {
                "name": SERVER_NAME,
                "version": __version__,
                "endpoint": "/mcp",
                "uploads": "/uploads",
                "oauth": oauth is not None,
            }
        )

    app.router.routes.append(Route("/", info, methods=["GET"]))
    app.router.routes.append(Route("/healthz", lambda _: Response("ok"), methods=["GET"]))

    if oauth:
        app.router.routes.append(oauth.callback_route())

        # /mcp is guarded by the SDK's OAuth middleware. /uploads takes the API key or an OAuth token.
        async def verify_upload(token: str) -> bool:
            return await oauth.load_access_token(token) is not None

        app.add_middleware(BearerAuth, paths=("/uploads",), verify=verify_upload)
    else:

        async def verify_key(token: str) -> bool:
            return is_authorized(f"Bearer {token}", config.api_key)

        app.add_middleware(BearerAuth, paths=("/mcp", "/uploads"), verify=verify_key)

    if owns_http:
        inner = app.router.lifespan_context

        @asynccontextmanager
        async def lifespan(a: Starlette):
            async with inner(a):
                try:
                    yield
                finally:
                    await http.aclose()

        app.router.lifespan_context = lifespan

    return app
