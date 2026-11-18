import { describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigError, loadConfig, type Config } from "../src/config.js";
import { TokenProvider, WardrowbeApiError, WardrowbeClient } from "../src/client.js";
import { isAuthorized } from "../src/http.js";
import { challengeFor, runLogin } from "../src/login.js";
import { createServer } from "../src/server.js";

const BASE = "https://wardrowbe.example.com";

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

function staticConfig(overrides: Partial<Config> = {}): Config {
  return {
    wardrowbeUrl: BASE,
    staticToken: "static-token",
    transport: "stdio",
    host: "127.0.0.1",
    port: 8080,
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("requires WARDROWBE_URL", () => {
    expect(() => loadConfig({ WARDROWBE_TOKEN: "t" })).toThrow(ConfigError);
  });

  it("requires a token or OIDC settings", () => {
    expect(() => loadConfig({ WARDROWBE_URL: BASE })).toThrow(/WARDROWBE_TOKEN/);
  });

  it("rejects OIDC settings without an issuer or client ID", () => {
    expect(() =>
      loadConfig({ WARDROWBE_URL: BASE, OIDC_ISSUER_URL: "https://id.example.com" }),
    ).toThrow(/OIDC_CLIENT_ID/);
    expect(() =>
      loadConfig({ WARDROWBE_URL: BASE, OIDC_CLIENT_ID: "wardrowbe", OIDC_REFRESH_TOKEN: "rt" }),
    ).toThrow(/OIDC_ISSUER_URL/);
  });

  it("defaults to stdio on loopback and strips trailing slashes", () => {
    const c = loadConfig({ WARDROWBE_URL: `${BASE}//`, WARDROWBE_TOKEN: "t" });
    expect(c.wardrowbeUrl).toBe(BASE);
    expect(c.transport).toBe("stdio");
    expect(c.host).toBe("127.0.0.1");
  });

  it("requires MCP_API_KEY for the http transport", () => {
    expect(() =>
      loadConfig({ WARDROWBE_URL: BASE, WARDROWBE_TOKEN: "t", MCP_TRANSPORT: "http" }),
    ).toThrow(/MCP_API_KEY/);
  });

  it("rejects an unknown transport and a bad port", () => {
    expect(() =>
      loadConfig({ WARDROWBE_URL: BASE, WARDROWBE_TOKEN: "t", MCP_TRANSPORT: "sse" }),
    ).toThrow(/MCP_TRANSPORT/);
    expect(() =>
      loadConfig({ WARDROWBE_URL: BASE, WARDROWBE_TOKEN: "t", MCP_PORT: "99999" }),
    ).toThrow(/MCP_PORT/);
  });
});

describe("isAuthorized", () => {
  it("accepts only the exact Bearer key", () => {
    expect(isAuthorized("Bearer secret-key", "secret-key")).toBe(true);
    expect(isAuthorized("Bearer secret-kex", "secret-key")).toBe(false);
    expect(isAuthorized("Bearer secret", "secret-key")).toBe(false);
    expect(isAuthorized("Basic secret-key", "secret-key")).toBe(false);
    expect(isAuthorized(undefined, "secret-key")).toBe(false);
  });
});

describe("TokenProvider", () => {
  it("returns a static token without any network call", async () => {
    const fetchFn = vi.fn();
    const tokens = new TokenProvider(staticConfig(), fetchFn as unknown as typeof fetch);
    expect(await tokens.getToken()).toBe("static-token");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("exchanges OIDC refresh token for a Wardrowbe JWT and caches it", async () => {
    let now = 1_000_000;
    const exp = Math.floor(now / 1000) + 3600;
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return json({ token_endpoint: "https://id.example.com/token" });
      }
      if (url === "https://id.example.com/token") return json({ id_token: "idt" });
      if (url === `${BASE}/api/v1/auth/sync`) return json({ access_token: jwt(exp) });
      throw new Error(`unexpected ${url}`);
    });
    const config = staticConfig({
      staticToken: undefined,
      oidc: {
        issuerUrl: "https://id.example.com",
        clientId: "wardrowbe",
        refreshToken: "rt",
      },
    });
    const tokens = new TokenProvider(config, fetchFn as unknown as typeof fetch, () => now);

    expect(await tokens.getToken()).toBe(jwt(exp));
    expect(await tokens.getToken()).toBe(jwt(exp));
    // Discovery, token refresh and sync happen once; the second call is served from cache.
    expect(fetchFn).toHaveBeenCalledTimes(3);

    // Past the expiry margin, the exchange runs again.
    now += (3600 - 30) * 1000;
    const freshExp = Math.floor(now / 1000) + 3600;
    fetchFn.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return json({ token_endpoint: "https://id.example.com/token" });
      }
      if (url === "https://id.example.com/token") return json({ id_token: "idt2" });
      return json({ access_token: jwt(freshExp) });
    });
    expect(await tokens.getToken()).toBe(jwt(freshExp));
  });

  it("reports an expired or revoked refresh token clearly", async () => {
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return json({ token_endpoint: "https://id.example.com/token" });
      }
      return json({ error: "invalid_grant" }, 400);
    });
    const config = staticConfig({
      staticToken: undefined,
      oidc: { issuerUrl: "https://id.example.com", clientId: "w", refreshToken: "old" },
    });
    const tokens = new TokenProvider(config, fetchFn as unknown as typeof fetch);
    await expect(tokens.getToken()).rejects.toThrow(/refresh token may be expired/);
  });
});

describe("WardrowbeClient", () => {
  it("maps API errors to WardrowbeApiError with the server's detail", async () => {
    const fetchFn = vi.fn(async () => json({ detail: "Item not found" }, 404));
    const config = staticConfig();
    const client = new WardrowbeClient(
      config,
      new TokenProvider(config),
      fetchFn as unknown as typeof fetch,
    );
    const err = await client.get("/items/x").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WardrowbeApiError);
    expect((err as WardrowbeApiError).status).toBe(404);
    expect((err as WardrowbeApiError).message).toContain("Item not found");
  });

  it("drops undefined query params and sends the bearer token", async () => {
    const fetchFn = vi.fn(async () => json({ items: [] }));
    const config = staticConfig();
    const client = new WardrowbeClient(
      config,
      new TokenProvider(config),
      fetchFn as unknown as typeof fetch,
    );
    await client.get("/items", { type: "top", favorite: undefined, page: 2 });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(`${BASE}/api/v1/items?type=top&page=2`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer static-token");
  });
});

describe("MCP tools end to end", () => {
  it("lists the Wardrowbe tools and runs list_items against the API", async () => {
    const fetchFn = vi.fn(async () => json({ items: [{ id: "i1", name: "Blue shirt" }] }));
    const server = createServer(staticConfig(), fetchFn as unknown as typeof fetch);
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        "accept_outfit",
        "add_item",
        "get_analytics",
        "get_item",
        "list_items",
        "log_wash",
        "log_wear",
        "reject_outfit",
        "suggest_outfit",
      ].sort(),
    );

    const result = await client.callTool({ name: "list_items", arguments: { type: "top" } });
    expect(result.isError).toBeFalsy();
    const text = (result.content as { text: string }[])[0].text;
    expect(text).toContain("Blue shirt");
  });

  it("returns API failures as tool errors instead of throwing", async () => {
    const fetchFn = vi.fn(async () => json({ detail: "Outfit not found" }, 404));
    const server = createServer(staticConfig(), fetchFn as unknown as typeof fetch);
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);

    const result = await client.callTool({
      name: "accept_outfit",
      arguments: { outfit_id: "00000000-0000-4000-8000-000000000000" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("Outfit not found");
  });

  it("rejects bad tool input before calling the API", async () => {
    const fetchFn = vi.fn();
    const server = createServer(staticConfig(), fetchFn as unknown as typeof fetch);
    const client = new Client({ name: "test", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);

    const result = await client.callTool({
      name: "get_item",
      arguments: { item_id: "not-a-uuid" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as { text: string }[])[0].text).toContain("Invalid UUID");
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("login", () => {
  it("derives the S256 challenge from the RFC 7636 example", () => {
    expect(challengeFor("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("completes the browser sign-in and returns the refresh token", async () => {
    const issuer = "https://id.example.com";
    const fetchFn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return json({
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/api/oidc/token`,
        });
      }
      if (url === `${issuer}/api/oidc/token`) {
        const form = new URLSearchParams(String(init?.body));
        expect(form.get("grant_type")).toBe("authorization_code");
        expect(form.get("code")).toBe("the-code");
        expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,}$/);
        return json({ refresh_token: "rt-123", id_token: "idt" });
      }
      throw new Error(`unexpected ${url}`);
    });

    let authorizeUrl = "";
    const resultPromise = runLogin({
      issuerUrl: issuer,
      clientId: "wardrowbe",
      port: 18765,
      fetchFn: fetchFn as unknown as typeof fetch,
      openBrowser: (url) => {
        authorizeUrl = url;
      },
      log: () => {},
    });

    // Wait for the browser step, then play the browser: redirect back with the code and state.
    resultPromise.catch(() => {});
    await vi.waitFor(() => expect(authorizeUrl).not.toBe(""));
    const authorize = new URL(authorizeUrl);
    expect(authorize.searchParams.get("scope")).toContain("offline_access");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    const state = authorize.searchParams.get("state");
    const callback = await fetch(
      `http://127.0.0.1:18765/callback?code=the-code&state=${encodeURIComponent(state ?? "")}`,
    );
    expect(callback.status).toBe(200);

    await expect(resultPromise).resolves.toEqual({ refreshToken: "rt-123", idToken: "idt" });
  });

  it("rejects a callback whose state does not match", async () => {
    const issuer = "https://id.example.com";
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return json({ authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/t` });
      }
      throw new Error(`unexpected ${url}`);
    });

    let authorizeUrl = "";
    const resultPromise = runLogin({
      issuerUrl: issuer,
      clientId: "wardrowbe",
      port: 18766,
      fetchFn: fetchFn as unknown as typeof fetch,
      openBrowser: (url) => {
        authorizeUrl = url;
      },
      log: () => {},
    });
    resultPromise.catch(() => {});
    await vi.waitFor(() => expect(authorizeUrl).not.toBe(""));
    await fetch("http://127.0.0.1:18766/callback?code=x&state=wrong");
    await expect(resultPromise).rejects.toThrow(/mismatched state/);
  });

  it("explains when the provider returns no refresh token", async () => {
    const issuer = "https://id.example.com";
    const fetchFn = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/.well-known/openid-configuration")) {
        return json({ authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/t` });
      }
      return json({ id_token: "idt" });
    });

    let authorizeUrl = "";
    const resultPromise = runLogin({
      issuerUrl: issuer,
      clientId: "wardrowbe",
      port: 18767,
      fetchFn: fetchFn as unknown as typeof fetch,
      openBrowser: (url) => {
        authorizeUrl = url;
      },
      log: () => {},
    });
    resultPromise.catch(() => {});
    await vi.waitFor(() => expect(authorizeUrl).not.toBe(""));
    const state = new URL(authorizeUrl).searchParams.get("state") ?? "";
    await fetch(`http://127.0.0.1:18767/callback?code=c&state=${encodeURIComponent(state)}`);
    await expect(resultPromise).rejects.toThrow(/offline_access/);
  });
});
