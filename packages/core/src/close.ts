import { existsSync } from "node:fs";
import { findSession, findPullRequest, git, type PullRequestInfo } from "./sessions.js";
import { closeCmuxWorkspace } from "./agents/launch.js";
import { completeSession } from "./orchestrator.js";
import {
  deleteLocalBranch,
  deleteRemoteBranch,
  isBranchMerged,
  isWorktreeClean,
  remoteBranchExists,
  removeWorktree,
} from "./worktree/git.js";
import type { BoardStatusResult } from "./tickets/board-status.js";

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
  dryRun: boolean;
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
    report.boardStatus = (await completeSession(s.sessionId, "done", summary)).boardStatus;
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
