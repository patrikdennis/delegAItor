import { execa } from "execa";
import { lstatSync, mkdirSync, readdirSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { delegaitorHome, sanitize, repoWorktreesDir } from "../paths.js";
import type { PlannedTicket } from "../types.js";

export const DEFAULT_BRANCH_PREFIX = "feature/";

export function branchName(
  ticketId: string,
  title: string,
  prefix: string = DEFAULT_BRANCH_PREFIX,
  repoAlias?: string,
): string {
  const disambiguator = repoAlias ? `-${sanitize(repoAlias)}` : "";
  // Only [a-z0-9-]: dots, spaces and punctuation from titles would give names git rejects (e.g. a trailing ".").
  const slug = transliterate(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, Math.max(1, 40 - disambiguator.length))
    .replace(/-+$/, "");
  return `${prefix}${sanitize(ticketId)}${slug ? `-${slug}` : ""}${disambiguator}`;
}

// Letters that Unicode normalization doesn't decompose into base + accent.
const NON_DECOMPOSING: Record<string, string> = {
  ß: "ss", æ: "ae", Æ: "AE", ø: "o", Ø: "O", đ: "d", Đ: "D", ł: "l", Ł: "L", þ: "th", Þ: "TH",
};

/** Maps accented letters to plain ASCII (följer → foljer, så → sa) so titles stay readable in branch names. */
export function transliterate(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[ßæÆøØđĐłŁþÞ]/g, (ch) => NON_DECOMPOSING[ch] ?? ch);
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

export interface TicketWorkspaceRepo {
  alias: string;
  worktreePath: string;
}

export function prepareTicketWorkspace(workspacePath: string, repos: TicketWorkspaceRepo[]): void {
  assertManagedWorkspace(workspacePath);
  try {
    const workspaceStat = lstatSync(workspacePath);
    if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
      throw new Error(`Refusing to use non-directory workspace path "${workspacePath}".`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    mkdirSync(workspacePath);
  }
  const created: string[] = [];
  try {
    for (const repo of repos) {
      const linkPath = join(workspacePath, sanitize(repo.alias));
      try {
        const stat = lstatSync(linkPath);
        if (!stat.isSymbolicLink() || resolve(workspacePath, readlinkSync(linkPath)) !== resolve(repo.worktreePath)) {
          throw new Error(`Refusing to replace unmanaged workspace entry "${linkPath}".`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        symlinkSync(repo.worktreePath, linkPath, "dir");
        created.push(linkPath);
      }
    }
  } catch (error) {
    for (const path of created.reverse()) unlinkSync(path);
    throw error;
  }
}

export function removeTicketWorkspace(workspacePath: string, repos: TicketWorkspaceRepo[]): void {
  assertManagedWorkspace(workspacePath);
  try {
    const workspaceStat = lstatSync(workspacePath);
    if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) {
      throw new Error(`Refusing to remove non-directory workspace path "${workspacePath}".`);
    }
    for (const repo of repos) {
      const linkPath = join(workspacePath, sanitize(repo.alias));
      try {
        const stat = lstatSync(linkPath);
        if (!stat.isSymbolicLink() || resolve(workspacePath, readlinkSync(linkPath)) !== resolve(repo.worktreePath)) {
          throw new Error(`Refusing to remove unmanaged workspace entry "${linkPath}".`);
        }
        unlinkSync(linkPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    if (readdirSync(workspacePath).length === 0) rmdirSync(workspacePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new Error(`Could not safely clean ticket workspace "${workspacePath}": ${(error as Error).message}`);
  }
}

function assertManagedWorkspace(workspacePath: string): void {
  const root = resolve(delegaitorHome(), "workspaces");
  mkdirSync(root, { recursive: true });
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Refusing to use non-directory workspaces root "${root}".`);
  }
  const target = resolve(workspacePath);
  if (!isAbsolute(root) || resolve(target, "..") !== root || target === root) {
    throw new Error(`Refusing to use workspace outside the managed workspaces directory: "${workspacePath}".`);
  }
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
    pathsByTicket.set(t.unitId, paths);
  }

  for (const a of tickets) {
    for (const b of tickets) {
      if (a.unitId >= b.unitId || a.repoId !== b.repoId) continue;
      const shared = [...(pathsByTicket.get(a.unitId) ?? [])].filter((p) =>
        pathsByTicket.get(b.unitId)?.has(p),
      );
      if (shared.length) {
        conflicts.set(a.unitId, [...(conflicts.get(a.unitId) ?? []), b.unitId]);
        conflicts.set(b.unitId, [...(conflicts.get(b.unitId) ?? []), a.unitId]);
      }
    }
  }
  return conflicts;
}
