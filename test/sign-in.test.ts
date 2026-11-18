import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { TokenProvider, type SignInHooks } from "../src/client.js";
import { TokenStore, defaultTokenFile } from "../src/token-store.js";

const BASE = "https://wardrowbe.example.com";
const ISSUER = "https://id.example.com";

function jwt(exp: number): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ sub: "u1", exp })}.sig`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function oidcConfig(refreshToken?: string): Config {
  return {
    wardrowbeUrl: BASE,
    transport: "stdio",
    host: "127.0.0.1",
    port: 8080,
    oidc: { issuerUrl: ISSUER, clientId: "wardrowbe", refreshToken },
  };
}

/**
 * Fake IdP and Wardrowbe. `acceptedRefresh` lists the refresh tokens the issuer will accept;
 * anything else gets a 400 invalid_grant, as a real issuer does for an expired token.
 */
function fakeServers(acceptedRefresh: string[], rotateTo?: string) {
  const refreshesSeen: string[] = [];
  const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return json({ token_endpoint: `${ISSUER}/api/oidc/token` });
    }
    if (url === `${ISSUER}/api/oidc/token`) {
      const refresh = new URLSearchParams(String(init?.body)).get("refresh_token") ?? "";
      refreshesSeen.push(refresh);
      if (!acceptedRefresh.includes(refresh)) return json({ error: "invalid_grant" }, 400);
      return json({ id_token: "idt", refresh_token: rotateTo });
    }
    if (url === `${BASE}/api/v1/auth/sync`) return json({ access_token: jwt(9_999_999_999) });
    throw new Error(`unexpected ${url}`);
  });
  return { fetchFn: fetchFn as unknown as typeof fetch, refreshesSeen };
}

describe("loadConfig with built-in sign-in", () => {
  it("accepts OIDC settings without a refresh token and defaults the token file", () => {
    const c = loadConfig({
      WARDROWBE_URL: BASE,
      OIDC_ISSUER_URL: ISSUER,
      OIDC_CLIENT_ID: "wardrowbe",
      HOME: "/home/tester",
      XDG_CONFIG_HOME: "/xdg",
    });
    expect(c.oidc).toMatchObject({ issuerUrl: ISSUER, clientId: "wardrowbe" });
    expect(c.oidc?.refreshToken).toBeUndefined();
    expect(c.tokenFile).toBe("/xdg/wardrowbe-mcp/refresh-token.json");
  });

  it("uses WARDROWBE_TOKEN_FILE when it is set", () => {
    const c = loadConfig({
      WARDROWBE_URL: BASE,
      OIDC_ISSUER_URL: ISSUER,
      OIDC_CLIENT_ID: "wardrowbe",
      WARDROWBE_TOKEN_FILE: "/secrets/rt.json",
    });
    expect(c.tokenFile).toBe("/secrets/rt.json");
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset", () => {
    expect(defaultTokenFile({ HOME: "/home/tester" } as NodeJS.ProcessEnv)).toMatch(
      /wardrowbe-mcp\/refresh-token\.json$/,
    );
  });

  it("has no token file when a static token is used", () => {
    const c = loadConfig({ WARDROWBE_URL: BASE, WARDROWBE_TOKEN: "t" });
    expect(c.tokenFile).toBeUndefined();
  });
});

describe("TokenStore", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wardrowbe-mcp-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns nothing when no file exists yet", async () => {
    const store = new TokenStore(join(dir, "missing.json"));
    expect(await store.load(ISSUER, "wardrowbe")).toBeUndefined();
  });

  it("round-trips the token and writes it owner-only", async () => {
    const path = join(dir, "nested", "refresh-token.json");
    const store = new TokenStore(path);
    await store.save({ issuerUrl: ISSUER, clientId: "wardrowbe", refreshToken: "rt-1" });

    expect(await store.load(ISSUER, "wardrowbe")).toBe("rt-1");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("ignores a token saved for another issuer or client", async () => {
    const store = new TokenStore(join(dir, "rt.json"));
    await store.save({ issuerUrl: ISSUER, clientId: "wardrowbe", refreshToken: "rt-1" });

    expect(await store.load("https://other.example.com", "wardrowbe")).toBeUndefined();
    expect(await store.load(ISSUER, "someone-else")).toBeUndefined();
  });

  it("treats a corrupt file as missing", async () => {
    const path = join(dir, "rt.json");
    writeFileSync(path, "{not json");
    expect(await new TokenStore(path).load(ISSUER, "wardrowbe")).toBeUndefined();
  });
});

describe("TokenProvider built-in sign-in", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wardrowbe-mcp-test-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function hooks(store: TokenStore, token = "signed-in-rt"): SignInHooks & { signIn: ReturnType<typeof vi.fn> } {
    return { store, signIn: vi.fn(async () => token) };
  }

  it("signs in on first use when there is no token, and remembers the result", async () => {
    const store = new TokenStore(join(dir, "rt.json"));
    const h = hooks(store);
    const { fetchFn, refreshesSeen } = fakeServers(["signed-in-rt"]);

    const tokens = new TokenProvider(oidcConfig(), fetchFn, Date.now, h);
    expect(await tokens.getToken()).toBe(jwt(9_999_999_999));
    expect(h.signIn).toHaveBeenCalledTimes(1);
    expect(refreshesSeen).toEqual(["signed-in-rt"]);
    expect(await store.load(ISSUER, "wardrowbe")).toBe("signed-in-rt");
  });

  it("does not open the browser again when a stored token exists", async () => {
    const store = new TokenStore(join(dir, "rt.json"));
    await store.save({ issuerUrl: ISSUER, clientId: "wardrowbe", refreshToken: "stored-rt" });
    const h = hooks(store);
    const { fetchFn, refreshesSeen } = fakeServers(["stored-rt"]);

    await new TokenProvider(oidcConfig(), fetchFn, Date.now, h).getToken();
    expect(h.signIn).not.toHaveBeenCalled();
    expect(refreshesSeen).toEqual(["stored-rt"]);
  });

  it("uses an explicit refresh token before the stored one", async () => {
    const store = new TokenStore(join(dir, "rt.json"));
    await store.save({ issuerUrl: ISSUER, clientId: "wardrowbe", refreshToken: "stored-rt" });
    const h = hooks(store);
    const { fetchFn, refreshesSeen } = fakeServers(["env-rt"]);

    await new TokenProvider(oidcConfig("env-rt"), fetchFn, Date.now, h).getToken();
    expect(refreshesSeen).toEqual(["env-rt"]);
    expect(h.signIn).not.toHaveBeenCalled();
  });

  it("stores a rotated refresh token so the next run can use it", async () => {
    const store = new TokenStore(join(dir, "rt.json"));
    await store.save({ issuerUrl: ISSUER, clientId: "wardrowbe", refreshToken: "rt-old" });
    const { fetchFn } = fakeServers(["rt-old"], "rt-new");

    await new TokenProvider(oidcConfig(), fetchFn, Date.now, hooks(store)).getToken();
    expect(await store.load(ISSUER, "wardrowbe")).toBe("rt-new");
  });

  it("signs in again once when the stored token has been revoked", async () => {
    const store = new TokenStore(join(dir, "rt.json"));
    await store.save({ issuerUrl: ISSUER, clientId: "wardrowbe", refreshToken: "revoked-rt" });
    const h = hooks(store, "fresh-rt");
    const { fetchFn, refreshesSeen } = fakeServers(["fresh-rt"]);

    expect(await new TokenProvider(oidcConfig(), fetchFn, Date.now, h).getToken()).toBe(
      jwt(9_999_999_999),
    );
    expect(refreshesSeen).toEqual(["revoked-rt", "fresh-rt"]);
    expect(h.signIn).toHaveBeenCalledTimes(1);
    expect(await store.load(ISSUER, "wardrowbe")).toBe("fresh-rt");
  });

  it("gives up after one re-sign-in if the new token is refused too", async () => {
    const h = hooks(new TokenStore(join(dir, "rt.json")), "also-bad");
    const { fetchFn } = fakeServers([]);

    await expect(
      new TokenProvider(oidcConfig("bad"), fetchFn, Date.now, h).getToken(),
    ).rejects.toThrow(/after signing in again/);
    expect(h.signIn).toHaveBeenCalledTimes(1);
  });

  it("explains what to do when there is no token and no sign-in is possible", async () => {
    const { fetchFn } = fakeServers([]);
    await expect(new TokenProvider(oidcConfig(), fetchFn).getToken()).rejects.toThrow(
      /OIDC_REFRESH_TOKEN|wardrowbe-mcp login/,
    );
  });
});
