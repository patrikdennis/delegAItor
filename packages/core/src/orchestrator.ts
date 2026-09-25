import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "./db.js";
import { promptsDir } from "./paths.js";
import type { ExecutionPlan, PlannedTicket } from "./types.js";
import { createWorktree, removeWorktree, isWorktreeClean, isBranchMerged, deleteLocalBranch, remoteBranchExists, deleteRemoteBranch } from "./worktree/git.js";
import { buildAgentCommand } from "./agents/runtimes.js";
import { launchSession, closeCmuxWorkspace, notifyCmux } from "./agents/launch.js";
import { buildTicketPrompt } from "./agents/prompt.js";
import { releaseAllLocks } from "./sync/locks.js";

export function persistPlan(plan: ExecutionPlan, rawPrompt: string): void {
  const db = getDb();
  const insertRun = db.prepare(`INSERT INTO runs (id, prompt) VALUES (?, ?)`);
  const insertTicket = db.prepare(`
    INSERT INTO tickets (id, run_id, source, external_id, external_url, title, body, repo_id, repo_path, base_ref, depends_on)
    VALUES (@id, @runId, @source, @externalId, @externalUrl, @title, @body, @repoId, @repoPath, @baseRef, @dependsOn)
  `);
  const tx = db.transaction((p: ExecutionPlan) => {
    insertRun.run(p.runId, rawPrompt);
    for (const t of p.tickets) {
      insertTicket.run({
        id: t.id,
        runId: p.runId,
        source: t.source,
        externalId: t.externalId,
        externalUrl: t.externalUrl ?? null,
        title: t.title,
        body: t.body ?? null,
        repoId: t.repoId,
        repoPath: t.repoPath,
        baseRef: t.baseRef ?? "main",
        dependsOn: t.dependsOn?.length ? JSON.stringify(t.dependsOn) : null,
      });
    }
  });
  tx(plan);
}

export interface DispatchResult {
  ticket: PlannedTicket;
  sessionId: string;
  worktreePath: string;
  launch: Awaited<ReturnType<typeof launchSession>>;
}

/**
 * Creates the worktree/branch, writes the ticket prompt, launches the
 * agent (via cmux if available), and records the session so `delegaitor
 * status`/lock/message commands can find it from any other process.
 */
export async function dispatchTicket(plan: ExecutionPlan, ticket: PlannedTicket): Promise<DispatchResult> {
  const sessionId = randomUUID();
  const worktreePath = await createWorktree({
    repoPath: ticket.repoPath,
    repoId: ticket.repoId,
    ticketId: ticket.id,
    branch: ticket.branch,
    baseRef: ticket.baseRef ?? "main",
  });

  const promptFile = join(promptsDir(plan.runId), `${ticket.id}.md`);
  writeFileSync(promptFile, buildTicketPrompt({ ticket, sessionId }), "utf8");

  const cmd = buildAgentCommand(ticket.agent, promptFile);
  const launch = await launchSession(cmd, {
    worktreePath,
    title: `${ticket.id}: ${ticket.title}`,
  });

  getDb()
    .prepare(
      `INSERT INTO sessions (id, ticket_id, agent, branch, worktree_path, pid, cmux_workspace_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running')`,
    )
    .run(
      sessionId,
      ticket.id,
      ticket.agent,
      ticket.branch,
      worktreePath,
      launch.pid ?? null,
      launch.cmuxWorkspaceId ?? null,
    );

  getDb().prepare(`UPDATE tickets SET status = 'dispatched', updated_at = datetime('now') WHERE id = ?`).run(
    ticket.id,
  );

  return { ticket, sessionId, worktreePath, launch };
}

export interface SessionRow {
  id: string;
  ticketId: string;
  agent: string;
  branch: string;
  worktreePath: string;
  cmuxWorkspaceId: string | null;
  status: string;
  resultJson: string | null;
  startedAt: string;
  endedAt: string | null;
}

export function listSessions(filter?: { ticketId?: string; status?: string }): SessionRow[] {
  const db = getDb();
  let sql = `SELECT id, ticket_id as ticketId, agent, branch, worktree_path as worktreePath,
                    cmux_workspace_id as cmuxWorkspaceId, status, result_json as resultJson,
                    started_at as startedAt, ended_at as endedAt
             FROM sessions WHERE 1=1`;
  const params: string[] = [];
  if (filter?.ticketId) {
    sql += ` AND ticket_id = ?`;
    params.push(filter.ticketId);
  }
  if (filter?.status) {
    sql += ` AND status = ?`;
    params.push(filter.status);
  }
  return db.prepare(sql).all(...params) as SessionRow[];
}

export function completeSession(sessionId: string, status: string, summary?: string): void {
  releaseAllLocks(sessionId);
  getDb()
    .prepare(
      `UPDATE sessions SET status = ?, result_json = ?, ended_at = datetime('now') WHERE id = ?`,
    )
    .run(status, summary ? JSON.stringify({ summary }) : null, sessionId);
  const row = getDb()
    .prepare(`SELECT ticket_id as ticketId FROM sessions WHERE id = ?`)
    .get(sessionId) as { ticketId: string } | undefined;
  if (row) {
    getDb()
      .prepare(`UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(status, row.ticketId);
  }
}

export interface CleanupOptions {
  /** Close the cmux workspace tab, if one is tracked. Default true. */
  closeWorkspace?: boolean;
  /**
   * - 'never' (default): never remove the worktree directory.
   * - 'if-clean': remove only if `git status --porcelain` is empty.
   * - 'force': remove regardless of uncommitted changes.
   */
  removeWorktree?: "never" | "if-clean" | "force";
  /**
   * - 'never' (default): never delete the local branch.
   * - 'if-merged': delete only if the branch is merged into its base ref.
   * - 'force': delete regardless (uses `git branch -D`).
   */
  deleteBranch?: "never" | "if-merged" | "force";
  /** Also delete the remote branch, subject to the same deleteBranch gate. Default false. */
  deleteRemote?: boolean;
  /** Report what would happen without changing anything. Default false. */
  dryRun?: boolean;
}

export interface CleanupReport {
  sessionId: string;
  ticketId: string;
  worktreePath: string;
  branch: string;
  closedWorkspace: boolean;
  worktreeRemoved: boolean;
  worktreeSkippedReason?: string;
  branchDeleted: boolean;
  branchSkippedReason?: string;
  remoteBranchDeleted: boolean;
  dryRun: boolean;
}

/**
 * Tears down a finished session's resources with safety checks: a
 * worktree is only removed if it has no uncommitted changes (unless
 * forced), and a branch is only deleted once it's merged into its base
 * ref (unless forced). Nothing destructive happens unless explicitly
 * requested via `removeWorktree`/`deleteBranch`.
 */
export async function cleanupSession(
  sessionId: string,
  opts: CleanupOptions = {},
): Promise<CleanupReport> {
  const dryRun = opts.dryRun ?? false;
  const session = getDb()
    .prepare(
      `SELECT worktree_path as worktreePath, cmux_workspace_id as cmuxWorkspaceId,
              branch, ticket_id as ticketId FROM sessions WHERE id = ?`,
    )
    .get(sessionId) as
    | { worktreePath: string; cmuxWorkspaceId: string | null; branch: string; ticketId: string }
    | undefined;
  if (!session) {
    throw new Error(`cleanupSession: no session found with id ${sessionId}`);
  }
  const ticket = getDb()
    .prepare(`SELECT repo_path as repoPath, base_ref as baseRef FROM tickets WHERE id = ?`)
    .get(session.ticketId) as { repoPath: string; baseRef: string } | undefined;
  if (!ticket) {
    throw new Error(`cleanupSession: no ticket found for session ${sessionId}`);
  }

  const report: CleanupReport = {
    sessionId,
    ticketId: session.ticketId,
    worktreePath: session.worktreePath,
    branch: session.branch,
    closedWorkspace: false,
    worktreeRemoved: false,
    branchDeleted: false,
    remoteBranchDeleted: false,
    dryRun,
  };

  if ((opts.closeWorkspace ?? true) && session.cmuxWorkspaceId) {
    if (!dryRun) await closeCmuxWorkspace(session.cmuxWorkspaceId);
    report.closedWorkspace = true;
  }

  const removeMode = opts.removeWorktree ?? "never";
  if (removeMode !== "never") {
    const clean = removeMode === "force" || (await isWorktreeClean(session.worktreePath).catch(() => false));
    if (clean) {
      if (!dryRun) await removeWorktree(ticket.repoPath, session.worktreePath).catch(() => {});
      report.worktreeRemoved = true;
    } else {
      report.worktreeSkippedReason = "worktree has uncommitted changes (use force to override)";
    }
  }

  const branchMode = opts.deleteBranch ?? "never";
  if (branchMode !== "never") {
    const merged =
      branchMode === "force" ||
      (await isBranchMerged(ticket.repoPath, session.branch, ticket.baseRef).catch(() => false));
    if (merged) {
      if (!dryRun) {
        await deleteLocalBranch(ticket.repoPath, session.branch, branchMode === "force").catch(() => {});
      }
      report.branchDeleted = true;
      if (opts.deleteRemote) {
        const hasRemote = await remoteBranchExists(ticket.repoPath, session.branch);
        if (hasRemote) {
          if (!dryRun) await deleteRemoteBranch(ticket.repoPath, session.branch).catch(() => {});
          report.remoteBranchDeleted = true;
        }
      }
    } else {
      report.branchSkippedReason = "branch is not merged into its base ref (use force to override)";
    }
  }

  return report;
}

export interface CleanupCandidate {
  sessionId: string;
  ticketId: string;
  ticketTitle: string;
  branch: string;
  worktreePath: string;
  repoPath: string;
  baseRef: string;
  status: string;
  endedAt: string | null;
}

/**
 * Lists sessions eligible for `cleanupSession`, optionally restricted to
 * finished ones (the common case: "clean up everything that's done").
 */
export function listCleanupCandidates(filter?: { onlyFinished?: boolean }): CleanupCandidate[] {
  const db = getDb();
  let sql = `
    SELECT s.id as sessionId, s.ticket_id as ticketId, t.title as ticketTitle,
           s.branch, s.worktree_path as worktreePath, t.repo_path as repoPath,
           t.base_ref as baseRef, s.status, s.ended_at as endedAt
    FROM sessions s JOIN tickets t ON t.id = s.ticket_id
    WHERE 1=1
  `;
  if (filter?.onlyFinished ?? true) {
    sql += ` AND s.status IN ('completed', 'failed', 'cancelled')`;
  }
  sql += ` ORDER BY s.started_at ASC`;
  return db.prepare(sql).all() as CleanupCandidate[];
}

export { notifyCmux };
