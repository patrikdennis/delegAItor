import { existsSync } from "node:fs";
import { findSession, findPullRequest, git, type PullRequestInfo } from "./sessions.js";
import { closeCmuxWorkspace } from "./agents/launch.js";
import { completeSession, refreshParentTicketStatus } from "./orchestrator.js";
import { getDb } from "./db.js";
import { listSessionRepoUnits, type SessionRepoUnit } from "./sessions.js";
import {
  deleteLocalBranch,
  deleteRemoteBranch,
  isBranchMerged,
  isWorktreeClean,
  remoteBranchExists,
  removeWorktree,
  removeTicketWorkspace,
} from "./worktree/git.js";
import type { BoardStatusResult } from "./tickets/board-status.js";
import { syncBoardStatus } from "./tickets/board-status.js";

export interface CloseTicketOptions {
  /** Close even if the work isn't merged or the worktree has uncommitted changes. */
  force?: boolean;
  /** Leave the remote branch alone. */
  keepRemote?: boolean;
  /** Report what would happen without changing anything. */
  dryRun?: boolean;
  summary?: string;
  /** Leave the ticket's cmux tab open. */
  keepTab?: boolean;
}

export type CloseStepResult = "done" | "already gone" | "skipped" | "failed";

export interface CloseTicketReport {
  ticketId: string;
  sessionId: string;
  localBranch: string;
  remoteBranch?: string;
  pullRequest?: PullRequestInfo;
  steps: { step: string; result: CloseStepResult; detail?: string }[];
  boardStatus?: BoardStatusResult;
  parentStatus?: string;
  dryRun: boolean;
  units?: {
    repoAlias: string;
    repoId: string;
    branch: string;
    status: "closed" | "no_changes" | "failed";
    pullRequest?: PullRequestInfo;
    error?: string;
  }[];
}

/**
 * Closes a delegated ticket once its work has landed: closes the cmux tab,
 * removes the worktree, deletes the local and remote branch, marks the
 * session done, and moves the board card to the "done" column (if one was
 * configured at dispatch). Steps that were already done by hand are
 * reported as "already gone" rather than failing, so it's safe to re-run.
 *
 * Unless `force` is set, it refuses when the work might be lost: an open or
 * unmerged pull request, commits not on the base branch, or uncommitted
 * changes. Squash merges are detected through the GitHub PR (needs `gh`).
 */
export async function closeTicket(ref: string, opts: CloseTicketOptions = {}): Promise<CloseTicketReport> {
  const s = findSession(ref);
  if (s.multiRepo) return closeMultiTicket(s, opts);
  return closeSingleTicket(s, opts);
}

async function closeSingleTicket(s: ReturnType<typeof findSession>, opts: CloseTicketOptions): Promise<CloseTicketReport> {
  const dryRun = opts.dryRun ?? false;
  const worktreeExists = existsSync(s.worktreePath);

  // The agent may have renamed the branch, or pushed it under another name.
  const localBranch = (worktreeExists && (await git(s.worktreePath, ["branch", "--show-current"]))) || s.branch;
  const localExists = !!(await git(s.repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${localBranch}`]));
  const upstream = localExists
    ? await git(s.repoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${localBranch}@{u}`])
    : undefined;
  const remoteBranch = upstream?.replace(/^origin\//, "") ?? localBranch;
  const remoteExists = await remoteBranchExists(s.repoPath, remoteBranch);
  const pullRequest = await findPullRequest(s.repoId, remoteBranch);

  const report: CloseTicketReport = {
    ticketId: s.ticketId,
    sessionId: s.sessionId,
    localBranch,
    remoteBranch: remoteExists || upstream ? remoteBranch : undefined,
    pullRequest,
    steps: [],
    dryRun,
  };

  if (!opts.force) {
    const problems: string[] = [];
    if (worktreeExists && !(await isWorktreeClean(s.worktreePath).catch(() => false))) {
      problems.push(`the worktree ${s.worktreePath} has uncommitted changes`);
    }
    if (pullRequest?.state === "OPEN") {
      problems.push(`pull request #${pullRequest.number} is still open (${pullRequest.url})`);
    } else if (pullRequest?.state !== "MERGED" && (localExists || remoteExists)) {
      await git(s.repoPath, ["fetch", "origin", s.baseRef]);
      const tip = localExists ? localBranch : `origin/${remoteBranch}`;
      const merged =
        (await isBranchMerged(s.repoPath, tip, `origin/${s.baseRef}`)) ||
        (await isBranchMerged(s.repoPath, tip, s.baseRef));
      if (!merged) {
        problems.push(
          `"${tip}" has commits that aren't on ${s.baseRef}` +
            (pullRequest ? ` and pull request #${pullRequest.number} is ${pullRequest.state.toLowerCase()}` : " and no merged pull request was found"),
        );
      }
    }
    if (problems.length) {
      throw new Error(`Not closing ticket ${s.ticketId}: ${problems.join("; ")}. Pass force to close anyway.`);
    }
  }

  const step = async (name: string, applies: boolean, run: () => Promise<unknown>, detail?: string) => {
    if (!applies) return report.steps.push({ step: name, result: "already gone" });
    if (dryRun) return report.steps.push({ step: name, result: "done", detail });
    try {
      await run();
      report.steps.push({ step: name, result: "done", detail });
    } catch (e) {
      report.steps.push({ step: name, result: "failed", detail: (e as Error).message.split("\n")[0] });
    }
  };

  await step("remove worktree", worktreeExists, () => removeWorktree(s.repoPath, s.worktreePath), s.worktreePath);
  if (!dryRun) await git(s.repoPath, ["worktree", "prune"]);
  await step("delete local branch", localExists, () => deleteLocalBranch(s.repoPath, localBranch, true), localBranch);
  if (opts.keepRemote) {
    report.steps.push({ step: "delete remote branch", result: "skipped", detail: "keepRemote" });
  } else {
    await step("delete remote branch", remoteExists, () => deleteRemoteBranch(s.repoPath, remoteBranch), remoteBranch);
  }

  if (!dryRun) {
    const summary = opts.summary ?? (pullRequest?.state === "MERGED" ? `Merged as PR #${pullRequest.number}` : "Closed");
    const completed = await completeSession(s.sessionId, "done", summary);
    report.boardStatus = completed.boardStatus;
    report.parentStatus = completed.parentStatus;
  }
  report.steps.push({ step: "mark session done", result: "done" });

  // Last, because closing the tab ends the agent inside it, which may be the one calling this.
  if (opts.keepTab) {
    report.steps.push({ step: "close cmux tab", result: "skipped", detail: "keepTab" });
  } else if (!s.cmuxWorkspaceId) {
    report.steps.push({ step: "close cmux tab", result: "already gone" });
  } else {
    report.steps.push({ step: "close cmux tab", result: "done" });
    if (!dryRun) setTimeout(() => void closeCmuxWorkspace(s.cmuxWorkspaceId!), 1500);
  }
  return report;
}

async function closeMultiTicket(
  session: ReturnType<typeof findSession>,
  opts: CloseTicketOptions,
): Promise<CloseTicketReport> {
  const dryRun = opts.dryRun ?? false;
  const units = listSessionRepoUnits(session.sessionId);
  if (!units.length) throw new Error(`No active repository worktrees are stored for ticket ${session.ticketId}.`);

  const prepared = [];
  for (const unit of units) {
    const branch = (existsSync(unit.worktreePath) && (await git(unit.worktreePath, ["branch", "--show-current"]))) || unit.branch;
    const localExists = !!(await git(unit.repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]));
    const upstream = localExists
      ? await git(unit.repoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{u}`])
      : undefined;
    const remoteBranch = upstream?.replace(/^origin\//, "") ?? branch;
    const remoteExists = await remoteBranchExists(unit.repoPath, remoteBranch);
    const pullRequest = await findPullRequest(unit.repoId, remoteBranch);
    const worktreeExists = existsSync(unit.worktreePath);
    const clean = !worktreeExists || await isWorktreeClean(unit.worktreePath).catch(() => false);
    let merged = false;
    if (localExists || remoteExists) {
      await git(unit.repoPath, ["fetch", "origin", unit.baseRef]);
      const base = (await git(unit.repoPath, ["rev-parse", "--verify", "--quiet", `origin/${unit.baseRef}`]))
        ? `origin/${unit.baseRef}`
        : unit.baseRef;
      const tip = localExists ? branch : `origin/${remoteBranch}`;
      merged = (await isBranchMerged(unit.repoPath, tip, base)) || (await isBranchMerged(unit.repoPath, tip, unit.baseRef));
    }
    if (!opts.force) {
      if (!clean) throw new Error(`Not closing ${session.ticketId}: ${unit.repoAlias} has uncommitted changes.`);
      if (pullRequest?.state === "OPEN") {
        throw new Error(`Not closing ${session.ticketId}: ${unit.repoAlias} PR #${pullRequest.number} is still open.`);
      }
      if (pullRequest && pullRequest.state !== "MERGED") {
        throw new Error(`Not closing ${session.ticketId}: ${unit.repoAlias} PR #${pullRequest.number} is ${pullRequest.state.toLowerCase()}, not merged.`);
      }
      if ((localExists || remoteExists) && !merged && pullRequest?.state !== "MERGED") {
        throw new Error(`Not closing ${session.ticketId}: ${unit.repoAlias} branch "${branch}" is not merged and has no merged PR.`);
      }
    }
    const noChanges = unit.status === "no_changes" && !pullRequest;
    prepared.push({ unit, branch, localExists, remoteExists, remoteBranch, pullRequest, worktreeExists, noChanges });
  }

  const unitReports: NonNullable<CloseTicketReport["units"]> = [];
  const steps: CloseTicketReport["steps"] = [];
  for (const item of prepared) {
    const { unit } = item;
    if (item.noChanges) {
      try {
        if (item.worktreeExists && !dryRun) await removeWorktree(unit.repoPath, unit.worktreePath);
        steps.push({ step: `remove ${unit.repoAlias} worktree`, result: item.worktreeExists ? "done" : "already gone" });
        if (!dryRun) await git(unit.repoPath, ["worktree", "prune"]);
        if (item.localExists) {
          if (!dryRun) await deleteLocalBranch(unit.repoPath, item.branch, true);
          steps.push({ step: `delete ${unit.repoAlias} local branch`, result: "done", detail: item.branch });
        } else {
          steps.push({ step: `delete ${unit.repoAlias} local branch`, result: "already gone" });
        }
        if (!opts.keepRemote && item.remoteExists) {
          if (!dryRun) await deleteRemoteBranch(unit.repoPath, item.remoteBranch);
          steps.push({ step: `delete ${unit.repoAlias} remote branch`, result: "done", detail: item.remoteBranch });
        } else {
          steps.push({ step: `delete ${unit.repoAlias} remote branch`, result: opts.keepRemote ? "skipped" : "already gone" });
        }
        unitReports.push({ repoAlias: unit.repoAlias, repoId: unit.repoId, branch: item.branch, status: "no_changes" });
        if (!dryRun) {
          getDb().prepare(`UPDATE ticket_units SET status = 'done', updated_at = datetime('now') WHERE id = ?`).run(unit.unitId);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        steps.push({ step: `clean ${unit.repoAlias}`, result: "failed", detail: message });
        unitReports.push({ repoAlias: unit.repoAlias, repoId: unit.repoId, branch: item.branch, status: "failed", error: message });
        if (!dryRun) {
          getDb().prepare(`UPDATE ticket_units SET status = 'cleanup_failed', updated_at = datetime('now') WHERE id = ?`).run(unit.unitId);
        }
      }
      continue;
    }
    try {
      if (item.worktreeExists && !dryRun) await removeWorktree(unit.repoPath, unit.worktreePath);
      steps.push({ step: `remove ${unit.repoAlias} worktree`, result: item.worktreeExists ? "done" : "already gone" });
      if (!dryRun) await git(unit.repoPath, ["worktree", "prune"]);
      if (item.localExists) {
        if (!dryRun) await deleteLocalBranch(unit.repoPath, item.branch, true);
        steps.push({ step: `delete ${unit.repoAlias} local branch`, result: "done", detail: item.branch });
      } else {
        steps.push({ step: `delete ${unit.repoAlias} local branch`, result: "already gone" });
      }
      if (opts.keepRemote) {
        steps.push({ step: `delete ${unit.repoAlias} remote branch`, result: "skipped", detail: "keepRemote" });
      } else if (item.remoteExists) {
        if (!dryRun) await deleteRemoteBranch(unit.repoPath, item.remoteBranch);
        steps.push({ step: `delete ${unit.repoAlias} remote branch`, result: "done", detail: item.remoteBranch });
      } else {
        steps.push({ step: `delete ${unit.repoAlias} remote branch`, result: "already gone" });
      }
      unitReports.push({
        repoAlias: unit.repoAlias,
        repoId: unit.repoId,
        branch: item.branch,
        status: "closed",
        ...(item.pullRequest ? { pullRequest: item.pullRequest } : {}),
      });
      if (!dryRun) {
        getDb().prepare(`UPDATE ticket_units SET status = 'done', updated_at = datetime('now') WHERE id = ?`).run(unit.unitId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push({ step: `close ${unit.repoAlias}`, result: "failed", detail: message });
      unitReports.push({ repoAlias: unit.repoAlias, repoId: unit.repoId, branch: item.branch, status: "failed", error: message });
      if (!dryRun) {
        getDb().prepare(`UPDATE ticket_units SET status = 'cleanup_failed', updated_at = datetime('now') WHERE id = ?`).run(unit.unitId);
      }
    }
  }

  const failures = unitReports.filter((unit) => unit.status === "failed");
  let boardStatus: BoardStatusResult | undefined;
  let parentStatus = session.ticketStatus;
  if (!dryRun && !failures.length) {
    try {
      removeTicketWorkspace(
        session.worktreePath,
        units.map((unit) => ({ alias: unit.repoAlias, worktreePath: unit.worktreePath })),
      );
      steps.push({ step: "remove workspace container", result: "done" });
    } catch (error) {
      steps.push({ step: "remove workspace container", result: "failed", detail: (error as Error).message });
      unitReports.push({
        repoAlias: "workspace",
        repoId: "multiple",
        branch: "",
        status: "failed",
        error: (error as Error).message,
      });
    }
  } else if (dryRun && !failures.length) {
    steps.push({ step: "remove workspace container", result: "done", detail: "dry-run" });
    steps.push({
      step: "close cmux workspace",
      result: session.cmuxWorkspaceId && !opts.keepTab ? "done" : "skipped",
      detail: opts.keepTab ? "keepTab" : "dry-run",
    });
  }
  const allSucceeded = unitReports.every((unit) => unit.status !== "failed");
  if (!dryRun && allSucceeded) {
    getDb().prepare(`UPDATE sessions SET status = 'done', ended_at = datetime('now') WHERE id = ?`).run(session.sessionId);
    getDb()
      .prepare(`UPDATE ticket_units SET status = 'done', updated_at = datetime('now') WHERE ticket_id = ? AND active = 1 AND status = 'no_changes'`)
      .run(session.ticketId);
    parentStatus = refreshParentTicketStatus(session.ticketId, "done");
    if (parentStatus === "done") boardStatus = await syncBoardStatus(session.ticketId, "done");
    steps.push({ step: "mark parent ticket done", result: parentStatus === "done" ? "done" : "failed", detail: parentStatus });
    if (session.cmuxWorkspaceId && !opts.keepTab) {
      if (!dryRun) setTimeout(() => void closeCmuxWorkspace(session.cmuxWorkspaceId!), 1500);
      steps.push({ step: "close cmux workspace", result: "done" });
    } else {
      steps.push({ step: "close cmux workspace", result: "skipped", detail: opts.keepTab ? "keepTab" : "none tracked" });
    }
  } else if (dryRun) {
    steps.push({ step: "mark parent ticket done", result: "skipped", detail: "dry-run" });
  }

  const first = prepared[0];
  return {
    ticketId: session.ticketId,
    sessionId: session.sessionId,
    localBranch: first?.branch ?? session.branch,
    ...(first?.remoteExists ? { remoteBranch: first.remoteBranch } : {}),
    ...(first?.pullRequest ? { pullRequest: first.pullRequest } : {}),
    steps,
    ...(boardStatus ? { boardStatus } : {}),
    parentStatus,
    dryRun,
    units: unitReports,
  };
}
