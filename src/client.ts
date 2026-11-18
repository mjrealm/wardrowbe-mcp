import type { Config } from "./config.js";
import type { TokenStore } from "./token-store.js";

export type FetchFn = typeof fetch;

/** How the OIDC path gets a refresh token when it has none: from disk, or from a browser sign-in. */
export interface SignInHooks {
  store?: TokenStore;
  /** Runs the browser sign-in and resolves with a refresh token. */
  signIn?: () => Promise<string>;
}

type RefreshResult = { ok: true; idToken: string } | { ok: false; status: number };

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
    private readonly hooks: SignInHooks = {},
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

    const first = await this.refresh(meta.token_endpoint, oidc, await this.currentRefreshToken(oidc));
    if (first.ok) return first.idToken;

    // The issuer rejected the token, so it has expired or been revoked. Sign in again once.
    // Server errors are not a sign of a bad token, so they are reported as they are.
    const rejected = first.status === 400 || first.status === 401;
    if (!rejected || !this.hooks.signIn) {
      throw new Error(
        `OIDC refresh failed (HTTP ${first.status}). The refresh token may be expired or revoked.`,
      );
    }
    const second = await this.refresh(meta.token_endpoint, oidc, await this.signIn(oidc));
    if (second.ok) return second.idToken;
    throw new Error(`OIDC refresh failed after signing in again (HTTP ${second.status}).`);
  }

  /** Current refresh token: the in-memory one, then the stored one, then a fresh browser sign-in. */
  private async currentRefreshToken(oidc: NonNullable<Config["oidc"]>): Promise<string> {
    if (this.refreshToken) return this.refreshToken;
    const stored = await this.hooks.store?.load(oidc.issuerUrl, oidc.clientId);
    if (stored) {
      this.refreshToken = stored;
      return stored;
    }
    return this.signIn(oidc);
  }

  /** Runs the browser sign-in and keeps the resulting refresh token. */
  private async signIn(oidc: NonNullable<Config["oidc"]>): Promise<string> {
    if (!this.hooks.signIn) {
      throw new Error("No refresh token is available. Set OIDC_REFRESH_TOKEN, or run `wardrowbe-mcp login`.");
    }
    const token = await this.hooks.signIn();
    await this.remember(oidc, token);
    return token;
  }

  private async refresh(
    tokenEndpoint: string,
    oidc: NonNullable<Config["oidc"]>,
    refreshToken: string,
  ): Promise<RefreshResult> {
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: oidc.clientId,
    });
    if (oidc.clientSecret) form.set("client_secret", oidc.clientSecret);

    const res = await this.fetchFn(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form,
    });
    const tokens = (await parseJson(res)) as
      | { id_token?: string; refresh_token?: string }
      | undefined;
    if (!res.ok || !tokens?.id_token) return { ok: false, status: res.status };

    // Some issuers rotate refresh tokens. Keep the newest one so the next run can use it.
    if (tokens.refresh_token) await this.remember(oidc, tokens.refresh_token);
    return { ok: true, idToken: tokens.id_token };
  }

  /** Keeps a refresh token in memory and in the store. A failed write is logged, not fatal. */
  private async remember(oidc: NonNullable<Config["oidc"]>, refreshToken: string): Promise<void> {
    this.refreshToken = refreshToken;
    const store = this.hooks.store;
    if (!store) return;
    try {
      await store.save({ issuerUrl: oidc.issuerUrl, clientId: oidc.clientId, refreshToken });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`wardrowbe-mcp: could not save the refresh token to ${store.path}: ${message}`);
    }
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

  /** Sends a multipart form, such as an item with its photo. The boundary header is set by fetch. */
  postForm<T>(path: string, form: FormData): Promise<T> {
    return this.request<T>("POST", path, { form });
  }

  private async request<T>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: unknown;
      form?: FormData;
    },
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
    if (opts.form) {
      init.body = opts.form;
    } else if (opts.body !== undefined) {
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
