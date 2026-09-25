import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/**
 * All delegAItor state lives under $DELEGAITOR_HOME (default ~/.delegaitor),
 * separate from any managed repository so it survives worktree cleanup.
 */
export function delegaitorHome(): string {
  const home = process.env.DELEGAITOR_HOME ?? join(homedir(), ".delegaitor");
  mkdirSync(home, { recursive: true });
  return home;
}

export function dbPath(): string {
  return join(delegaitorHome(), "state.sqlite");
}

export function repoWorktreesDir(repoId: string): string {
  const dir = join(delegaitorHome(), "worktrees", sanitize(repoId));
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function promptsDir(runId: string): string {
  const dir = join(delegaitorHome(), "runs", sanitize(runId), "prompts");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function sanitize(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}
