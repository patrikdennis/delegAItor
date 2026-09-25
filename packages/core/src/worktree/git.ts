import { execa } from "execa";
import { join } from "node:path";
import { sanitize, repoWorktreesDir } from "../paths.js";
import type { PlannedTicket } from "../types.js";

export function branchName(ticketId: string, title: string): string {
  const slug = sanitize(title.toLowerCase()).slice(0, 40).replace(/-+$/g, "");
  return `agent/${sanitize(ticketId)}-${slug}`;
}

export interface CreateWorktreeOptions {
  repoPath: string;
  repoId: string;
  ticketId: string;
  branch: string;
  baseRef: string;
}

/**
 * Creates a new git worktree + branch off `baseRef` for a single ticket.
 * The worktree lives under $DELEGAITOR_HOME, outside the source repo, so
 * cleanup never touches the developer's primary checkout.
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<string> {
  const dir = join(repoWorktreesDir(opts.repoId), sanitize(opts.ticketId));
  await execa("git", ["fetch", "origin", opts.baseRef], { cwd: opts.repoPath }).catch(() => {
    /* offline or base ref only exists locally; fall through to local ref */
  });
  await execa(
    "git",
    ["worktree", "add", "-b", opts.branch, dir, opts.baseRef],
    { cwd: opts.repoPath },
  );
  return dir;
}

export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await execa("git", ["worktree", "remove", "--force", worktreePath], { cwd: repoPath });
}

/** True when the worktree has no uncommitted changes (tracked or untracked). */
export async function isWorktreeClean(worktreePath: string): Promise<boolean> {
  const { stdout } = await execa("git", ["status", "--porcelain"], { cwd: worktreePath });
  return stdout.trim().length === 0;
}

/**
 * True when `branch` is fully merged into `baseRef`, i.e. it's an ancestor
 * of it — meaning deleting the branch would not lose any commits.
 */
export async function isBranchMerged(
  repoPath: string,
  branch: string,
  baseRef: string,
): Promise<boolean> {
  try {
    await execa("git", ["merge-base", "--is-ancestor", branch, baseRef], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

export async function deleteLocalBranch(
  repoPath: string,
  branch: string,
  force = false,
): Promise<void> {
  await execa("git", ["branch", force ? "-D" : "-d", branch], { cwd: repoPath });
}

export async function remoteBranchExists(repoPath: string, branch: string): Promise<boolean> {
  const { stdout } = await execa(
    "git",
    ["ls-remote", "--heads", "origin", branch],
    { cwd: repoPath },
  ).catch(() => ({ stdout: "" }));
  return stdout.trim().length > 0;
}

export async function deleteRemoteBranch(repoPath: string, branch: string): Promise<void> {
  await execa("git", ["push", "origin", "--delete", branch], { cwd: repoPath });
}

export async function listChangedFiles(worktreePath: string, baseRef: string): Promise<string[]> {
  const { stdout } = await execa("git", ["diff", "--name-only", baseRef], {
    cwd: worktreePath,
  });
  return stdout.split("\n").filter(Boolean);
}

/**
 * Best-effort static conflict detection: two tickets in the same repo that
 * mention overlapping path fragments (from ticket body/title) are flagged
 * so the plan surfaces them before dispatch, even though real conflicts can
 * only be confirmed once diffs exist.
 */
export function detectLikelyConflicts(tickets: PlannedTicket[]): Map<string, string[]> {
  const conflicts = new Map<string, string[]>();
  const pathRe = /[\w./-]+\.\w{1,8}/g;

  const pathsByTicket = new Map<string, Set<string>>();
  for (const t of tickets) {
    const text = `${t.title}\n${t.body ?? ""}`;
    const paths = new Set((text.match(pathRe) ?? []).filter((p) => p.includes("/")));
    pathsByTicket.set(t.id, paths);
  }

  for (const a of tickets) {
    for (const b of tickets) {
      if (a.id >= b.id || a.repoId !== b.repoId) continue;
      const shared = [...(pathsByTicket.get(a.id) ?? [])].filter((p) =>
        pathsByTicket.get(b.id)?.has(p),
      );
      if (shared.length) {
        conflicts.set(a.id, [...(conflicts.get(a.id) ?? []), b.id]);
        conflicts.set(b.id, [...(conflicts.get(b.id) ?? []), a.id]);
      }
    }
  }
  return conflicts;
}
