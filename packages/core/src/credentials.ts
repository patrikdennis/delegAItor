import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { delegaitorHome } from "./paths.js";

/**
 * Credential names delegAItor knows how to use. These double as the
 * environment variable names, which always take precedence over the file.
 */
export const CREDENTIAL_NAMES = [
  "NOTION_API_KEY",
  "LINEAR_API_KEY",
  "JIRA_BASE_URL",
  "JIRA_EMAIL",
  "JIRA_API_TOKEN",
] as const;
export type CredentialName = (typeof CREDENTIAL_NAMES)[number];

export function credentialsPath(): string {
  return join(delegaitorHome(), "credentials.json");
}

function readStore(): Partial<Record<CredentialName, string>> {
  const path = credentialsPath();
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Resolves a credential from the environment first, then from
 * `$DELEGAITOR_HOME/credentials.json`. The file fallback matters because
 * dispatched agent sessions (and the MCP servers they spawn) start in fresh
 * cmux shells that don't inherit variables you `export`ed in the terminal
 * you ran `delegaitor dispatch` from.
 */
export function getCredential(name: CredentialName): string | undefined {
  return process.env[name] || readStore()[name] || undefined;
}

export function setCredential(name: CredentialName, value: string): void {
  const store = readStore();
  store[name] = value;
  const path = credentialsPath();
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  chmodSync(path, 0o600);
}

export function removeCredential(name: CredentialName): boolean {
  const store = readStore();
  if (!(name in store)) return false;
  delete store[name];
  writeFileSync(credentialsPath(), JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  return true;
}

/** Which credentials are available and where each comes from (never the values). */
export function listCredentials(): { name: CredentialName; source: "env" | "file" | null }[] {
  const store = readStore();
  return CREDENTIAL_NAMES.map((name) => ({
    name,
    source: process.env[name] ? "env" : store[name] ? "file" : null,
  }));
}

export function isCredentialName(name: string): name is CredentialName {
  return (CREDENTIAL_NAMES as readonly string[]).includes(name);
}
