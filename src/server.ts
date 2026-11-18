import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { WardrowbeClient, TokenProvider, type SignInHooks } from "./client.js";
import { DEFAULT_LOGIN_PORT, runLogin } from "./login.js";
import { registerTools } from "./tools.js";
import { TokenStore } from "./token-store.js";
import { sharedUploads, type UploadStore } from "./uploads.js";

export const SERVER_NAME = "wardrowbe-mcp";
export const SERVER_VERSION = "0.2.0";

/**
 * Module-level, because the HTTP transport builds a server per request. Only one browser sign-in
 * runs at a time: concurrent callers share it, since the callback port can be bound only once.
 */
let pendingSignIn: Promise<string> | undefined;

/**
 * Sign-in for the OIDC path: the stored refresh token, and a browser sign-in when there is none.
 * The browser sign-in only runs on the first tool call that needs it, not at startup.
 */
function signInHooks(config: Config): SignInHooks {
  if (!config.oidc) return {};
  const oidc = config.oidc;
  return {
    store: config.tokenFile ? new TokenStore(config.tokenFile) : undefined,
    signIn: () => {
      pendingSignIn ??= runLogin({
        issuerUrl: oidc.issuerUrl,
        clientId: oidc.clientId,
        clientSecret: oidc.clientSecret,
        port: DEFAULT_LOGIN_PORT,
      })
        .then((result) => result.refreshToken)
        .finally(() => {
          pendingSignIn = undefined;
        });
      return pendingSignIn;
    },
  };
}

/** Builds an MCP server with all Wardrowbe tools registered against the configured instance. */
export function createServer(
  config: Config,
  fetchFn: typeof fetch = fetch,
  uploads: UploadStore = sharedUploads,
): McpServer {
  const tokens = new TokenProvider(config, fetchFn, Date.now, signInHooks(config));
  const client = new WardrowbeClient(config, tokens, fetchFn);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, client, uploads);
  return server;
}
