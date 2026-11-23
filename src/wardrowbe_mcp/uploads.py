"""Holds photos from POST /uploads until add_item uses them. Each id works once."""

from __future__ import annotations

import time
import uuid
from collections.abc import Callable
from dataclasses import dataclass

ALLOWED_IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp", "image/heic", "image/heif")
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
UPLOAD_TTL_SECONDS = 10 * 60
# Caps how many photos can wait at once, so a flood of uploads cannot fill memory.
MAX_PENDING_UPLOADS = 50


class UploadError(Exception):
    pass


@dataclass(frozen=True)
class PendingUpload:
    data: bytes
    content_type: str
    filename: str


class UploadStore:
    """In memory, so uploads are lost on restart. Run one replica."""

    def __init__(self, now: Callable[[], float] = time.monotonic, ttl: float = UPLOAD_TTL_SECONDS) -> None:
        self._now = now
        self._ttl = ttl
        self._entries: dict[str, tuple[float, PendingUpload]] = {}
        self._tickets: dict[str, float] = {}  # reserved ids still waiting for their photo

    def put(self, upload: PendingUpload) -> str:
        self._sweep()
        self._check_room()
        upload_id = str(uuid.uuid4())
        self._entries[upload_id] = (self._now() + self._ttl, upload)
        return upload_id

    def reserve(self) -> str:
        """Hands out an id that one photo can be uploaded to, without any other credential."""
        self._sweep()
        self._check_room()
        ticket = str(uuid.uuid4())
        self._tickets[ticket] = self._now() + self._ttl
        return ticket

    def has_ticket(self, ticket: str) -> bool:
        self._sweep()
        return ticket in self._tickets

    def fill(self, ticket: str, upload: PendingUpload) -> str:
        """Stores the photo for a reserved id. A ticket works once. The id then works with take()."""
        self._sweep()
        if self._tickets.pop(ticket, None) is None:
            raise UploadError("This upload link was not found. It may have expired or already been used.")
        self._entries[ticket] = (self._now() + self._ttl, upload)
        return ticket

    def _check_room(self) -> None:
        if len(self._entries) + len(self._tickets) >= MAX_PENDING_UPLOADS:
            raise UploadError("Too many photos are waiting to be added. Try again in a few minutes.")

    def take(self, upload_id: str) -> PendingUpload:
        self._sweep()
        entry = self._entries.pop(upload_id, None)
        if entry is None:
            raise UploadError(
                f"Upload {upload_id} was not found. It may have expired or already been used. Upload the photo again."
            )
        return entry[1]

    def _sweep(self) -> None:
        now = self._now()
        for key in [k for k, (expires, _) in self._entries.items() if expires <= now]:
            del self._entries[key]
        for key in [k for k, expires in self._tickets.items() if expires <= now]:
            del self._tickets[key]
