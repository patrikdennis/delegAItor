import { existsSync } from "node:fs";
import { execa } from "execa";
import { getDb } from "./db.js";

/** A session joined with the ticket it's working, as used by ship/close/review/nudge. */
export interface SessionTicket {
  sessionId: string;
  sessionStatus: string;
  ticketId: string;
  ticketTitle: string;
  ticketBody: string | null;
  ticketStatus: string;
  source: string;
  externalId: string;
  externalUrl: string | null;
  branch: string;
  worktreePath: string;
  cmuxWorkspaceId: string | null;
  resultJson: string | null;
  repoId: string;
  repoPath: string;
  baseRef: string;
}

const SESSION_SQL = `
  SELECT s.id as sessionId, s.status as sessionStatus, s.ticket_id as ticketId, t.title as ticketTitle,
         t.body as ticketBody, t.status as ticketStatus, t.source, t.external_id as externalId,
         t.external_url as externalUrl, s.branch, s.worktree_path as worktreePath,
         s.cmux_workspace_id as cmuxWorkspaceId, s.result_json as resultJson, t.repo_id as repoId,
         t.repo_path as repoPath, t.base_ref as baseRef
  FROM sessions s JOIN tickets t ON t.id = s.ticket_id`;

/**
 * Finds a session from whatever the user has at hand: a session id, a
 * ticket id or source id (latest session wins), or a branch name.
 */
export function findSession(ref: string): SessionTicket {
  const db = getDb();
  const r = ref.trim();
  const row =
    (db.prepare(`${SESSION_SQL} WHERE s.id = ?`).get(r) as SessionTicket | undefined) ??
    (db
      .prepare(`${SESSION_SQL} WHERE t.id = ? OR t.external_id = ? OR s.branch = ? ORDER BY s.started_at DESC LIMIT 1`)
      .get(r, r, r) as SessionTicket | undefined) ??
    findByIdPrefix(r);
  if (!row) {
    throw new Error(`No delegAItor session found for "${ref}" (pass a session id, ticket id, or branch name).`);
  }
  return row;
}

/** A short id like "274e2f8c": a unique session-id prefix, else the latest session of a unique ticket-id prefix. */
function findByIdPrefix(r: string): SessionTicket | undefined {
  if (!/^[0-9a-f-]{6,}$/i.test(r)) return undefined;
  const db = getDb();
  const pattern = `${r.replace(/[%_]/g, "")}%`;
  const sessions = db.prepare(`${SESSION_SQL} WHERE s.id LIKE ? LIMIT 2`).all(pattern) as SessionTicket[];
  if (sessions.length > 1) throw new Error(`"${r}" matches more than one session; use more characters.`);
  if (sessions.length === 1) return sessions[0];
  const tickets = db.prepare(`SELECT id FROM tickets WHERE id LIKE ? LIMIT 2`).all(pattern) as { id: string }[];
  if (tickets.length > 1) throw new Error(`"${r}" matches more than one ticket; use more characters.`);
  if (tickets.length === 0) return undefined;
  return db
    .prepare(`${SESSION_SQL} WHERE t.id = ? ORDER BY s.started_at DESC LIMIT 1`)
    .get(tickets[0].id) as SessionTicket | undefined;
}

/** The latest session of every ticket, newest ticket first. */
export function latestSessions(): SessionTicket[] {
  return getDb()
    .prepare(
      `${SESSION_SQL}
       WHERE s.started_at = (SELECT MAX(s2.started_at) FROM sessions s2 WHERE s2.ticket_id = s.ticket_id)
       ORDER BY t.created_at DESC`,
    )
    .all() as SessionTicket[];
}

export async function git(cwd: string, args: string[]): Promise<string | undefined> {
  return execa("git", args, { cwd })
    .then((r) => r.stdout.trimEnd() || undefined)
    .catch(() => undefined);
}

/** The branch actually checked out in the worktree (the agent may have renamed it), else the recorded one. */
export async function currentBranch(s: SessionTicket): Promise<string> {
  return (existsSync(s.worktreePath) && (await git(s.worktreePath, ["branch", "--show-current"]))) || s.branch;
}

export interface PullRequestInfo {
  number: number;
  state: string;
  url: string;
  title?: string;
  isDraft?: boolean;
  reviewDecision?: string;
}

/** Looks up the PR for a branch with `gh`. Prefers merged, then open. Undefined if none or gh isn't available. */
export async function findPullRequest(repoId: string, branch: string): Promise<PullRequestInfo | undefined> {
  const out = await execa("gh", [
    "pr", "list", "--repo", repoId, "--head", branch, "--state", "all",
    "--json", "number,state,url,title,isDraft,reviewDecision", "--limit", "5",
  ])
    .then((r) => r.stdout)
    .catch(() => "[]");
  const prs = JSON.parse(out || "[]") as PullRequestInfo[];
  return prs.find((p) => p.state === "MERGED") ?? prs.find((p) => p.state === "OPEN") ?? prs[0];
}

export function sessionSummary(s: Pick<SessionTicket, "resultJson">): string | undefined {
  if (!s.resultJson) return undefined;
  try {
    return (JSON.parse(s.resultJson) as { summary?: string }).summary;
  } catch {
    return undefined;
  }
}
