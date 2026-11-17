import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** Creates a PKCE verifier and its S256 challenge (RFC 7636). */
export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: challengeFor(verifier) };
}

/** S256 code challenge for a verifier. */
export function challengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export interface LoginOptions {
  issuerUrl: string;
  clientId: string;
  clientSecret?: string;
  port: number;
  fetchFn?: typeof fetch;
  /** Opens the authorize URL. Defaults to the platform browser opener. Failures are ignored. */
  openBrowser?: (url: string) => void;
  /** Receives human-readable progress. Defaults to stderr. */
  log?: (message: string) => void;
  /** How long to wait for the browser sign-in to come back. */
  timeoutMs?: number;
}

export interface LoginResult {
  refreshToken: string;
  idToken?: string;
}

const CALLBACK_PATH = "/callback";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * Runs the one-time sign-in: opens the browser at the issuer's authorize endpoint with PKCE and
 * `offline_access`, catches the redirect on localhost, and exchanges the code for a refresh token.
 */
export async function runLogin(opts: LoginOptions): Promise<LoginResult> {
  const fetchFn = opts.fetchFn ?? fetch;
  const log = opts.log ?? ((m: string) => console.error(m));
  const issuer = opts.issuerUrl.replace(/\/+$/, "");

  const discovery = await fetchFn(`${issuer}/.well-known/openid-configuration`, {
    headers: { Accept: "application/json" },
  });
  const meta = (await discovery.json().catch(() => undefined)) as
    | { authorization_endpoint?: string; token_endpoint?: string }
    | undefined;
  if (!discovery.ok || !meta?.authorization_endpoint || !meta.token_endpoint) {
    throw new Error(`OIDC discovery failed at ${issuer} (HTTP ${discovery.status})`);
  }

  const { verifier, challenge } = createPkce();
  const state = randomBytes(16).toString("base64url");
  const redirectUri = `http://localhost:${opts.port}${CALLBACK_PATH}`;

  const authorizeUrl = new URL(meta.authorization_endpoint);
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
  }).toString();

  const code = await waitForCode({
    port: opts.port,
    state,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    onListening: () => {
      log(`Sign in with your identity provider. If no browser opens, visit:\n  ${authorizeUrl}`);
      (opts.openBrowser ?? openInBrowser)(authorizeUrl.toString());
    },
  });

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: opts.clientId,
    code_verifier: verifier,
  });
  if (opts.clientSecret) form.set("client_secret", opts.clientSecret);

  const res = await fetchFn(meta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: form,
  });
  const tokens = (await res.json().catch(() => undefined)) as
    | { refresh_token?: string; id_token?: string; error?: string }
    | undefined;
  if (!res.ok || !tokens) {
    throw new Error(`Token exchange failed (HTTP ${res.status}${tokens?.error ? `: ${tokens.error}` : ""})`);
  }
  if (!tokens.refresh_token) {
    throw new Error(
      "The identity provider returned no refresh_token. Allow the offline_access scope for this client and sign in again.",
    );
  }
  return { refreshToken: tokens.refresh_token, idToken: tokens.id_token };
}

interface WaitOptions {
  port: number;
  state: string;
  timeoutMs: number;
  onListening: () => void;
}

/** Starts a localhost listener and resolves with the authorization code from the redirect. */
function waitForCode(opts: WaitOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    let server: Server | undefined;
    const timer = setTimeout(() => {
      server?.close();
      reject(new Error("Timed out waiting for the browser sign-in"));
    }, opts.timeoutMs);

    server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end("not found");
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");

      if (error) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end(`Sign-in failed: ${error}`);
        finish(new Error(`Sign-in failed: ${error}`));
        return;
      }
      if (!code || state !== opts.state) {
        res.writeHead(400, { "Content-Type": "text/plain" }).end("Invalid sign-in response");
        finish(new Error("Sign-in response had a missing code or a mismatched state"));
        return;
      }
      res
        .writeHead(200, { "Content-Type": "text/html" })
        .end("<h1>Signed in</h1><p>You can close this tab and return to the terminal.</p>");
      finish(undefined, code);
    });

    function finish(err: Error | undefined, code?: string): void {
      clearTimeout(timer);
      server?.close();
      if (err) reject(err);
      else resolve(code as string);
    }

    server.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    server.listen(opts.port, "127.0.0.1", () => opts.onListening());
  });
}

/** Opens a URL in the default browser without blocking. Errors are ignored; the URL is printed too. */
function openInBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The URL is already printed for the user to open by hand.
  }
}
