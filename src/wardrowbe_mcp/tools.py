"""The Wardrowbe tools. Each one is a thin call to the Wardrowbe REST API."""

from __future__ import annotations

from datetime import date as _date  # noqa: F401  (kept for type hints in docs)
from typing import Annotated, Any
from uuid import UUID

from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from pydantic import Field

from .client import WardrowbeClient
from .uploads import UPLOAD_TTL_SECONDS, UploadError, UploadStore

Days = Annotated[int | None, Field(ge=7, le=365, description="Trend window, 7 to 365 days")]
IsoDate = Annotated[str | None, Field(pattern=r"^\d{4}-\d{2}-\d{2}$", description="Date as YYYY-MM-DD")]


def register_tools(
    mcp: MCPServer, client: WardrowbeClient, uploads: UploadStore, public_url: str | None = None
) -> None:
    @mcp.tool()
    async def get_upload_url() -> Any:
        """Get a one-time URL for uploading a photo from your own filesystem. Send the raw image bytes to it with an HTTP POST (for example curl --data-binary @photo.jpg -H 'Content-Type: image/jpeg'), no other credential needed. Then pass the returned upload_id to add_item. The URL works once and expires in 10 minutes."""
        try:
            ticket = uploads.reserve()
        except UploadError as err:
            raise ToolError(str(err)) from err
        path = f"/uploads/{ticket}"
        return {
            "upload_id": ticket,
            "upload_url": f"{public_url}{path}" if public_url else path,
            "relative_to_server": public_url is None,
            "expires_in_seconds": UPLOAD_TTL_SECONDS,
        }

    @mcp.tool()
    async def list_items(
        type: str | None = None,
        subtype: str | None = None,
        colors: Annotated[str | None, Field(description="Comma-separated color names")] = None,
        status: str | None = None,
        favorite: bool | None = None,
        needs_wash: bool | None = None,
        search: str | None = None,
        page: Annotated[int | None, Field(ge=1)] = None,
        page_size: Annotated[int | None, Field(ge=1)] = None,
    ) -> Any:
        """List items in the user's wardrobe. Filter by type, status, favorites, or items that need washing."""
        return await client.get(
            "/items", type=type, subtype=subtype, colors=colors, status=status, favorite=favorite,
            needs_wash=needs_wash, search=search, page=page, page_size=page_size,
        )

    @mcp.tool()
    async def get_item(item_id: UUID) -> Any:
        """Get full details for one wardrobe item, including its wear and wash status."""
        return await client.get(f"/items/{item_id}")

    @mcp.tool()
    async def log_wear(
        item_id: UUID, worn_at: IsoDate = None, occasion: str | None = None, notes: str | None = None
    ) -> Any:
        """Record that an item was worn. Defaults to today in the user's timezone when worn_at is omitted."""
        return await client.post(
            f"/items/{item_id}/wear", _drop_none({"worn_at": worn_at, "occasion": occasion, "notes": notes})
        )

    @mcp.tool()
    async def log_wash(
        item_id: UUID,
        washed_at: IsoDate = None,
        method: Annotated[str | None, Field(max_length=50)] = None,
        notes: str | None = None,
    ) -> Any:
        """Record that an item was washed. Defaults to today in the user's timezone when washed_at is omitted."""
        return await client.post(
            f"/items/{item_id}/wash", _drop_none({"washed_at": washed_at, "method": method, "notes": notes})
        )

    @mcp.tool()
    async def suggest_outfit(
        occasion: str | None = None,
        time_of_day: str | None = None,
        exclude_items: list[UUID] | None = None,
        include_items: list[UUID] | None = None,
    ) -> Any:
        """Ask Wardrowbe to suggest an outfit from the wardrobe. Rate limited to about 10 requests per minute per user."""
        return await client.post(
            "/outfits/suggest",
            {
                "occasion": occasion,
                "time_of_day": time_of_day,
                "exclude_items": [str(i) for i in exclude_items or []],
                "include_items": [str(i) for i in include_items or []],
            },
        )

    @mcp.tool()
    async def accept_outfit(outfit_id: UUID) -> Any:
        """Mark a suggested outfit as accepted."""
        return await client.post(f"/outfits/{outfit_id}/accept")

    @mcp.tool()
    async def reject_outfit(outfit_id: UUID) -> Any:
        """Mark a suggested outfit as rejected, so it is not suggested again."""
        return await client.post(f"/outfits/{outfit_id}/reject")

    @mcp.tool()
    async def get_analytics(days: Days = None) -> Any:
        """Get wardrobe analytics, including trends over a chosen window of days."""
        return await client.get("/analytics", days=days or 30)

    @mcp.tool()
    async def add_item(
        upload_id: Annotated[UUID, Field(description="upload_id from get_upload_url (after the photo was sent to its URL)")],
        type: Annotated[str | None, Field(description="Item type, e.g. top, bottom, shoes. Detected if omitted.")] = None,
        subtype: str | None = None,
        name: Annotated[str | None, Field(max_length=100)] = None,
        brand: Annotated[str | None, Field(max_length=100)] = None,
        notes: Annotated[str | None, Field(max_length=1000)] = None,
        colors: Annotated[str | None, Field(description="Comma-separated color names")] = None,
        primary_color: str | None = None,
        favorite: bool | None = None,
        skip_ai: Annotated[bool | None, Field(description="Skip AI tagging and use only the fields given")] = None,
    ) -> Any:
        """Add a new item to the wardrobe from a photo. First call get_upload_url and POST the raw image bytes to the URL it returns, then pass the upload_id here. Wardrowbe detects the type and colors unless skip_ai is true or you pass them."""
        try:
            photo = uploads.take(str(upload_id))
        except UploadError as err:
            raise ToolError(str(err)) from err
        fields = _drop_none(
            {
                "type": type, "subtype": subtype, "name": name, "brand": brand, "notes": notes,
                "colors": colors, "primary_color": primary_color, "favorite": favorite, "skip_ai": skip_ai,
            }
        )
        data = {k: str(v).lower() if isinstance(v, bool) else str(v) for k, v in fields.items()}
        return await client.post_form(
            "/items", data, {"image": (photo.filename, photo.data, photo.content_type)}
        )

    @mcp.tool()
    async def get_wardrobe_summary(days: Days = None) -> Any:
        """A short overview of the wardrobe: item counts, the insights Wardrowbe has noticed, and the most and least worn items. Good first call when a user asks how their wardrobe is doing."""
        analytics = await client.get("/analytics", days=days or 30)
        return {k: analytics.get(k) for k in ("wardrobe", "insights", "most_worn", "never_worn")}

    @mcp.tool()
    async def get_most_worn_items(
        limit: Annotated[int | None, Field(ge=1, le=5, description="How many items, up to 5")] = None,
        days: Days = None,
    ) -> Any:
        """The items worn most often in the trend window. Wardrowbe returns at most 5."""
        analytics = await client.get("/analytics", days=days or 30)
        return {"items": (analytics.get("most_worn") or [])[: limit or 5]}

    @mcp.tool()
    async def get_items_to_wash(
        limit: Annotated[int | None, Field(ge=1, le=100, description="How many items to return")] = None,
    ) -> Any:
        """Items worn since their last wash, so they are due for washing."""
        return await client.get("/items", needs_wash=True, page_size=limit or 20)

    @mcp.tool()
    async def archive_item(
        item_id: UUID,
        reason: Annotated[str | None, Field(max_length=200, description="Why, e.g. worn out")] = None,
    ) -> Any:
        """Archive an item so it is left out of outfit suggestions. It stays in the wardrobe and can be restored. Use this for items that are worn out, given away, or out of season."""
        return await client.post(f"/items/{item_id}/archive", {} if reason is None else {"reason": reason})

    @mcp.tool()
    async def restore_item(item_id: UUID) -> Any:
        """Bring an archived item back into the active wardrobe and outfit suggestions."""
        return await client.post(f"/items/{item_id}/restore")


def _drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in values.items() if v is not None}
