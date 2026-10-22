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
  unitId: string;
  repoAlias: string;
  multiRepo: number;
}

const SESSION_SQL = `
  SELECT s.id as sessionId, s.status as sessionStatus, s.ticket_id as ticketId, t.title as ticketTitle,
         t.body as ticketBody, t.status as ticketStatus, t.source, t.external_id as externalId,
         t.external_url as externalUrl, s.branch, s.worktree_path as worktreePath,
         s.cmux_workspace_id as cmuxWorkspaceId, s.result_json as resultJson,
         COALESCE(u.repo_id, NULLIF(t.repo_id, ''), 'multiple') as repoId,
         COALESCE(u.repo_path, t.repo_path) as repoPath,
         COALESCE(u.base_ref, t.base_ref) as baseRef, COALESCE(s.work_unit_id, s.ticket_id) as unitId,
         COALESCE(u.repo_alias, CASE WHEN s.multi_repo = 1 THEN 'multiple' ELSE 'default' END) as repoAlias,
         COALESCE(s.multi_repo, 0) as multiRepo
  FROM sessions s JOIN tickets t ON t.id = s.ticket_id
  LEFT JOIN ticket_units u ON u.id = s.work_unit_id`;

/**
 * Finds a session from whatever the user has at hand: a session id, a
 * ticket id or source id (latest session wins), or a branch name.
 */
export function findSession(ref: string): SessionTicket {
  const db = getDb();
  const r = ref.trim();
  const row =
    (db.prepare(`${SESSION_SQL} WHERE s.id = ?`).get(r) as SessionTicket | undefined) ??
    findTicketSession(db, r) ??
    (db.prepare(`${SESSION_SQL} WHERE s.branch = ? ORDER BY s.started_at DESC LIMIT 1`).get(r) as SessionTicket | undefined) ??
    findByIdPrefix(r);
  if (!row) {
    throw new Error(`No delegAItor session found for "${ref}" (pass a session id, ticket id, or branch name).`);
  }
  return row;
}

export function repoIdForSession(ref: string): string {
  const session = findSession(ref);
  if (session.multiRepo) {
    throw new Error("This session spans multiple repos; pass --repo with a repo id to acquire a repo-scoped lock.");
  }
  return session.repoId;
}

function findTicketSession(db: ReturnType<typeof getDb>, ref: string): SessionTicket | undefined {
  const rows = db
    .prepare(`${SESSION_SQL} WHERE (t.id = ? OR t.external_id = ?) ORDER BY s.started_at DESC`)
    .all(ref, ref) as SessionTicket[];
  const parentSession = rows.find((row) => row.multiRepo);
  if (parentSession) return parentSession;
  const activeLegacy = rows.filter((row) => !["done", "completed", "failed", "cancelled"].includes(row.sessionStatus));
  const unitIds = new Set(activeLegacy.map((row) => row.unitId));
  if (unitIds.size > 1) throw new Error(`Ticket "${ref}" has legacy repo-specific sessions; use a session id or branch name.`);
  return rows[0];
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
  return findTicketSession(db, tickets[0].id);
}

/** Latest session per parent, or per legacy repo-specific session. */
export function latestSessions(): SessionTicket[] {
  return getDb()
    .prepare(
      `${SESSION_SQL}
       WHERE s.id IN (
         SELECT s1.id FROM sessions s1
         WHERE s1.started_at = (
           SELECT MAX(s2.started_at) FROM sessions s2
           WHERE s2.ticket_id = s1.ticket_id
             AND COALESCE(s2.work_unit_id, CASE WHEN s2.multi_repo = 1 THEN '__multi__' ELSE s2.ticket_id END)
               = COALESCE(s1.work_unit_id, CASE WHEN s1.multi_repo = 1 THEN '__multi__' ELSE s1.ticket_id END)
         )
       )
       ORDER BY t.created_at DESC, s.started_at DESC`,
    )
    .all() as SessionTicket[];
}

export interface SessionRepoUnit {
  unitId: string;
  repoAlias: string;
  repoId: string;
  repoPath: string;
  baseRef: string;
  branch: string;
  worktreePath: string;
  status: string;
}

export function listSessionRepoUnits(sessionId: string): SessionRepoUnit[] {
  return getDb()
    .prepare(
      `SELECT u.id as unitId, u.repo_alias as repoAlias, u.repo_id as repoId, u.repo_path as repoPath,
              u.base_ref as baseRef, u.branch, u.worktree_path as worktreePath, u.status
       FROM sessions s JOIN ticket_units u ON u.ticket_id = s.ticket_id
       WHERE s.id = ? AND u.active = 1 ORDER BY u.repo_alias`,
    )
    .all(sessionId) as SessionRepoUnit[];
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
