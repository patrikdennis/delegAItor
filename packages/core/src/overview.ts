import { existsSync } from "node:fs";
import { listActiveLocks } from "./sync/locks.js";
import { unreadMessagesFor } from "./sync/messages.js";
import {
  currentBranch,
  findPullRequest,
  findSession,
  git,
  latestSessions,
  listSessionRepoUnits,
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
  units: {
    unitId: string;
    repoAlias: string;
    repoId: string;
    sessionId: string;
    status: string;
    branch: string;
    summary?: string;
    pullRequest?: PullRequestInfo;
  }[];
}

const FINISHED = new Set(["done", "cancelled", "completed"]);

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
  const groups = new Map<string, SessionTicket[]>();
  for (const session of latestSessions()) {
    const group = groups.get(session.ticketId) ?? [];
    if (session.multiRepo) {
      const repoUnits = listSessionRepoUnits(session.sessionId);
      group.push(...repoUnits.map((unit) => ({
        ...session,
        unitId: unit.unitId,
        repoAlias: unit.repoAlias,
        repoId: unit.repoId,
        repoPath: unit.repoPath,
        baseRef: unit.baseRef,
        branch: unit.branch,
        worktreePath: unit.worktreePath,
        sessionStatus: unit.status,
      })));
    } else {
      group.push(session);
    }
    groups.set(session.ticketId, group);
  }
  const items = await Promise.all(
    [...groups.values()].map(async (sessions) => {
      const s = sessions[0];
      const units = await Promise.all(sessions.map(async (unit) => {
        const branch = await remoteBranchFor(unit);
        const pr = unit.sessionId && (opts.pullRequests ?? true) ? await findPullRequest(unit.repoId, branch) : undefined;
        return {
          unit,
          branch,
          pullRequest: pr,
          view: {
            unitId: unit.unitId,
            repoAlias: unit.repoAlias,
            repoId: unit.repoId,
            sessionId: unit.sessionId,
            status: unit.sessionStatus,
            branch,
            ...(sessionSummary(unit) ? { summary: sessionSummary(unit) } : {}),
            ...(pr ? { pullRequest: pr } : {}),
          },
        };
      }));
      const finished = sessions.every((unit) => FINISHED.has(unit.sessionStatus));
      const unread = unreadMessagesFor({ ticketId: s.ticketId }).map((m) => ({
        kind: m.kind,
        body: m.body,
        fromSessionId: m.fromSessionId,
      }));
      const next = groupedNextStep(units, finished, unread.length);
      const blockedSession = sessions.find((unit) => unit.sessionStatus === "blocked" && sessionSummary(unit));
      const primary = units[0];
      const primaryWithSession = units.find((unit) => unit.unit.sessionId) ?? primary;
      return {
        ticketId: s.ticketId,
        title: s.ticketTitle,
        externalUrl: s.externalUrl,
        repoId: units.length === 1 ? s.repoId : "multiple",
        sessionId: primaryWithSession.unit.sessionId,
        sessionStatus: s.ticketStatus,
        branch: primaryWithSession.branch,
        worktreeExists: sessions.every((unit) => existsSync(unit.worktreePath)),
        cmuxWorkspaceId: primaryWithSession.unit.cmuxWorkspaceId,
        summary: (blockedSession && sessionSummary(blockedSession)) || sessions.map(sessionSummary).find(Boolean),
        unreadMessages: unread,
        locks: locks.filter((lock) => sessions.some((unit) => unit.sessionId === lock.sessionId)).map((lock) => lock.resource),
        pullRequest: units.map((unit) => unit.pullRequest).find(Boolean),
        units: units.map((unit) => unit.view),
        ...next,
      };
    }),
  );
  return items.filter((item) => opts.includeFinished || item.next !== "finished");
}

function groupedNextStep(
  units: {
    unit: SessionTicket;
    pullRequest?: PullRequestInfo;
  }[],
  finished: boolean,
  unread: number,
): { next: NextAction; nextHint: string } {
  if (finished) return { next: "finished", nextHint: "All affected repository work is complete." };
  const blocked = units.find((unit) => unit.unit.sessionStatus === "blocked");
  if (blocked) return { next: "unblock", nextHint: `${blocked.unit.repoAlias}: the agent is waiting on you (unblock skill).` };
  const failed = units.find((unit) => ["failed", "ship_failed", "cleanup_failed"].includes(unit.unit.sessionStatus));
  if (failed) {
    return {
      next: "check",
      nextHint: `${failed.unit.repoAlias}: ${failed.unit.sessionStatus === "ship_failed" ? "shipping failed; retry after fixing the PR error." : failed.unit.sessionStatus === "cleanup_failed" ? "cleanup failed; inspect the repo and retry close." : failed.unit.sessionId ? "the session failed; look at its tab." : "the work unit failed to launch; retry dispatch after fixing the error."}`,
    };
  }
  const pending = units.find((unit) => unit.unit.sessionStatus === "pending");
  if (pending) return { next: "check", nextHint: `${pending.unit.repoAlias}: this repo unit has not started; retry dispatch.` };
  if (units.some((unit) => unit.unit.sessionStatus === "no_changes") &&
      units.every((unit) => ["no_changes", "done", "completed"].includes(unit.unit.sessionStatus))) {
    return { next: "close", nextHint: "No repo changes need PRs; close the parent ticket and clean its worktrees." };
  }
  const allReady = units.every((unit) => ["ready_to_ship", "ready_for_review", "no_changes", "done", "completed"].includes(unit.unit.sessionStatus));
  if (!allReady) {
    const detail = units.filter((unit) => unit.pullRequest?.state === "OPEN").map((unit) => `${unit.unit.repoAlias} PR #${unit.pullRequest!.number}`);
    return {
      next: "working",
      nextHint: `Waiting for all repo work units to be ready${detail.length ? `; already open: ${detail.join(", ")}` : ""}.` +
        (unread ? ` ${unread} unread message(s).` : ""),
    };
  }
  if (
    units.some((unit) => unit.pullRequest?.state === "MERGED") &&
    units.every((unit) => ["no_changes", "done", "completed"].includes(unit.unit.sessionStatus) || unit.pullRequest?.state === "MERGED")
  ) {
    return { next: "close", nextHint: "All required PRs are merged; close the parent ticket and clean all repo worktrees." };
  }
  const changed = units.find((unit) => unit.pullRequest?.reviewDecision === "CHANGES_REQUESTED");
  if (changed) return { next: "address review", nextHint: `${changed.unit.repoAlias}: changes requested on PR #${changed.pullRequest!.number}.` };
  const open = units.find((unit) => unit.pullRequest?.state === "OPEN");
  if (open) return { next: "review", nextHint: `${open.unit.repoAlias}: review PR #${open.pullRequest!.number}.` };
  return { next: "ship", nextHint: "All repo work units are ready; open PRs for each (ship-ticket skill)." };
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
  units?: {
    repoAlias: string;
    repoId: string;
    baseRef: string;
    branch: string;
    worktreePath: string;
    commits: string[];
    diffStat: string;
    uncommitted: string[];
    diff?: string;
    diffTruncated: boolean;
  }[];
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
  if (!s.multiRepo) return ticketContextForSession(s, opts);
  const contexts = await Promise.all(listSessionRepoUnits(s.sessionId).map(async (unit) => ({
    ...(await ticketContextForSession({
      ...s,
      ...unit,
      sessionStatus: unit.status,
      multiRepo: 0,
    }, opts)),
    repoAlias: unit.repoAlias,
    repoId: unit.repoId,
  })));
  const commits = contexts.flatMap((unit) => unit.commits.map((commit) => `${unit.repoAlias}: ${commit}`));
  const uncommitted = contexts.flatMap((unit) => unit.uncommitted.map((file) => `${unit.repoAlias}: ${file}`));
  const diffs = contexts.flatMap((unit) => unit.diff ? [`## ${unit.repoAlias} (${unit.repoId})\n${unit.diff}`] : []);
  const diff = diffs.join("\n\n");
  const diffTruncated = contexts.some((unit) => unit.diffTruncated) || Buffer.byteLength(diff) > (opts.maxDiffBytes ?? 150_000);
  return {
    ticketId: s.ticketId,
    title: s.ticketTitle,
    body: s.ticketBody,
    externalUrl: s.externalUrl,
    repoId: "multiple",
    sessionId: s.sessionId,
    sessionStatus: s.sessionStatus,
    summary: sessionSummary(s),
    baseRef: "multiple",
    branch: "multiple",
    worktreePath: s.worktreePath,
    commits,
    diffStat: contexts.map((unit) => `### ${unit.repoAlias}\n${unit.diffStat}`).join("\n"),
    uncommitted,
    diff: opts.diff === false ? undefined : diff.slice(0, opts.maxDiffBytes ?? 150_000),
    diffTruncated,
    units: contexts,
  };
}

async function ticketContextForSession(
  s: SessionTicket,
  opts: { diff?: boolean; maxDiffBytes?: number },
): Promise<TicketContext> {
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
