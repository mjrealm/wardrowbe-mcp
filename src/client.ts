import type { Config } from "./config.js";

export type FetchFn = typeof fetch;

export class WardrowbeApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Wardrowbe API ${status}: ${detail}`);
  }
}

/** Refresh this long before the access token expires, so a call never starts with a dead token. */
const EXPIRY_MARGIN_MS = 60_000;
/** Used when an access token has no exp claim. */
const FALLBACK_TTL_MS = 5 * 60_000;

/**
 * Provides a Wardrowbe access token. With a static token it returns that. With OIDC it
 * exchanges the refresh token for an id token, then trades that id token at /auth/sync for
 * a Wardrowbe access token, caching the result until shortly before it expires.
 */
export class TokenProvider {
  private accessToken?: string;
  private expiresAt = 0;
  private refreshToken?: string;
  private inflight?: Promise<string>;

  constructor(
    private readonly config: Config,
    private readonly fetchFn: FetchFn = fetch,
    private readonly now: () => number = Date.now,
  ) {
    this.refreshToken = config.oidc?.refreshToken;
  }

  async getToken(): Promise<string> {
    if (this.config.staticToken) return this.config.staticToken;
    if (this.accessToken && this.now() < this.expiresAt - EXPIRY_MARGIN_MS) {
      return this.accessToken;
    }
    // Share one in-flight exchange so concurrent tool calls don't each refresh the token.
    this.inflight ??= this.exchange().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async exchange(): Promise<string> {
    const oidc = this.config.oidc;
    if (!oidc) throw new Error("No OIDC configuration");

    const idToken = await this.refreshIdToken(oidc);
    const res = await this.fetchFn(`${this.config.wardrowbeUrl}/api/v1/auth/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ id_token: idToken }),
    });
    const body = (await parseJson(res)) as { access_token?: string } | undefined;
    if (!res.ok || !body?.access_token) {
      throw new WardrowbeApiError(res.status, `auth/sync failed: ${describe(body, res)}`);
    }

    this.accessToken = body.access_token;
    const ttl = jwtTtlMs(body.access_token, this.now);
    this.expiresAt = this.now() + (ttl ?? FALLBACK_TTL_MS);
    return this.accessToken;
  }

  private async refreshIdToken(oidc: NonNullable<Config["oidc"]>): Promise<string> {
    const discovery = await this.fetchFn(`${oidc.issuerUrl}/.well-known/openid-configuration`, {
      headers: { Accept: "application/json" },
    });
    const meta = (await parseJson(discovery)) as { token_endpoint?: string } | undefined;
    if (!discovery.ok || !meta?.token_endpoint) {
      throw new Error(`OIDC discovery failed at ${oidc.issuerUrl} (HTTP ${discovery.status})`);
    }

    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.refreshToken ?? "",
      client_id: oidc.clientId,
    });
    if (oidc.clientSecret) form.set("client_secret", oidc.clientSecret);

    const res = await this.fetchFn(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form,
    });
    const tokens = (await parseJson(res)) as
      | { id_token?: string; refresh_token?: string }
      | undefined;
    if (!res.ok || !tokens?.id_token) {
      throw new Error(
        `OIDC refresh failed (HTTP ${res.status}). The refresh token may be expired or revoked.`,
      );
    }
    // Some issuers rotate refresh tokens. Keep the newest one in memory.
    if (tokens.refresh_token) this.refreshToken = tokens.refresh_token;
    return tokens.id_token;
  }
}

/** Thin JSON client for the Wardrowbe REST API. */
export class WardrowbeClient {
  constructor(
    private readonly config: Config,
    private readonly tokens: TokenProvider,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, { body });
  }

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown },
  ): Promise<T> {
    const url = new URL(`${this.config.wardrowbeUrl}/api/v1${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const token = await this.tokens.getToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(opts.body);
    }

    const res = await this.fetchFn(url, init);
    const body = await parseJson(res);
    if (!res.ok) throw new WardrowbeApiError(res.status, describe(body, res));
    return body as T;
  }
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function describe(body: unknown, res: Response): string {
  const detail = (body as { detail?: unknown } | undefined)?.detail;
  if (typeof detail === "string") return detail;
  if (detail !== undefined) return JSON.stringify(detail).slice(0, 300);
  return res.statusText || "request failed";
}

/** Milliseconds until a JWT's exp claim, or undefined when it has none. Signature is not checked. */
function jwtTtlMs(jwt: string, now: () => number): number | undefined {
  const payload = jwt.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      exp?: number;
    };
    return typeof claims.exp === "number" ? claims.exp * 1000 - now() : undefined;
  } catch {
    return undefined;
  }
}
