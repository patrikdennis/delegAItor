import { existsSync } from "node:fs";
import { execa } from "execa";
import { completeSession, refreshParentTicketStatus } from "./orchestrator.js";
import { currentBranch, findPullRequest, findSession, git, type PullRequestInfo } from "./sessions.js";
import { isWorktreeClean } from "./worktree/git.js";
import type { BoardStatusResult } from "./tickets/board-status.js";
import { syncBoardStatus } from "./tickets/board-status.js";
import type { BranchNaming } from "./types.js";
import { getDb } from "./db.js";
import { listSessionRepoUnits, type SessionRepoUnit } from "./sessions.js";

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
  parentStatus?: string;
  warnings: string[];
  dryRun: boolean;
  units?: {
    repoAlias: string;
    repoId: string;
    branch: string;
    status: "shipped" | "no_changes" | "failed";
    push: "pushed" | "up to date" | "would push" | "not needed" | "failed";
    commits: string[];
    pullRequest?: PullRequestInfo & { created: boolean };
    error?: string;
  }[];
}

/**
 * Ships a ticket's branch: pushes it and opens a pull request that links
 * back to the ticket (or reuses the open one), then marks the session
 * ready_for_review so the board card moves. Refuses with uncommitted
 * changes or when there's nothing to ship. Never force-pushes.
 */
export async function shipTicket(ref: string, opts: ShipTicketOptions = {}): Promise<ShipTicketReport> {
  const s = findSession(ref);
  if (!s.multiRepo) return shipSingle(s, opts);
  const units = listSessionRepoUnits(s.sessionId);
  if (!units.length) throw new Error(`No active repository worktrees are stored for ticket ${s.ticketId}.`);
  const results: NonNullable<ShipTicketReport["units"]> = [];
  const prepared = [];
  for (const unit of units) {
    const unitSession = sessionForRepo(s, unit);
    if (!existsSync(unit.worktreePath)) throw new Error(`Worktree is missing for ${unit.repoAlias}: ${unit.worktreePath}`);
    if (!(await isWorktreeClean(unit.worktreePath))) {
      throw new Error(`Worktree ${unit.worktreePath} (${unit.repoAlias}) has uncommitted changes. Commit or stash them first.`);
    }
    const branch = await currentBranch(unitSession);
    const commits = await commitsSinceBase(unitSession, branch);
    const existingPullRequest = await findPullRequest(unit.repoId, branch);
    prepared.push({ unit, unitSession, branch, commits, existingPullRequest });
  }

  for (const candidate of prepared) {
    const { unit, unitSession, branch, commits, existingPullRequest } = candidate;
    try {
      if (!commits.length && !existingPullRequest) {
        results.push({ repoAlias: unit.repoAlias, repoId: unit.repoId, branch, status: "no_changes", push: "not needed", commits: [] });
        if (!opts.dryRun) {
          getDb().prepare(`UPDATE ticket_units SET status = 'no_changes', updated_at = datetime('now') WHERE id = ?`).run(unit.unitId);
        }
        continue;
      }
      if (existingPullRequest?.state === "MERGED" || (existingPullRequest && existingPullRequest.state !== "OPEN")) {
        if (existingPullRequest.state !== "MERGED") throw new Error(`PR #${existingPullRequest.number} is ${existingPullRequest.state.toLowerCase()}.`);
        results.push({
          repoAlias: unit.repoAlias,
          repoId: unit.repoId,
          branch,
          status: "shipped",
          push: "up to date",
          commits,
          pullRequest: { ...existingPullRequest, created: false },
        });
        if (!opts.dryRun) {
          getDb().prepare(`UPDATE ticket_units SET status = 'ready_for_review', updated_at = datetime('now') WHERE id = ?`).run(unit.unitId);
        }
        continue;
      }
      const report = await shipSingle(unitSession, { ...opts, markReady: false });
      results.push({
        repoAlias: unit.repoAlias,
        repoId: unit.repoId,
        branch: report.branch,
        status: report.pullRequest ? "shipped" : "failed",
        push: report.pushed,
        commits: report.commits,
        ...(report.pullRequest ? { pullRequest: report.pullRequest } : {}),
        ...(report.pullRequestError ? { error: report.pullRequestError } : {}),
      });
      if (!opts.dryRun) {
        getDb()
          .prepare(`UPDATE ticket_units SET status = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(report.pullRequest ? "ready_for_review" : "ship_failed", unit.unitId);
      }
    } catch (error) {
      results.push({
        repoAlias: unit.repoAlias,
        repoId: unit.repoId,
        branch: unit.branch,
        status: "failed",
        push: "failed",
        commits,
        error: error instanceof Error ? error.message : String(error),
      });
      if (!opts.dryRun) {
        getDb()
          .prepare(`UPDATE ticket_units SET status = 'ship_failed', updated_at = datetime('now') WHERE id = ?`)
          .run(unit.unitId);
      }
    }
  }

  let parentStatus = s.ticketStatus;
  let boardStatus: BoardStatusResult | undefined;
  const failures = results.filter((unit) => unit.status === "failed");
  if (!opts.dryRun) {
    if (!failures.length && (opts.markReady ?? true)) {
      getDb().prepare(`UPDATE sessions SET status = 'ready_for_review', ended_at = datetime('now') WHERE id = ?`).run(s.sessionId);
    }
    parentStatus = refreshParentTicketStatus(s.ticketId, s.sessionStatus);
    if (!failures.length && parentStatus === "ready_for_review" && (opts.markReady ?? true)) {
      boardStatus = await syncBoardStatus(s.ticketId, "ready_for_review");
    }
  }
  const first = results.find((unit) => unit.status === "shipped") ?? results[0];
  return {
    ticketId: s.ticketId,
    sessionId: s.sessionId,
    branch: first?.branch ?? s.branch,
    baseRef: "multiple",
    commits: results.flatMap((unit) => unit.commits.map((commit) => `${unit.repoAlias}: ${commit}`)),
    pushed: opts.dryRun
      ? "would push"
      : results.some((unit) => unit.push === "pushed")
        ? "pushed"
        : "up to date",
    ...(first?.pullRequest ? { pullRequest: first.pullRequest } : {}),
    ...(failures.length ? { pullRequestError: failures.map((unit) => `${unit.repoAlias}: ${unit.error}`).join("; ") } : {}),
    ...(boardStatus ? { boardStatus } : {}),
    parentStatus,
    warnings: [],
    dryRun: opts.dryRun ?? false,
    units: results,
  };
}

async function shipSingle(s: ReturnType<typeof findSession>, opts: ShipTicketOptions): Promise<ShipTicketReport> {
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
    getDb()
      .prepare(
        `SELECT COALESCE(u.branch_naming_json, t.branch_naming_json) as j
         FROM tickets t LEFT JOIN ticket_units u ON u.id = ? WHERE t.id = ?`,
      )
      .get(s.unitId, s.ticketId) as { j: string | null } | undefined
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

  if (!dryRun && report.pullRequest && (opts.markReady ?? true) && !s.multiRepo) {
    const pr = report.pullRequest;
    const completed = await completeSession(s.sessionId, "ready_for_review", `PR #${pr.number}: ${pr.url}`);
    report.boardStatus = completed.boardStatus;
    report.parentStatus = completed.parentStatus;
  }
  return report;
}

function sessionForRepo(session: ReturnType<typeof findSession>, unit: SessionRepoUnit): ReturnType<typeof findSession> {
  return {
    ...session,
    repoId: unit.repoId,
    repoPath: unit.repoPath,
    baseRef: unit.baseRef,
    branch: unit.branch,
    worktreePath: unit.worktreePath,
    unitId: unit.unitId,
    repoAlias: unit.repoAlias,
    multiRepo: 0,
  };
}

async function commitsSinceBase(session: ReturnType<typeof findSession>, branch: string): Promise<string[]> {
  await git(session.worktreePath, ["fetch", "origin", session.baseRef]);
  const base = (await git(session.worktreePath, ["rev-parse", "--verify", "--quiet", `origin/${session.baseRef}`]))
    ? `origin/${session.baseRef}`
    : session.baseRef;
  const log = await git(session.worktreePath, ["log", "--reverse", "--format=%s", `${base}..${branch}`]);
  return log ? log.split("\n") : [];
}
