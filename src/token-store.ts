import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** What the server keeps between runs so it doesn't have to sign in again. */
export interface StoredRefreshToken {
  issuerUrl: string;
  clientId: string;
  refreshToken: string;
}

/** Default location: $XDG_CONFIG_HOME/wardrowbe-mcp/refresh-token.json, or ~/.config/... */
export function defaultTokenFile(env: NodeJS.ProcessEnv): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "wardrowbe-mcp", "refresh-token.json");
}

/**
 * Persists the OIDC refresh token to a file readable only by the current user. Entries are keyed
 * by issuer and client ID, so a changed config never reuses a token from another IdP.
 */
export class TokenStore {
  constructor(readonly path: string) {}

  /** Returns the stored refresh token for this issuer and client, or undefined if there is none. */
  async load(issuerUrl: string, clientId: string): Promise<string | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
    let entry: Partial<StoredRefreshToken>;
    try {
      entry = JSON.parse(raw) as Partial<StoredRefreshToken>;
    } catch {
      // A corrupt file is treated as missing; the next sign-in overwrites it.
      return undefined;
    }
    if (entry.issuerUrl !== issuerUrl || entry.clientId !== clientId || !entry.refreshToken) {
      return undefined;
    }
    return entry.refreshToken;
  }

  /** Writes the token atomically: a temp file is renamed over the old one, so a crash never leaves a partial file. */
  async save(entry: StoredRefreshToken): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
