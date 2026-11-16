export type Transport = "stdio" | "http";

export interface Config {
  wardrowbeUrl: string;
  /** Static access token for the Wardrowbe API (JWT). Optional when OIDC is configured. */
  staticToken?: string;
  oidc?: {
    issuerUrl: string;
    clientId: string;
    clientSecret?: string;
    refreshToken: string;
  };
  transport: Transport;
  host: string;
  port: number;
  /** Required for the http transport. Clients send it as a Bearer token. */
  apiKey?: string;
}

export class ConfigError extends Error {}

/** Parses config from environment variables. Pure, so it is easy to test. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const wardrowbeUrl = (env.WARDROWBE_URL ?? "").trim().replace(/\/+$/, "");
  if (!wardrowbeUrl) {
    throw new ConfigError("WARDROWBE_URL is required (e.g. https://wardrowbe.example.com)");
  }
  try {
    new URL(wardrowbeUrl);
  } catch {
    throw new ConfigError(`WARDROWBE_URL is not a valid URL: ${wardrowbeUrl}`);
  }

  const staticToken = env.WARDROWBE_TOKEN?.trim() || undefined;

  const oidcIssuer = env.OIDC_ISSUER_URL?.trim();
  const oidcClient = env.OIDC_CLIENT_ID?.trim();
  const oidcRefresh = env.OIDC_REFRESH_TOKEN?.trim();
  let oidc: Config["oidc"];
  if (oidcIssuer || oidcClient || oidcRefresh) {
    if (!oidcIssuer || !oidcClient || !oidcRefresh) {
      throw new ConfigError(
        "OIDC needs OIDC_ISSUER_URL, OIDC_CLIENT_ID and OIDC_REFRESH_TOKEN together",
      );
    }
    oidc = {
      issuerUrl: oidcIssuer.replace(/\/+$/, ""),
      clientId: oidcClient,
      clientSecret: env.OIDC_CLIENT_SECRET?.trim() || undefined,
      refreshToken: oidcRefresh,
    };
  }

  if (!staticToken && !oidc) {
    throw new ConfigError("Set WARDROWBE_TOKEN, or the OIDC_* variables to exchange a refresh token");
  }

  const transport = (env.MCP_TRANSPORT?.trim() || "stdio") as Transport;
  if (transport !== "stdio" && transport !== "http") {
    throw new ConfigError(`MCP_TRANSPORT must be "stdio" or "http", got "${transport}"`);
  }

  const port = Number(env.MCP_PORT ?? "8080");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`MCP_PORT must be a port number, got "${env.MCP_PORT}"`);
  }

  const apiKey = env.MCP_API_KEY?.trim() || undefined;
  if (transport === "http" && !apiKey) {
    throw new ConfigError("MCP_API_KEY is required for the http transport");
  }

  return {
    wardrowbeUrl,
    staticToken,
    oidc,
    transport,
    // Bind to loopback unless the caller opts in. Container deployments set MCP_BIND_HOST=0.0.0.0.
    host: env.MCP_BIND_HOST?.trim() || "127.0.0.1",
    port,
    apiKey,
  };
}
