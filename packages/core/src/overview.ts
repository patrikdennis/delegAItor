import { existsSync } from "node:fs";
import { listActiveLocks } from "./sync/locks.js";
import { unreadMessagesFor } from "./sync/messages.js";
import {
  currentBranch,
  findPullRequest,
  findSession,
  git,
  latestSessions,
  sessionSummary,
  type PullRequestInfo,
  type SessionTicket,
} from "./sessions.js";

export type NextAction = "unblock" | "ship" | "review" | "address review" | "close" | "working" | "check" | "finished";

export interface TicketOverviewItem {
  ticketId: string;
  title: string;
  externalUrl: string | null;
  repoId: string;
  sessionId: string;
  sessionStatus: string;
  branch: string;
  worktreeExists: boolean;
  cmuxWorkspaceId: string | null;
  summary?: string;
  unreadMessages: { kind: string; body: string; fromSessionId: string }[];
  locks: string[];
  pullRequest?: PullRequestInfo;
  next: NextAction;
  nextHint: string;
}

const FINISHED = new Set(["done", "cancelled", "completed"]);

function nextStep(s: SessionTicket, pr: PullRequestInfo | undefined, unread: number): { next: NextAction; nextHint: string } {
  if (FINISHED.has(s.sessionStatus)) return { next: "finished", nextHint: "Nothing to do." };
  if (s.sessionStatus === "blocked") return { next: "unblock", nextHint: "The agent is waiting on you (unblock skill)." };
  if (pr?.state === "MERGED") return { next: "close", nextHint: `PR #${pr.number} is merged; close the ticket (close-ticket skill).` };
  if (pr?.state === "OPEN") {
    if (pr.reviewDecision === "CHANGES_REQUESTED") {
      return { next: "address review", nextHint: `Changes were requested on PR #${pr.number}; tell the agent to address them.` };
    }
    return { next: "review", nextHint: `PR #${pr.number} is open${pr.isDraft ? " (draft)" : ""}; review it (review-ticket skill).` };
  }
  if (s.sessionStatus === "ready_for_review") return { next: "ship", nextHint: "Done but not pushed; open a PR (ship-ticket skill)." };
  if (s.sessionStatus === "failed") return { next: "check", nextHint: "The session failed; look at its tab." };
  return {
    next: "working",
    nextHint: unread ? `Working; ${unread} unread message(s) from other sessions.` : "The agent is working on it.",
  };
}

/** The upstream branch name if one is set, else the local branch. That's what a PR's head is. */
export async function remoteBranchFor(s: SessionTicket): Promise<string> {
  const branch = await currentBranch(s);
  const upstream = existsSync(s.worktreePath)
    ? await git(s.worktreePath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])
    : await git(s.repoPath, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{u}`]);
  return upstream?.replace(/^origin\//, "") ?? branch;
}

/**
 * One line per ticket (its latest session) with what needs doing next:
 * unblock, ship, review, close. Finished tickets are left out unless
 * `includeFinished`. PR state comes from `gh` and is skipped if
 * `pullRequests` is false.
 */
export async function ticketOverview(
  opts: { includeFinished?: boolean; pullRequests?: boolean } = {},
): Promise<TicketOverviewItem[]> {
  const locks = listActiveLocks();
  const sessions = latestSessions().filter((s) => opts.includeFinished || !FINISHED.has(s.sessionStatus));
  return Promise.all(
    sessions.map(async (s) => {
      const branch = await remoteBranchFor(s);
      const pr = (opts.pullRequests ?? true) ? await findPullRequest(s.repoId, branch) : undefined;
      const unread = unreadMessagesFor({ ticketId: s.ticketId }).map((m) => ({
        kind: m.kind,
        body: m.body,
        fromSessionId: m.fromSessionId,
      }));
      return {
        ticketId: s.ticketId,
        title: s.ticketTitle,
        externalUrl: s.externalUrl,
        repoId: s.repoId,
        sessionId: s.sessionId,
        sessionStatus: s.sessionStatus,
        branch,
        worktreeExists: existsSync(s.worktreePath),
        cmuxWorkspaceId: s.cmuxWorkspaceId,
        summary: sessionSummary(s),
        unreadMessages: unread,
        locks: locks.filter((l) => l.sessionId === s.sessionId).map((l) => l.resource),
        pullRequest: pr,
        ...nextStep(s, pr, unread.length),
      };
    }),
  );
}

export interface TicketContext {
  ticketId: string;
  title: string;
  body: string | null;
  externalUrl: string | null;
  repoId: string;
  sessionId: string;
  sessionStatus: string;
  summary?: string;
  baseRef: string;
  branch: string;
  worktreePath: string;
  pullRequest?: PullRequestInfo;
  commits: string[];
  diffStat: string;
  uncommitted: string[];
  diff?: string;
  diffTruncated: boolean;
}

/**
 * What a reviewer needs to check a ticket's work against its requirements:
 * the ticket text (including the discussion delegAItor fetched), the
 * commits, and the diff against the base branch. Works from the worktree
 * if it still exists, otherwise from the local or remote branch.
 */
export async function ticketContext(
  ref: string,
  opts: { diff?: boolean; maxDiffBytes?: number } = {},
): Promise<TicketContext> {
  const s = findSession(ref);
  const hasWorktree = existsSync(s.worktreePath);
  const cwd = hasWorktree ? s.worktreePath : s.repoPath;
  const branch = await currentBranch(s);
  const remoteBranch = await remoteBranchFor(s);

  await git(cwd, ["fetch", "origin", s.baseRef]);
  const base = (await git(cwd, ["rev-parse", "--verify", "--quiet", `origin/${s.baseRef}`])) ? `origin/${s.baseRef}` : s.baseRef;
  let head = hasWorktree ? "HEAD" : branch;
  if (!hasWorktree && !(await git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]))) {
    await git(cwd, ["fetch", "origin", remoteBranch]);
    head = `origin/${remoteBranch}`;
  }
  const range = `${base}...${head}`;

  const log = await git(cwd, ["log", "--reverse", "--format=%h %s", `${base}..${head}`]);
  const diffStat = (await git(cwd, ["diff", "--stat", range])) ?? "";
  const status = hasWorktree ? await git(cwd, ["status", "--porcelain"]) : undefined;

  let diff: string | undefined;
  let diffTruncated = false;
  if (opts.diff ?? true) {
    diff = (await git(cwd, ["diff", range])) ?? "";
    const max = opts.maxDiffBytes ?? 150_000;
    if (Buffer.byteLength(diff) > max) {
      diff = Buffer.from(diff).subarray(0, max).toString("utf8");
      diffTruncated = true;
    }
  }

  return {
    ticketId: s.ticketId,
    title: s.ticketTitle,
    body: s.ticketBody,
    externalUrl: s.externalUrl,
    repoId: s.repoId,
    sessionId: s.sessionId,
    sessionStatus: s.sessionStatus,
    summary: sessionSummary(s),
    baseRef: s.baseRef,
    branch,
    worktreePath: s.worktreePath,
    pullRequest: await findPullRequest(s.repoId, remoteBranch),
    commits: log ? log.split("\n") : [],
    diffStat,
    uncommitted: status ? status.split("\n") : [],
    diff,
    diffTruncated,
  };
}
