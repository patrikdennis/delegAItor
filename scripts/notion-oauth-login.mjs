#!/usr/bin/env node
/**
 * One-shot helper to obtain a Notion OAuth access token for delegAItor,
 * for workspaces where an admin has disabled creating Internal
 * integrations / API-capability Personal Access Tokens, leaving OAuth
 * (a "public connection") as the only path.
 *
 * Prerequisite: create a public connection at
 * https://www.notion.so/my-integrations (or the newer Developer portal at
 * https://www.notion.so/developers/connections) with Authentication
 * method = OAuth, and a Redirect URI matching --redirect-uri below
 * (default http://localhost:3000/callback). Copy its OAuth Client ID and
 * Client Secret.
 *
 * Usage:
 *   node scripts/notion-oauth-login.mjs \
 *     --client-id <id> --client-secret <secret> \
 *     [--redirect-uri http://localhost:3000/callback] [--port 3000]
 *
 * Or via env vars: NOTION_OAUTH_CLIENT_ID, NOTION_OAUTH_CLIENT_SECRET.
 *
 * On success, prints the access token to export as NOTION_API_KEY. The
 * resulting token is used identically to an Internal-integration secret
 * or Personal Access Token by delegAItor's Notion adapter (all three are
 * just Bearer tokens to the Notion API) -- no other config changes needed.
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { URL } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    }
  }
  return out;
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, platform === "win32" ? ["", url] : [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // best-effort only; the user can still copy/paste the URL below
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const clientId = args["client-id"] ?? process.env.NOTION_OAUTH_CLIENT_ID;
  const clientSecret = args["client-secret"] ?? process.env.NOTION_OAUTH_CLIENT_SECRET;
  const port = Number(args["port"] ?? 3000);
  const redirectUri = args["redirect-uri"] ?? `http://localhost:${port}/callback`;
  const apiBaseUrl = args["api-base-url"] ?? "https://api.notion.com";

  if (!clientId || !clientSecret) {
    console.error(
      "Missing --client-id/--client-secret (or NOTION_OAUTH_CLIENT_ID/NOTION_OAUTH_CLIENT_SECRET).\n" +
        "Get these from your Notion connection's Configuration tab at https://www.notion.so/my-integrations.",
    );
    process.exit(1);
  }

  const authorizeUrl = new URL("/v1/oauth/authorize", apiBaseUrl);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("owner", "user");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (reqUrl.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const err = reqUrl.searchParams.get("error");
      const authCode = reqUrl.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        err
          ? `<h2>Notion authorization failed: ${err}</h2><p>You can close this tab.</p>`
          : `<h2>delegAItor: Notion connected \u2713</h2><p>You can close this tab and return to your terminal.</p>`,
      );
      server.close();
      if (err) reject(new Error(`Notion returned error: ${err}`));
      else if (!authCode) reject(new Error("No 'code' query param in callback"));
      else resolve(authCode);
    });
    server.listen(port, () => {
      console.log(`Waiting for Notion authorization on ${redirectUri} ...`);
      console.log(`If your browser doesn't open automatically, visit:\n  ${authorizeUrl.toString()}\n`);
      openBrowser(authorizeUrl.toString());
    });
    server.on("error", reject);
  });

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const tokenRes = await fetch(new URL("/v1/oauth/token", apiBaseUrl), {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ grant_type: "authorization_code", code, redirect_uri: redirectUri }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
  }
  const token = await tokenRes.json();

  console.log("\nSuccess! Authorized as:");
  console.log(`  workspace: ${token.workspace_name ?? "(unknown)"}`);
  console.log(`  owner:     ${token.owner?.user?.name ?? token.owner?.user?.id ?? "(unknown)"}\n`);
  console.log("Export this and use it exactly like any other NOTION_API_KEY:\n");
  console.log(`  export NOTION_API_KEY=${token.access_token}\n`);
}

main().catch((err) => {
  console.error(`\nnotion-oauth-login failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
