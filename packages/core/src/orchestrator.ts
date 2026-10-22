import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "./db.js";
import { promptsDir } from "./paths.js";
import type { BranchNaming, ExecutionPlan, PlannedTicket } from "./types.js";
import { createWorktree, removeWorktree, isWorktreeClean, isBranchMerged, deleteLocalBranch, remoteBranchExists, deleteRemoteBranch, prepareTicketWorkspace, removeTicketWorkspace } from "./worktree/git.js";
import { buildAgentCommand } from "./agents/runtimes.js";
import { launchSession, closeCmuxWorkspace, notifyCmux, workspaceTitle } from "./agents/launch.js";
import { buildTicketPrompt } from "./agents/prompt.js";
import { execa } from "execa";
import { releaseAllLocks } from "./sync/locks.js";
import { syncBoardStatus, isBoardLifecycle, type BoardStatusResult } from "./tickets/board-status.js";

export function persistPlan(plan: ExecutionPlan, rawPrompt: string): void {
  const db = getDb();
  const insertRun = db.prepare(`INSERT INTO runs (id, prompt) VALUES (?, ?)`);
  // Ticket ids are deterministic (derived from the source's externalId), so
  // the same ticket can legitimately be re-planned/re-dispatched across
  // separate runs (e.g. after a prior session was cancelled/cleaned up).
  // Upsert instead of a plain INSERT so that doesn't hit tickets.id's
  // PRIMARY KEY constraint.
  const insertTicket = db.prepare(`
    INSERT INTO tickets (id, run_id, source, external_id, external_url, title, body, repo_id, repo_path, base_ref, depends_on, board_sync_json, branch_naming_json)
    VALUES (@id, @runId, @source, @externalId, @externalUrl, @title, @body, @repoId, @repoPath, @baseRef, @dependsOn, @boardSyncJson, @branchNamingJson)
    ON CONFLICT(id) DO UPDATE SET
      run_id = excluded.run_id,
      source = excluded.source,
      external_id = excluded.external_id,
      external_url = excluded.external_url,
      title = excluded.title,
      body = excluded.body,
      repo_id = excluded.repo_id,
      repo_path = excluded.repo_path,
      base_ref = excluded.base_ref,
      depends_on = excluded.depends_on,
      board_sync_json = excluded.board_sync_json,
      branch_naming_json = excluded.branch_naming_json,
      status = 'pending',
      updated_at = datetime('now')
  `);
  const insertUnit = db.prepare(`
    INSERT INTO ticket_units
      (id, ticket_id, repo_alias, repo_id, repo_path, base_ref, branch, worktree_path, status, branch_naming_json, active)
    VALUES (@unitId, @ticketId, @repoAlias, @repoId, @repoPath, @baseRef, @branch, @worktreePath, 'pending', @branchNamingJson, 1)
    ON CONFLICT(id) DO UPDATE SET
      ticket_id = excluded.ticket_id,
      repo_alias = excluded.repo_alias,
      repo_id = excluded.repo_id,
      repo_path = excluded.repo_path,
      base_ref = excluded.base_ref,
      branch = excluded.branch,
      worktree_path = excluded.worktree_path,
      branch_naming_json = excluded.branch_naming_json,
      active = 1,
      status = 'pending',
      updated_at = datetime('now')
  `);
  const tx = db.transaction((p: ExecutionPlan) => {
    insertRun.run(p.runId, rawPrompt);
    const grouped = new Map<string, PlannedTicket[]>();
    for (const unit of p.tickets) {
      const group = grouped.get(unit.id) ?? [];
      group.push(unit);
      grouped.set(unit.id, group);
    }
    for (const [id, units] of grouped) {
      const t = units[0];
      if (units.some((unit) => unit.repoAlias)) {
        const activeSession = db
          .prepare(
            `SELECT s.id FROM sessions s
             WHERE s.ticket_id = ? AND EXISTS (
               SELECT 1 FROM ticket_units u WHERE u.ticket_id = s.ticket_id AND u.active = 1
             )
               AND s.status NOT IN ('done', 'completed', 'failed', 'cancelled')
             LIMIT 1`,
          )
          .get(id) as { id: string } | undefined;
        if (activeSession) {
          throw new Error(
            `Ticket ${id} already has an active repo work unit (session ${activeSession.id}); finish or close its current units before dispatching it again.`,
          );
        }
      }
      db.prepare(`UPDATE ticket_units SET active = 0 WHERE ticket_id = ?`).run(id);
      insertTicket.run({
        id,
        runId: p.runId,
        source: t.source,
        externalId: t.externalId,
        externalUrl: t.externalUrl ?? null,
        title: t.title,
        body: t.body ?? null,
        repoId: units.length === 1 ? t.repoId : "",
        repoPath: units.length === 1 ? t.repoPath : "",
        baseRef: units.length === 1 ? t.baseRef ?? "main" : "",
        dependsOn: t.dependsOn?.length ? JSON.stringify(t.dependsOn) : null,
        boardSyncJson: t.boardSync ? JSON.stringify(t.boardSync) : null,
        branchNamingJson: units.length === 1 && t.branchNaming ? JSON.stringify(t.branchNaming) : null,
      });
      for (const unit of units) {
        insertUnit.run({
          unitId: unit.unitId,
          ticketId: id,
          repoAlias: unit.repoAlias ?? "default",
          repoId: unit.repoId,
          repoPath: unit.repoPath,
          baseRef: unit.baseRef ?? "main",
          branch: unit.branch,
          worktreePath: unit.worktreePath,
          branchNamingJson: unit.branchNaming ? JSON.stringify(unit.branchNaming) : null,
        });
      }
    }
  });
  tx(plan);
}

export interface DispatchResult {
  ticket: PlannedTicket;
  sessionId: string;
  worktreePath: string;
  worktrees: { repoAlias: string; repoId: string; branch: string; worktreePath: string }[];
  launch: Awaited<ReturnType<typeof launchSession>>;
  /** Result of moving the source ticket to its "in progress" board status, if configured. */
  boardStatus?: BoardStatusResult;
}

/**
 * Creates the worktree/branch, writes the ticket prompt, launches the
 * agent (via cmux if available), and records the session so `delegaitor
 * status`/lock/message commands can find it from any other process.
 */
export async function dispatchTicket(plan: ExecutionPlan, ticket: PlannedTicket): Promise<DispatchResult> {
  const units = plan.tickets.filter((unit) => unit.id === ticket.id);
  if (!units.length) throw new Error(`No planned repository units found for ticket ${ticket.id}.`);
  const multiRepo = units.length > 1;
  const sessionId = randomUUID();
  const created: PlannedTicket[] = [];
  const workspacePath = multiRepo ? ticket.workspacePath : undefined;
  try {
    for (const unit of units) {
      await createWorktree({
        repoPath: unit.repoPath,
        repoId: unit.repoId,
        ticketId: unit.unitId,
        branch: unit.branch,
        baseRef: unit.baseRef ?? "main",
      });
      created.push(unit);
    }
    if (multiRepo) {
      if (!workspacePath) throw new Error(`No ticket workspace path planned for multi-repo ticket ${ticket.id}.`);
      prepareTicketWorkspace(
        workspacePath,
        units.map((unit) => ({ alias: unit.repoAlias ?? unit.repoId, worktreePath: unit.worktreePath })),
      );
    }

    const worktreePath = workspacePath ?? units[0].worktreePath;
    const promptFile = join(promptsDir(plan.runId), `${ticket.id}.md`);
    writeFileSync(promptFile, buildTicketPrompt({ ticket, sessionId }), "utf8");
    const cmd = buildAgentCommand(ticket.agent, promptFile);
    const launch = await launchSession(cmd, {
      worktreePath,
      title: workspaceTitle(ticket.title, ticket.id),
    });

    getDb()
      .prepare(
        `INSERT INTO sessions (id, ticket_id, work_unit_id, multi_repo, agent, branch, worktree_path, pid, cmux_workspace_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running')`,
      )
      .run(
        sessionId,
        ticket.id,
        multiRepo ? null : ticket.unitId,
        multiRepo ? 1 : 0,
        ticket.agent,
        ticket.branch,
        worktreePath,
        launch.pid ?? null,
        launch.cmuxWorkspaceId ?? null,
      );

    getDb()
      .prepare(`UPDATE ticket_units SET status = 'dispatched', updated_at = datetime('now') WHERE ticket_id = ? AND active = 1`)
      .run(ticket.id);
    refreshParentTicketStatus(ticket.id);

    const boardStatus = await syncBoardStatus(ticket.id, "in_progress");
    return {
      ticket,
      sessionId,
      worktreePath,
      worktrees: units.map((unit) => ({
        repoAlias: unit.repoAlias ?? unit.repoId,
        repoId: unit.repoId,
        branch: unit.branch,
        worktreePath: unit.worktreePath,
      })),
      launch,
      boardStatus,
    };
  } catch (error) {
    if (workspacePath && multiRepo) {
      try {
        removeTicketWorkspace(
          workspacePath,
          units.map((unit) => ({ alias: unit.repoAlias ?? unit.repoId, worktreePath: unit.worktreePath })),
        );
      } catch {
        // Preserve the launch/worktree error; any unmanaged workspace entry is left untouched.
      }
    }
    const cleanupErrors: string[] = [];
    for (const unit of created.reverse()) {
      try {
        await removeWorktree(unit.repoPath, unit.worktreePath);
        await deleteLocalBranch(unit.repoPath, unit.branch, true);
      } catch (cleanupError) {
        cleanupErrors.push(`${unit.repoAlias ?? unit.repoId}: ${(cleanupError as Error).message}`);
      }
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      cleanupErrors.length
        ? `${detail} Cleanup also failed for ${cleanupErrors.join("; ")}.`
        : detail,
    );
  }
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
  workUnitId: string;
  repoAlias: string;
  repoId: string;
  multiRepo: number;
}

export function listSessions(filter?: { ticketId?: string; status?: string }): SessionRow[] {
  const db = getDb();
  let sql = `SELECT s.id, s.ticket_id as ticketId, s.agent, s.branch, s.worktree_path as worktreePath,
                    s.cmux_workspace_id as cmuxWorkspaceId, s.status, s.result_json as resultJson,
                    s.started_at as startedAt, s.ended_at as endedAt,
                    COALESCE(s.work_unit_id, s.ticket_id) as workUnitId,
                    COALESCE(u.repo_alias, CASE WHEN s.multi_repo = 1 THEN 'multiple' ELSE 'default' END) as repoAlias,
                    COALESCE(u.repo_id, NULLIF(t.repo_id, ''), 'multiple') as repoId,
                    COALESCE(s.multi_repo, 0) as multiRepo
             FROM sessions s JOIN tickets t ON t.id = s.ticket_id
             LEFT JOIN ticket_units u ON u.id = s.work_unit_id WHERE 1=1`;
  const params: string[] = [];
  if (filter?.ticketId) {
    sql += ` AND s.ticket_id = ?`;
    params.push(filter.ticketId);
  }
  if (filter?.status) {
    sql += ` AND s.status = ?`;
    params.push(filter.status);
  }
  return db.prepare(sql).all(...params) as SessionRow[];
}

export interface CompleteSessionResult {
  /** Result of moving the source ticket on its board, if a status name is configured for `status`. */
  boardStatus?: BoardStatusResult;
  /** Aggregate parent-ticket state after applying this work unit's outcome. */
  parentStatus?: string;
}

export async function completeSession(
  sessionId: string,
  status: string,
  summary?: string,
): Promise<CompleteSessionResult> {
  const existing = getDb()
    .prepare(`SELECT ticket_id as ticketId, multi_repo as multiRepo FROM sessions WHERE id = ?`)
    .get(sessionId) as { ticketId: string; multiRepo: number } | undefined;
  if (existing?.multiRepo && status === "done") {
    throw new Error("Multi-repository tickets can be marked done only by closing after every required PR is merged.");
  }
  releaseAllLocks(sessionId);
  getDb()
    .prepare(
      `UPDATE sessions SET status = ?, result_json = ?, ended_at = datetime('now') WHERE id = ?`,
    )
    .run(status, summary ? JSON.stringify({ summary }) : null, sessionId);
  const row = getDb()
    .prepare(`SELECT ticket_id as ticketId, COALESCE(work_unit_id, ticket_id) as unitId, multi_repo as multiRepo FROM sessions WHERE id = ?`)
    .get(sessionId) as { ticketId: string; unitId: string; multiRepo: number } | undefined;
  if (row) {
    if (row.multiRepo) {
      const unitStatus = status === "ready_for_review" ? "ready_to_ship" : status;
      getDb()
        .prepare(`UPDATE ticket_units SET status = ?, updated_at = datetime('now') WHERE ticket_id = ? AND active = 1`)
        .run(unitStatus, row.ticketId);
      const parentStatus = refreshParentTicketStatus(row.ticketId, status);
      if (status === "ready_for_review") return { parentStatus };
    } else {
      getDb().prepare(`UPDATE ticket_units SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, row.unitId);
    }
    const parentStatus = refreshParentTicketStatus(row.ticketId, status);
    if (isBoardLifecycle(status)) {
      const canMove = status === "ready_for_review"
        ? parentStatus === "ready_for_review"
        : status === "done"
          ? parentStatus === "done"
          : status === "blocked";
      return {
        parentStatus,
        ...(canMove ? { boardStatus: await syncBoardStatus(row.ticketId, status) } : {}),
      };
    }
    return { parentStatus };
  }
  return {};
}

export function refreshParentTicketStatus(ticketId: string, fallback = "pending"): string {
  const units = getDb()
    .prepare(`SELECT status FROM ticket_units WHERE ticket_id = ? AND active = 1`)
    .all(ticketId) as { status: string }[];
  const states = units.map((unit) => unit.status);
  let status = states.length ? "pending" : fallback;
  const terminal = new Set(["done", "completed", "merged", "closed"]);
  const ready = new Set(["ready_for_review", "no_changes", ...terminal]);
  if (states.length && states.every((state) => terminal.has(state))) status = "done";
  else if (states.length && states.every((state) => ready.has(state))) status = "ready_for_review";
  else if (states.includes("blocked")) status = "blocked";
  else if (
    states.some((state) => ["running", "starting", "dispatched", "in_progress", "ready_to_ship", "ship_failed", "ready_for_review", ...terminal].includes(state))
  ) status = "in_progress";
  else if (states.length && states.every((state) => ["failed", "cancelled", "ship_failed", "cleanup_failed"].includes(state))) status = states[0];
  getDb()
    .prepare(`UPDATE tickets SET status = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(status, ticketId);
  return status;
}

/** Records failed unit creation/launch without making sibling units appear failed. */
export function markWorkUnitFailed(unitId: string): void {
  const db = getDb();
  const row = db.prepare(`SELECT ticket_id as ticketId FROM ticket_units WHERE id = ?`).get(unitId) as
    | { ticketId: string }
    | undefined;
  const ticket = row ?? (db.prepare(`SELECT id as ticketId FROM tickets WHERE id = ?`).get(unitId) as { ticketId: string } | undefined);
  if (!ticket) return;
  db.prepare(`UPDATE ticket_units SET status = 'failed', updated_at = datetime('now') WHERE ticket_id = ? AND active = 1`)
    .run(ticket.ticketId);
  refreshParentTicketStatus(ticket.ticketId, "pending");
}

export interface RenameBranchResult {
  oldBranch: string;
  newBranch: string;
  units?: { repoAlias: string; oldBranch: string; newBranch: string }[];
}

/**
 * Swaps the prefix of a session's branch (e.g. feature/... -> fix/...),
 * keeping the rest of the name. Lets the agent correct the prefix
 * delegAItor guessed before it had read the ticket. Refuses once the
 * branch has been pushed, since renaming then would orphan the remote
 * branch and any pull request opened from it.
 */
export async function renameSessionBranch(sessionId: string, newPrefix: string): Promise<RenameBranchResult> {
  const row = getDb()
    .prepare(
      `SELECT s.branch, s.worktree_path as worktreePath, t.id as ticketId, s.multi_repo as multiRepo,
              COALESCE(u.repo_path, t.repo_path) as repoPath,
              COALESCE(u.branch_naming_json, t.branch_naming_json) as namingJson,
              COALESCE(s.work_unit_id, s.ticket_id) as unitId
       FROM sessions s JOIN tickets t ON t.id = s.ticket_id
       LEFT JOIN ticket_units u ON u.id = s.work_unit_id WHERE s.id = ?`,
    )
    .get(sessionId) as
    | { branch: string; worktreePath: string; ticketId: string; multiRepo: number; repoPath: string; namingJson: string | null; unitId: string }
    | undefined;
  if (!row) throw new Error(`Unknown session id: ${sessionId}`);

  if (row.multiRepo) {
    const ticketId = (getDb().prepare(`SELECT ticket_id FROM sessions WHERE id = ?`).get(sessionId) as { ticket_id: string }).ticket_id;
    const units = getDb()
      .prepare(
        `SELECT id as unitId, repo_alias as repoAlias, repo_id as repoId, repo_path as repoPath,
                branch, worktree_path as worktreePath, branch_naming_json as namingJson
         FROM ticket_units WHERE ticket_id = ? AND active = 1 ORDER BY repo_alias`,
      )
      .all(ticketId) as {
      unitId: string;
      repoAlias: string;
      repoId: string;
      repoPath: string;
      branch: string;
      worktreePath: string;
      namingJson: string | null;
    }[];
    const renamed = units.map((unit) => {
      const naming = unit.namingJson ? (JSON.parse(unit.namingJson) as BranchNaming) : undefined;
      if (naming?.locked) {
        throw new Error(`The ${unit.repoAlias} branch prefix was set explicitly with --branch-prefix ("${naming.prefix}"), so it can't be changed.`);
      }
      const prefix = newPrefix.trim() && !newPrefix.trim().endsWith("/") ? `${newPrefix.trim()}/` : newPrefix.trim();
      if (naming?.options.length && !naming.options.some((option) => option.prefix === prefix)) {
        throw new Error(`"${prefix}" is not one of ${unit.repoAlias}'s allowed branch prefixes.`);
      }
      const idStart = unit.branch.indexOf(row.ticketId);
      if (idStart < 0) throw new Error(`Branch "${unit.branch}" in ${unit.repoAlias} doesn't contain the ticket id.`);
      return { ...unit, naming, prefix, newBranch: `${prefix}${unit.branch.slice(idStart)}` };
    });
    for (const unit of renamed) {
      if (unit.newBranch === unit.branch) continue;
      await execa("git", ["check-ref-format", "--branch", unit.newBranch]).catch(() => {
        throw new Error(`"${unit.newBranch}" is not a valid branch name in ${unit.repoAlias}.`);
      });
      const hasUpstream = await execa("git", ["rev-parse", "--abbrev-ref", "@{u}"], { cwd: unit.worktreePath })
        .then(() => true)
        .catch(() => false);
      if (hasUpstream || (await remoteBranchExists(unit.repoPath, unit.branch))) {
        throw new Error(`"${unit.branch}" in ${unit.repoAlias} has already been pushed; refusing to rename.`);
      }
    }
    const completed: typeof renamed = [];
    try {
      for (const unit of renamed) {
        if (unit.newBranch === unit.branch) continue;
        await execa("git", ["branch", "-m", unit.branch, unit.newBranch], { cwd: unit.worktreePath });
        getDb()
          .prepare(`UPDATE ticket_units SET branch = ?, branch_naming_json = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(
            unit.newBranch,
            unit.naming ? JSON.stringify({ ...unit.naming, prefix: unit.prefix, reason: "changed by the agent after reading the ticket" }) : null,
            unit.unitId,
          );
        completed.push(unit);
      }
    } catch (error) {
      throw new Error(
        `Branch rename stopped after ${completed.length} repo(s): ${(error as Error).message}` +
          (completed.length ? ` Updated: ${completed.map((unit) => unit.repoAlias).join(", ")}.` : ""),
      );
    }
    const first = renamed[0];
    if (first) getDb().prepare(`UPDATE sessions SET branch = ? WHERE id = ?`).run(first.newBranch, sessionId);
    return {
      oldBranch: first?.branch ?? row.branch,
      newBranch: first?.newBranch ?? row.branch,
      units: renamed.map((unit) => ({ repoAlias: unit.repoAlias, oldBranch: unit.branch, newBranch: unit.newBranch })),
    };
  }

  const naming = row.namingJson ? (JSON.parse(row.namingJson) as BranchNaming) : undefined;
  if (naming?.locked) {
    throw new Error(`The branch prefix was set explicitly with --branch-prefix ("${naming.prefix}"), so it can't be changed.`);
  }
  const prefix = newPrefix.trim() && !newPrefix.trim().endsWith("/") ? `${newPrefix.trim()}/` : newPrefix.trim();
  if (naming?.options.length && !naming.options.some((o) => o.prefix === prefix)) {
    throw new Error(
      `"${prefix}" is not one of this repo's branch prefixes (${naming.options.map((o) => o.prefix).join(", ")}).`,
    );
  }

  const idStart = row.branch.indexOf(row.ticketId);
  if (idStart < 0) throw new Error(`Branch "${row.branch}" doesn't contain the ticket id; rename it manually.`);
  const newBranch = `${prefix}${row.branch.slice(idStart)}`;
  if (newBranch === row.branch) return { oldBranch: row.branch, newBranch };

  await execa("git", ["check-ref-format", "--branch", newBranch]).catch(() => {
    throw new Error(`"${newBranch}" is not a valid branch name.`);
  });
  const hasUpstream = await execa("git", ["rev-parse", "--abbrev-ref", "@{u}"], { cwd: row.worktreePath })
    .then(() => true)
    .catch(() => false);
  if (hasUpstream || (await remoteBranchExists(row.repoPath, row.branch))) {
    throw new Error(`"${row.branch}" has already been pushed; renaming it now would orphan the remote branch.`);
  }

  await execa("git", ["branch", "-m", row.branch, newBranch], { cwd: row.worktreePath });
  getDb().prepare(`UPDATE sessions SET branch = ? WHERE id = ?`).run(newBranch, sessionId);
  getDb().prepare(`UPDATE ticket_units SET branch = ?, updated_at = datetime('now') WHERE id = ?`).run(newBranch, row.unitId);
  if (naming) {
    const updated: BranchNaming = { ...naming, prefix, reason: "changed by the agent after reading the ticket" };
    getDb()
      .prepare(`UPDATE ticket_units SET branch_naming_json = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(JSON.stringify(updated), row.unitId);
  }
  return { oldBranch: row.branch, newBranch };
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
      `SELECT s.worktree_path as worktreePath, s.cmux_workspace_id as cmuxWorkspaceId,
              s.branch, s.ticket_id as ticketId, COALESCE(s.work_unit_id, s.ticket_id) as unitId,
              s.multi_repo as multiRepo,
              u.repo_path as repoPath, u.base_ref as baseRef FROM sessions s
       LEFT JOIN ticket_units u ON u.id = COALESCE(s.work_unit_id, s.ticket_id) WHERE s.id = ?`,
    )
    .get(sessionId) as
    | { worktreePath: string; cmuxWorkspaceId: string | null; branch: string; ticketId: string; unitId: string; multiRepo: number; repoPath: string; baseRef: string }
    | undefined;
  if (!session) {
    throw new Error(`cleanupSession: no session found with id ${sessionId}`);
  }
  if (session.multiRepo) {
    throw new Error(`Ticket ${session.ticketId} spans several repos; use \`delegaitor ticket close ${session.ticketId}\` to safely close them together.`);
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
      if (!dryRun) await removeWorktree(session.repoPath, session.worktreePath).catch(() => {});
      report.worktreeRemoved = true;
    } else {
      report.worktreeSkippedReason = "worktree has uncommitted changes (use force to override)";
    }
  }

  const branchMode = opts.deleteBranch ?? "never";
  if (branchMode !== "never") {
    const merged =
      branchMode === "force" ||
      (await isBranchMerged(session.repoPath, session.branch, session.baseRef).catch(() => false));
    if (merged) {
      if (!dryRun) {
        await deleteLocalBranch(session.repoPath, session.branch, branchMode === "force").catch(() => {});
      }
      report.branchDeleted = true;
      if (opts.deleteRemote) {
        const hasRemote = await remoteBranchExists(session.repoPath, session.branch);
        if (hasRemote) {
          if (!dryRun) await deleteRemoteBranch(session.repoPath, session.branch).catch(() => {});
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
  repoId: string;
  repoAlias: string;
}

/**
 * Lists sessions eligible for `cleanupSession`, optionally restricted to
 * finished ones (the common case: "clean up everything that's done").
 */
export function listCleanupCandidates(filter?: { onlyFinished?: boolean }): CleanupCandidate[] {
  const db = getDb();
  let sql = `
    SELECT s.id as sessionId, s.ticket_id as ticketId, t.title as ticketTitle,
           s.branch, s.worktree_path as worktreePath, u.repo_path as repoPath,
           u.base_ref as baseRef, s.status, s.ended_at as endedAt,
           u.repo_id as repoId, u.repo_alias as repoAlias
    FROM sessions s JOIN tickets t ON t.id = s.ticket_id
    LEFT JOIN ticket_units u ON u.id = COALESCE(s.work_unit_id, s.ticket_id)
    WHERE 1=1
  `;
  if (filter?.onlyFinished ?? true) {
    sql += ` AND s.status IN ('completed', 'done', 'failed', 'cancelled')`;
  }
  sql += ` ORDER BY s.started_at ASC`;
  return db.prepare(sql).all() as CleanupCandidate[];
}

export { notifyCmux };
