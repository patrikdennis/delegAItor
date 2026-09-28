import { existsSync } from "node:fs";
import { execa } from "execa";
import { completeSession } from "./orchestrator.js";
import { currentBranch, findPullRequest, findSession, git, type PullRequestInfo } from "./sessions.js";
import { isWorktreeClean } from "./worktree/git.js";
import type { BoardStatusResult } from "./tickets/board-status.js";
import type { BranchNaming } from "./types.js";
import { getDb } from "./db.js";

export interface ShipTicketOptions {
  /** PR title. Defaults to the ticket title. */
  title?: string;
  /** PR description. Defaults to the list of commits. A link to the ticket is always appended. */
  body?: string;
  draft?: boolean;
  /** Mark the session ready_for_review (moving the board card) once the PR exists. Default true. */
  markReady?: boolean;
  dryRun?: boolean;
}

export interface ShipTicketReport {
  ticketId: string;
  sessionId: string;
  branch: string;
  baseRef: string;
  commits: string[];
  pushed: "pushed" | "up to date" | "would push";
  pullRequest?: PullRequestInfo & { created: boolean };
  pullRequestError?: string;
  boardStatus?: BoardStatusResult;
  warnings: string[];
  dryRun: boolean;
}

/**
 * Ships a ticket's branch: pushes it and opens a pull request that links
 * back to the ticket (or reuses the open one), then marks the session
 * ready_for_review so the board card moves. Refuses with uncommitted
 * changes or when there's nothing to ship. Never force-pushes.
 */
export async function shipTicket(ref: string, opts: ShipTicketOptions = {}): Promise<ShipTicketReport> {
  const s = findSession(ref);
  const dryRun = opts.dryRun ?? false;
  if (!existsSync(s.worktreePath)) {
    throw new Error(`The worktree ${s.worktreePath} no longer exists, so there's nothing to ship from.`);
  }
  const branch = await currentBranch(s);
  if (!branch || branch === s.baseRef) {
    throw new Error(`The worktree is on "${branch || "a detached HEAD"}", not the ticket's branch.`);
  }
  if (!(await isWorktreeClean(s.worktreePath).catch(() => false))) {
    throw new Error("The worktree has uncommitted changes. Commit (or stash) them first, then ship.");
  }

  await git(s.worktreePath, ["fetch", "origin", s.baseRef]);
  const base = (await git(s.worktreePath, ["rev-parse", "--verify", "--quiet", `origin/${s.baseRef}`]))
    ? `origin/${s.baseRef}`
    : s.baseRef;
  const log = await git(s.worktreePath, ["log", "--reverse", "--format=%s", `${base}..HEAD`]);
  const commits = log ? log.split("\n") : [];
  if (!commits.length) throw new Error(`"${branch}" has no commits that aren't on ${s.baseRef}; nothing to ship.`);

  const warnings: string[] = [];
  const namingJson = (
    getDb().prepare(`SELECT branch_naming_json as j FROM tickets WHERE id = ?`).get(s.ticketId) as { j: string | null } | undefined
  )?.j;
  const naming = namingJson ? (JSON.parse(namingJson) as BranchNaming) : undefined;
  if (naming?.options.length && !naming.options.some((o) => branch.startsWith(o.prefix))) {
    warnings.push(
      `"${branch}" doesn't start with one of this repo's branch prefixes (${naming.options.map((o) => o.prefix).join(", ")}).`,
    );
  }

  const report: ShipTicketReport = {
    ticketId: s.ticketId,
    sessionId: s.sessionId,
    branch,
    baseRef: s.baseRef,
    commits,
    pushed: "would push",
    warnings,
    dryRun,
  };

  const upstream = await git(s.worktreePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]);
  const remoteBranch = upstream?.replace(/^origin\//, "") ?? branch;
  if (!dryRun) {
    const unpushed = upstream ? await git(s.worktreePath, ["rev-list", "--count", "@{u}..HEAD"]) : "new";
    if (unpushed === "0") {
      report.pushed = "up to date";
    } else {
      await execa("git", upstream ? ["push"] : ["push", "-u", "origin", "HEAD"], { cwd: s.worktreePath }).catch((e) => {
        throw new Error(`git push failed: ${(e as { stderr?: string }).stderr?.trim() || (e as Error).message}`);
      });
      report.pushed = "pushed";
    }
  }

  const existing = await findPullRequest(s.repoId, remoteBranch);
  if (existing?.state === "OPEN") {
    report.pullRequest = { ...existing, created: false };
  } else if (!dryRun) {
    const title = opts.title?.trim() || s.ticketTitle;
    const link = s.externalUrl ?? `${s.source} ${s.externalId}`;
    let body = opts.body?.trim() || commits.map((c) => `- ${c}`).join("\n");
    if (!body.includes(link)) body += `\n\n---\nTicket: ${link}`;
    const args = ["pr", "create", "--repo", s.repoId, "--base", s.baseRef, "--head", remoteBranch, "--title", title, "--body", body];
    if (opts.draft) args.push("--draft");
    try {
      const { stdout } = await execa("gh", args, { cwd: s.worktreePath });
      const url = stdout.trim().split("\n").pop() ?? "";
      const number = Number(url.match(/\/pull\/(\d+)/)?.[1] ?? 0);
      report.pullRequest = { number, url, state: "OPEN", title, isDraft: !!opts.draft, created: true };
    } catch (e) {
      report.pullRequestError = (e as { stderr?: string }).stderr?.trim() || (e as Error).message;
    }
  }

  if (!dryRun && report.pullRequest && (opts.markReady ?? true)) {
    const pr = report.pullRequest;
    report.boardStatus = (await completeSession(s.sessionId, "ready_for_review", `PR #${pr.number}: ${pr.url}`)).boardStatus;
  }
  return report;
}
