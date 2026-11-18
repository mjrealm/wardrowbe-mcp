import { randomUUID } from "node:crypto";

/** Image types Wardrowbe accepts. HEIC is what iPhones produce by default. */
export const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"];
/** Largest photo the upload endpoint accepts. Phone photos are often 3 to 8 MB. */
export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const UPLOAD_TTL_MS = 10 * 60_000;
/** Caps how many photos can wait at once, so a flood of uploads cannot fill memory. */
export const MAX_PENDING_UPLOADS = 50;

export interface PendingUpload {
  bytes: Buffer;
  contentType: string;
  filename: string;
}

interface Entry extends PendingUpload {
  expiresAt: number;
}

export class UploadError extends Error {}

/**
 * Holds photos from the upload endpoint until a tool uses them. Each id works once, and entries
 * expire after UPLOAD_TTL_MS. Kept in memory, so uploads are lost if the server restarts.
 */
export class UploadStore {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly ttlMs: number = UPLOAD_TTL_MS,
  ) {}

  /** Stores a photo and returns its id. */
  put(upload: PendingUpload): string {
    this.sweep();
    if (this.entries.size >= MAX_PENDING_UPLOADS) {
      throw new UploadError("Too many photos are waiting to be added. Try again in a few minutes.");
    }
    const id = randomUUID();
    this.entries.set(id, { ...upload, expiresAt: this.now() + this.ttlMs });
    return id;
  }

  /** Returns the photo and removes it, so each id is used only once. */
  take(id: string): PendingUpload {
    this.sweep();
    const entry = this.entries.get(id);
    if (!entry) {
      throw new UploadError(
        `Upload ${id} was not found. It may have expired or already been used. Upload the photo again.`,
      );
    }
    this.entries.delete(id);
    return { bytes: entry.bytes, contentType: entry.contentType, filename: entry.filename };
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(id);
    }
  }
}

/** Shared by every HTTP request, since the HTTP transport builds a server per request. */
export const sharedUploads = new UploadStore();
