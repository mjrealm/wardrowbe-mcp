#!/usr/bin/env node
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { createMcpHttpServer } from "./http.js";
import { runLogin } from "./login.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "./server.js";

const USAGE = `Usage:
  wardrowbe-mcp                 Run the MCP server (stdio, or http if MCP_TRANSPORT=http)
  wardrowbe-mcp login [options] One-time sign-in. Prints a refresh token to stdout, or to --out.

Login options (each can also come from the environment):
  --issuer <url>          OIDC issuer, e.g. https://pocket.example.com   (OIDC_ISSUER_URL)
  --client-id <id>        OIDC client ID                                  (OIDC_CLIENT_ID)
  --client-secret <s>     Only for confidential clients. Prefer the env var (OIDC_CLIENT_SECRET)
                          so the secret stays out of shell history.
  --out <file>            Write the token to this file (owner-only) instead of stdout.
  --port <n>              Localhost port for the redirect. Default 8765.
`;

async function login(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      issuer: { type: "string" },
      "client-id": { type: "string" },
      "client-secret": { type: "string" },
      port: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });
  if (values.help) {
    process.stderr.write(USAGE);
    return;
  }

  const issuer = values.issuer ?? process.env.OIDC_ISSUER_URL;
  const clientId = values["client-id"] ?? process.env.OIDC_CLIENT_ID;
  const clientSecret = values["client-secret"] ?? process.env.OIDC_CLIENT_SECRET;
  if (!issuer || !clientId) {
    throw new ConfigError("login needs --issuer and --client-id (or OIDC_ISSUER_URL and OIDC_CLIENT_ID)");
  }
  const port = Number(values.port ?? "8765");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`--port must be a port number, got "${values.port}"`);
  }

  const result = await runLogin({ issuerUrl: issuer, clientId, clientSecret, port });

  const secretNote = clientSecret ? "  OIDC_CLIENT_SECRET=<the client secret>" : null;
  const setFor = [
    `  OIDC_ISSUER_URL=${issuer}`,
    `  OIDC_CLIENT_ID=${clientId}`,
    ...(secretNote ? [secretNote] : []),
    "  OIDC_REFRESH_TOKEN=<the token>",
  ];

  if (values.out) {
    // --out writes the token to an owner-only file, so no shell redirect is needed.
    await mkdir(dirname(values.out), { recursive: true, mode: 0o700 });
    await writeFile(values.out, `${result.refreshToken}\n`, { mode: 0o600 });
    await chmod(values.out, 0o600);
    process.stderr.write(
      [
        "",
        `Refresh token written to ${values.out} (owner-only, not printed).`,
        "Set these for the MCP server:",
        ...setFor,
        "Then delete the file.",
        "",
      ].join("\n"),
    );
    return;
  }

  // The token goes to stdout alone, so `wardrowbe-mcp login > token.txt` captures just the value.
  process.stdout.write(`${result.refreshToken}\n`);
  process.stderr.write(
    [
      "",
      "Refresh token printed to stdout. Store it as a secret, not in the repo.",
      "Set these for the MCP server:",
      ...setFor,
      "",
    ].join("\n"),
  );
}

async function serve(): Promise<void> {
  const config = loadConfig(process.env);

  if (config.transport === "http") {
    const httpServer = createMcpHttpServer(config);
    httpServer.listen(config.port, config.host, () => {
      console.error(
        `${SERVER_NAME} ${SERVER_VERSION} listening on http://${config.host}:${config.port}/mcp`,
      );
    });
    return;
  }

  // stdio: stdout carries MCP frames, so diagnostics go to stderr only.
  const server = createServer(config);
  await server.connect(new StdioServerTransport());
  console.error(`${SERVER_NAME} ${SERVER_VERSION} running on stdio`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (command === "login") {
    await login(rest);
    return;
  }
  if (command === "--help" || command === "-h") {
    process.stderr.write(USAGE);
    return;
  }
  await serve();
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`${SERVER_NAME}: ${message}`);
  process.exit(err instanceof ConfigError ? 2 : 1);
});
